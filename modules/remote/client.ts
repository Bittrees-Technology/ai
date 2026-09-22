import {
  shareTemplateSchema,
  templateClientStateSchema,
  templateMetadataSchema,
  type TemplateClientState,
  type RemoteTemplateExecutor,
} from "./template-client-state.js";
import {
  templateIdentitySchema,
  templateReceiptSchema,
} from "./template-contracts.js";
import { remoteTemplateSchema } from "./status.js";
import { AsyncEntry } from "@napi-rs/keyring";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectorSecret } from "../connectors/crm.js";
import type { Store, Task } from "../storage/store.js";
import {
  remoteControlSchema,
  remoteReceiptSchema,
  projectRemoteStatus,
  statusBatchSchema,
} from "./status.js";
const origin = "https://ai.bittrees.org";
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const grantSchema = z.strictObject({
  deviceId: z.uuid(),
  ownerId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  credential: opaque,
  expiresAt: z.number().int().positive(),
  scope: z.literal("status:publish"),
});
const controlGrantSchema = grantSchema.extend({
  scope: z.literal("controls:pause-cancel"),
  controlId: z.uuid(),
});
const controlIdentitySchema = z.strictObject({
  ownerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive(),
  controlId: z.uuid(),
});
const controlStateSchema = z
  .strictObject({
    mode: z.enum(["enable_pending", "active", "disable_pending"]),
    grant: controlGrantSchema.optional(),
    receiving: z.boolean().optional(),
  })
  .refine((value) => value.mode !== "active" || !!value.grant);
export interface RemoteControlExecutor {
  allow(binding: unknown): void;
  allowed(identity: unknown): boolean;
  revoke(deviceId: string): void;
  execute(
    identity: unknown,
    command: unknown,
  ): ReturnType<Store["executeRemoteControl"]>;
  interrupt(taskId: string): void;
}
const savedSchema = z.strictObject({
  localOwner: z.string().min(1).max(256),
  grant: grantSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["active", "rotation_pending", "pairing_required"]),
  pending: statusBatchSchema.optional(),
  controls: controlStateSchema.optional(),
  templates: z
    .array(templateClientStateSchema)
    .max(20)
    .refine(
      (items) =>
        new Set(items.map((item) => item.approval.templateId)).size ===
          items.length &&
        new Set(items.map((item) => item.approval.identity.permissionId))
          .size === items.length,
    )
    .optional(),
});
type Saved = z.infer<typeof savedSchema>;
export class RemoteClientError extends Error {
  constructor(
    public code:
      | "CAPACITY"
      | "BUSY"
      | "PAIRING_REQUIRED"
      | "INVALID_RESPONSE"
      | "STORAGE_UNAVAILABLE"
      | "UNAVAILABLE"
      | "DENIED"
      | "PENDING_DELIVERY"
      | "CONTROL_CONFIRMATION_REQUIRED"
      | "TEMPLATE_CONFIRMATION_REQUIRED",
  ) {
    super(code);
  }
}
export function remoteKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("Remote credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.remote", profile);
}
/** Explicit actions only. Constructing this client never starts pairing or uploads. */
export class RemoteClient {
  private busy = false;
  private failedStorage = false;
  private pendingPair?: { id: string; verifier: string; expiresAt: number };
  constructor(
    private localOwner: string,
    private secret: ConnectorSecret,
    private transport: typeof fetch = fetch,
    private now = Date.now,
    private executor?: RemoteControlExecutor,
    private templateExecutor?: RemoteTemplateExecutor,
  ) {
    z.string().min(1).max(256).parse(localOwner);
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new RemoteClientError("BUSY");
    if (this.failedStorage) throw new RemoteClientError("STORAGE_UNAVAILABLE");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  private async saved(): Promise<Saved | undefined> {
    try {
      const raw = await this.secret.getSecret();
      if (!raw) return undefined;
      if (raw.length > 65536) throw Error();
      const s = savedSchema.parse(
        JSON.parse(Buffer.from(raw).toString("utf8")),
      );
      if (
        s.localOwner !== this.localOwner ||
        s.templates?.some(
          (t) =>
            t.approval.identity.deviceId !== s.grant.deviceId ||
            t.approval.identity.remoteOwnerId !== s.grant.ownerId ||
            t.approval.identity.epoch !== s.grant.epoch ||
            t.approval.expiresAt > s.grant.expiresAt ||
            t.credential === s.grant.credential ||
            t.approvedAt >= t.approval.expiresAt ||
            (t.pendingCommand &&
              (t.pendingCommand.deviceId !== s.grant.deviceId ||
                t.pendingCommand.templateId !== t.approval.templateId ||
                t.pendingCommand.templateRevision !==
                  t.approval.templateRevision)),
        ) ||
        (s.controls?.grant &&
          (s.controls.grant.deviceId !== s.grant.deviceId ||
            s.controls.grant.ownerId !== s.grant.ownerId ||
            s.controls.grant.epoch !== s.grant.epoch ||
            s.controls.grant.expiresAt !== s.grant.expiresAt)) ||
        (s.pending &&
          (s.pending.sequence !== s.sequence ||
            s.pending.items.some((x) => x.deviceId !== s.grant.deviceId)))
      )
        throw Error();
      return s;
    } catch {
      throw new RemoteClientError("STORAGE_UNAVAILABLE");
    }
  }
  private async save(s: Saved) {
    try {
      const bytes = Buffer.from(JSON.stringify(savedSchema.parse(s)));
      if (bytes.length > 65536) throw Error();
      await this.secret.setSecret(bytes);
      const read = await this.secret.getSecret();
      if (!read || !bytes.equals(Buffer.from(read))) throw Error();
    } catch {
      this.failedStorage = true;
      throw new RemoteClientError("STORAGE_UNAVAILABLE");
    }
  }
  private async active() {
    const s = await this.saved();
    if (!s || s.mode !== "active" || s.grant.expiresAt <= this.now())
      throw new RemoteClientError("PAIRING_REQUIRED");
    return s;
  }
  private async post(
    path: string,
    body: unknown,
    credential?: string,
    signal?: AbortSignal,
  ) {
    try {
      const response = await this.transport(origin + "/device/" + path, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(credential ? { Authorization: "Bearer " + credential } : {}),
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 429) {
        await response.body?.cancel();
        throw new RemoteClientError(
          response.status === 403 ? "DENIED" : "UNAVAILABLE",
        );
      }
      if (!response.body) throw new RemoteClientError("INVALID_RESPONSE");
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 8192) {
            await reader.cancel();
            throw new RemoteClientError("INVALID_RESPONSE");
          }
          chunks.push(r.value);
        }
      } finally {
        reader.releaseLock();
      }
      const result = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as unknown;
      if (!response.ok)
        throw new RemoteClientError(
          z.strictObject({ error: z.literal("CAPACITY") }).safeParse(result)
            .success
            ? "CAPACITY"
            : "UNAVAILABLE",
        );
      return result;
    } catch (e) {
      if (e instanceof RemoteClientError) throw e;
      throw new RemoteClientError("UNAVAILABLE");
    }
  }
  async status() {
    if (this.failedStorage) throw new RemoteClientError("STORAGE_UNAVAILABLE");
    const s = await this.saved();
    if (!s) return null;
    return {
      deviceId: s.grant.deviceId,
      ownerId: s.grant.ownerId,
      epoch: s.grant.epoch,
      expiresAt: s.grant.expiresAt,
      state:
        s.mode !== "active"
          ? "pairing_required"
          : s.grant.expiresAt <= this.now()
            ? "expired"
            : "paired",
      pendingDelivery: !!s.pending,
      backgroundReceiving: s.controls?.receiving === true,
      controls: !this.executor
        ? "unavailable"
        : !s.controls
          ? "disabled"
          : s.mode === "active" &&
              s.controls.mode === "active" &&
              s.controls.grant &&
              s.controls.grant.expiresAt > this.now() &&
              this.executor.allowed(this.controlIdentity(s.controls.grant))
            ? "enabled"
            : "confirmation_required",
      templates: (s.templates ?? []).map((t) => ({
        permissionId: t.approval.identity.permissionId,
        templateId: t.approval.templateId,
        templateRevision: t.approval.templateRevision,
        expiresAt: t.approval.expiresAt,
        maxRuns: t.approval.maxRuns,
        pendingDelivery: !!t.pendingCommand,
        backgroundReceiving: t.receiving === true,
        state:
          t.mode === "revoke_pending"
            ? "revoke_pending"
            : s.mode === "active" && this.templateExecutor?.allowed(t.approval)
              ? t.mode
              : "confirmation_required",
      })),
      manageUrl: origin,
    };
  }
  private revokeTemplates(s: Saved) {
    if (s.templates?.length && !this.templateExecutor)
      throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
    this.templateExecutor?.revoke(s.grant.deviceId);
    for (const item of s.templates ?? []) item.mode = "revoke_pending";
  }
  private async saveTemplates(s: Saved) {
    try {
      await this.save(s);
    } catch (error) {
      this.revokeTemplates(s);
      throw error;
    }
  }
  private templateEntry(s: Saved, permissionId: string) {
    const entry = s.templates?.find(
      (t) => t.approval.identity.permissionId === permissionId,
    );
    if (!entry || !this.templateExecutor)
      throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
    return entry;
  }
  async shareTemplate(raw: unknown) {
    const input = shareTemplateSchema.parse(raw);
    return this.exclusive(async () => {
      const s = await this.active();
      if (
        input.expectedConnection.ownerId !== s.grant.ownerId ||
        input.expectedConnection.deviceId !== s.grant.deviceId ||
        input.expectedConnection.epoch !== s.grant.epoch
      )
        throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      if (
        !this.templateExecutor ||
        s.templates?.some((t) => t.approval.templateId === input.templateId)
      )
        throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      if ((s.templates?.length ?? 0) >= 20)
        throw new RemoteClientError("CAPACITY");
      if (input.expiresAt > s.grant.expiresAt)
        throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      const approval = {
        identity: {
          scope: "templates:run" as const,
          remoteOwnerId: s.grant.ownerId,
          deviceId: s.grant.deviceId,
          epoch: s.grant.epoch,
          permissionId: randomUUID(),
        },
        templateId: input.templateId,
        templateRevision: input.expectedRevision,
        maxRuns: input.maxRuns,
        expiresAt: input.expiresAt,
        confirmed: true as const,
      };
      const approved = this.templateExecutor.approve(approval);
      const entry: TemplateClientState = {
        approval,
        approvedAt: approved.approvedAt,
        credential: randomBytes(32).toString("base64url"),
        mode: "publication_pending",
      };
      s.templates = [...(s.templates ?? []), entry];
      await this.saveTemplates(s);
      await this.publishTemplateEntry(s, entry);
      return this.status();
    });
  }
  private async publishTemplateEntry(s: Saved, entry: TemplateClientState) {
    if (
      entry.mode !== "publication_pending" ||
      !this.templateExecutor?.allowed(entry.approval)
    )
      throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
    const a = entry.approval;
    const expected = {
      permissionId: a.identity.permissionId,
      deviceId: a.identity.deviceId,
      templateId: a.templateId,
      templateRevision: a.templateRevision,
      approvedAt: entry.approvedAt,
      expiresAt: a.expiresAt,
      maxRuns: a.maxRuns,
    };
    const response = z
      .strictObject({
        template: templateMetadataSchema,
        duplicate: z.boolean(),
      })
      .safeParse(
        await this.post(
          "templates/publish",
          {
            permissionId: expected.permissionId,
            templateId: a.templateId,
            templateRevision: a.templateRevision,
            approvedAt: entry.approvedAt,
            expiresAt: a.expiresAt,
            maxRuns: a.maxRuns,
            credentialHash: createHash("sha256")
              .update(entry.credential)
              .digest("hex"),
            confirmed: true,
          },
          s.grant.credential,
        ),
      );
    if (
      !response.success ||
      Object.entries(expected).some(
        ([key, value]) =>
          response.data.template[key as keyof typeof expected] !== value,
      ) ||
      response.data.template.submittedRuns > a.maxRuns
    )
      throw new RemoteClientError("INVALID_RESPONSE");
    if (!this.templateExecutor.allowed(a))
      throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
    entry.mode = "active";
    await this.saveTemplates(s);
  }
  async retryTemplatePublication(permissionId: string) {
    return this.exclusive(async () => {
      const s = await this.active();
      await this.publishTemplateEntry(s, this.templateEntry(s, permissionId));
      return this.status();
    });
  }
  async revokeTemplate(permissionId: string) {
    return this.exclusive(async () => {
      const s = await this.saved();
      if (!s) throw new RemoteClientError("PAIRING_REQUIRED");
      const entry = this.templateEntry(s, permissionId);
      this.templateExecutor!.revoke(
        s.grant.deviceId,
        entry.approval.templateId,
      );
      entry.mode = "revoke_pending";
      await this.saveTemplates(s);
      const ack = z
        .strictObject({ revoked: z.literal(true) })
        .safeParse(
          await this.post(
            "templates/revoke",
            { permissionId, confirmed: true },
            s.grant.credential,
          ),
        );
      if (!ack.success) throw new RemoteClientError("INVALID_RESPONSE");
      s.templates = s.templates!.filter((t) => t !== entry);
      await this.saveTemplates(s);
      return { disabledLocally: true, remoteConfirmed: true };
    });
  }
  async setTemplateReceiving(permissionId: string, enabled: boolean) {
    return this.exclusive(async () => {
      const s = await this.saved();
      if (!s) throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      const entry = this.templateEntry(s, permissionId);
      if (
        enabled &&
        (s.mode !== "active" ||
          s.grant.expiresAt <= this.now() ||
          entry.mode !== "active" ||
          !this.templateExecutor!.allowed(entry.approval))
      )
        throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      entry.receiving = enabled;
      // A failed preference write revokes local authority before older saved opt-in can resume.
      await this.saveTemplates(s);
    });
  }
  /** Journals each opaque command before execution, so a lost acknowledgement can
   * be recovered after restart even once the relay stops offering the expired command. */
  async pollTemplate(permissionId: string, signal?: AbortSignal) {
    return this.exclusive(async () => {
      const s = await this.active(),
        entry = this.templateEntry(s, permissionId),
        a = entry.approval;
      if (entry.mode !== "active" || !this.templateExecutor!.allowed(a))
        throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
      const receipts: z.infer<typeof templateReceiptSchema>[] = [];
      const deliver = async () => {
        signal?.throwIfAborted();
        if (!this.templateExecutor!.allowed(a))
          throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
        const result = this.templateExecutor!.execute(
          a.identity,
          entry.pendingCommand!,
        );
        const receipt = templateReceiptSchema.parse(result.receipt);
        const ack = z
          .strictObject({
            receipt: templateReceiptSchema,
            duplicate: z.boolean(),
          })
          .safeParse(
            await this.post(
              "templates/receipt",
              receipt,
              entry.credential,
              signal,
            ),
          );
        if (
          !ack.success ||
          JSON.stringify(ack.data.receipt) !== JSON.stringify(receipt)
        )
          throw new RemoteClientError("INVALID_RESPONSE");
        delete entry.pendingCommand;
        await this.saveTemplates(s);
        receipts.push(receipt);
      };
      try {
        if (entry.pendingCommand) await deliver();
        signal?.throwIfAborted();
        const delivery = z
          .strictObject({
            identity: templateIdentitySchema,
            commands: z
              .array(remoteTemplateSchema)
              .max(20)
              .refine(
                (items) =>
                  new Set(items.map((c) => c.id)).size === items.length,
              ),
          })
          .safeParse(
            await this.post("templates/poll", {}, entry.credential, signal),
          );
        if (
          !delivery.success ||
          JSON.stringify(delivery.data.identity) !==
            JSON.stringify(templateIdentitySchema.parse(a.identity)) ||
          delivery.data.commands.some(
            (c) =>
              c.deviceId !== a.identity.deviceId ||
              c.templateId !== a.templateId ||
              c.templateRevision !== a.templateRevision,
          )
        )
          throw new RemoteClientError("INVALID_RESPONSE");
        signal?.throwIfAborted();
        for (const command of delivery.data.commands) {
          signal?.throwIfAborted();
          entry.pendingCommand = command;
          await this.saveTemplates(s);
          await deliver();
        }
        return { receipts };
      } catch (error) {
        if (error instanceof RemoteClientError && error.code === "DENIED") {
          this.templateExecutor!.revoke(s.grant.deviceId, a.templateId);
          entry.mode = "revoke_pending";
          await this.saveTemplates(s);
        }
        throw error;
      }
    });
  }
  private controlIdentity(grant: z.infer<typeof controlGrantSchema>) {
    return {
      remoteOwnerId: grant.ownerId,
      deviceId: grant.deviceId,
      epoch: grant.epoch,
      controlId: grant.controlId,
    };
  }
  private revokeControls(s: Saved) {
    this.executor?.revoke(s.grant.deviceId);
    if (s.controls) s.controls = { mode: "disable_pending" };
  }
  async enableControls() {
    return this.exclusive(async () => {
      if (!this.executor)
        throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
      const s = await this.active();
      if (s.controls)
        throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
      this.executor.revoke(s.grant.deviceId);
      s.controls = { mode: "enable_pending" };
      await this.save(s);
      const result = controlGrantSchema.safeParse(
        await this.post(
          "controls/enable",
          { confirmed: true },
          s.grant.credential,
        ),
      );
      if (
        !result.success ||
        result.data.ownerId !== s.grant.ownerId ||
        result.data.deviceId !== s.grant.deviceId ||
        result.data.epoch !== s.grant.epoch ||
        result.data.expiresAt !== s.grant.expiresAt ||
        result.data.expiresAt <= this.now() ||
        result.data.credential === s.grant.credential
      )
        throw new RemoteClientError("INVALID_RESPONSE");
      s.controls = { mode: "enable_pending", grant: result.data };
      await this.save(s);
      this.executor.allow({
        ...this.controlIdentity(result.data),
        expiresAt: result.data.expiresAt,
      });
      s.controls.mode = "active";
      try {
        await this.save(s);
      } catch (error) {
        this.executor.revoke(s.grant.deviceId);
        throw error;
      }
      return this.status();
    });
  }
  async disableControls() {
    return this.exclusive(async () => {
      const s = await this.saved();
      if (!s) return { disabledLocally: true, remoteConfirmed: false };
      // Local revocation precedes all network/storage work and remains effective on failure.
      this.revokeControls(s);
      s.controls = { mode: "disable_pending" };
      await this.save(s);
      const response = z
        .strictObject({ disabled: z.literal(true) })
        .safeParse(await this.post("controls/disable", {}, s.grant.credential));
      if (!response.success) throw new RemoteClientError("INVALID_RESPONSE");
      delete s.controls;
      await this.save(s);
      return { disabledLocally: true, remoteConfirmed: true };
    });
  }
  async setReceiving(enabled: boolean) {
    return this.exclusive(async () => {
      const s = await this.saved();
      if (!s) {
        if (enabled)
          throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
        return;
      }
      if (
        enabled &&
        (s.mode !== "active" ||
          s.controls?.mode !== "active" ||
          !s.controls.grant ||
          !this.executor?.allowed(this.controlIdentity(s.controls.grant)))
      )
        throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
      if (s.controls) {
        s.controls.receiving = enabled;
        try {
          await this.save(s);
        } catch (error) {
          this.executor?.revoke(s.grant.deviceId);
          throw error;
        }
      }
    });
  }
  /** One bounded delivery pass. Constructor and status refresh never start a polling loop. */
  async pollControls(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const s = await this.active(),
        grant = s.controls?.grant;
      if (
        !this.executor ||
        s.controls?.mode !== "active" ||
        !grant ||
        !this.executor.allowed(this.controlIdentity(grant))
      )
        throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
      try {
        const delivery = z
          .strictObject({
            identity: controlIdentitySchema,
            commands: z
              .array(remoteControlSchema)
              .max(20)
              .refine(
                (items) =>
                  new Set(items.map((c) => c.id)).size === items.length,
              ),
          })
          .safeParse(
            await this.post("commands/poll", {}, grant.credential, signal),
          );
        if (
          !delivery.success ||
          delivery.data.identity.ownerId !== grant.ownerId ||
          delivery.data.identity.deviceId !== grant.deviceId ||
          delivery.data.identity.epoch !== grant.epoch ||
          delivery.data.identity.controlId !== grant.controlId ||
          delivery.data.commands.some((c) => c.deviceId !== grant.deviceId)
        )
          throw new RemoteClientError("INVALID_RESPONSE");
        signal?.throwIfAborted();
        const receipts: z.infer<typeof remoteReceiptSchema>[] = [];
        for (const command of delivery.data.commands) {
          signal?.throwIfAborted();
          const result = this.executor.execute(
            this.controlIdentity(grant),
            command,
          );
          const receipt = remoteReceiptSchema.parse(result.receipt);
          if (receipt.outcome === "applied" && !result.duplicate)
            this.executor.interrupt(command.taskId);
          const ack = z
            .strictObject({ duplicate: z.boolean() })
            .safeParse(
              await this.post(
                "commands/receipt",
                receipt,
                grant.credential,
                signal,
              ),
            );
          if (!ack.success) throw new RemoteClientError("INVALID_RESPONSE");
          receipts.push(receipt);
        }
        return { receipts };
      } catch (error) {
        if (error instanceof RemoteClientError && error.code === "DENIED") {
          this.revokeControls(s);
          await this.save(s);
        }
        throw error;
      }
    });
  }
  async begin() {
    return this.exclusive(async () => {
      if (await this.saved()) throw new RemoteClientError("PAIRING_REQUIRED");
      this.pendingPair = undefined;
      const verifier = randomBytes(32).toString("base64url");
      const result = z
        .strictObject({
          id: z.uuid(),
          approvalCode: opaque,
          expiresAt: z.number().int().positive(),
        })
        .safeParse(
          await this.post("pairings", {
            challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
          }),
        );
      if (
        !result.success ||
        result.data.expiresAt <= this.now() ||
        result.data.expiresAt > this.now() + 300000
      )
        throw new RemoteClientError("INVALID_RESPONSE");
      this.pendingPair = {
        id: result.data.id,
        verifier,
        expiresAt: result.data.expiresAt,
      };
      return { ...result.data, manageUrl: origin };
    });
  }
  async finish(expectedOwnerId: string) {
    return this.exclusive(async () => {
      if (!z.uuid().safeParse(expectedOwnerId).success)
        throw new RemoteClientError("PAIRING_REQUIRED");
      const p = this.pendingPair;
      if (!p || p.expiresAt <= this.now() || (await this.saved()))
        throw new RemoteClientError("PAIRING_REQUIRED");
      // A lost redemption response is not automatically retried.
      this.pendingPair = undefined;
      const result = grantSchema.safeParse(
        await this.post("redeem", {
          id: p.id,
          verifier: p.verifier,
          expectedOwnerId,
        }),
      );
      if (
        !result.success ||
        result.data.ownerId !== expectedOwnerId ||
        result.data.epoch !== 1 ||
        result.data.expiresAt <= this.now() ||
        result.data.expiresAt > this.now() + 30 * 86400000
      )
        throw new RemoteClientError("INVALID_RESPONSE");
      await this.save({
        localOwner: this.localOwner,
        grant: result.data,
        sequence: 1,
        mode: "active",
      });
      return this.status();
    });
  }
  async publish(tasks: Task[]) {
    return this.exclusive(async () => {
      const s = await this.active();
      if (s.pending) throw new RemoteClientError("PENDING_DELIVERY");
      const batch = statusBatchSchema.safeParse({
        sequence: s.sequence,
        items: tasks.map((t) => projectRemoteStatus(t, s.grant.deviceId)),
      });
      if (!batch.success) throw new RemoteClientError("INVALID_RESPONSE");
      s.pending = batch.data;
      await this.save(s);
      return this.deliver(s);
    });
  }
  private async deliver(s: Saved) {
    if (!s.pending) throw new RemoteClientError("PENDING_DELIVERY");
    const ack = z
      .strictObject({ sequence: z.number().int(), duplicate: z.boolean() })
      .safeParse(await this.post("status", s.pending, s.grant.credential));
    if (!ack.success || ack.data.sequence !== s.sequence)
      throw new RemoteClientError("INVALID_RESPONSE");
    s.sequence++;
    delete s.pending;
    await this.save(s);
    return ack.data;
  }
  get running() {
    return this.busy;
  }
  async retryPending(validate?: (ids: string[]) => Promise<void>) {
    return this.exclusive(async () => {
      const saved = await this.active();
      if (!saved.pending) throw new RemoteClientError("PENDING_DELIVERY");
      await validate?.(saved.pending.items.map((item) => item.id));
      return this.deliver(saved);
    });
  }
  /** Clear unsent metadata under the same exclusion as publication, then delete local tasks. */
  async clearTaskData(remove: () => void) {
    return this.exclusive(async () => {
      const saved = await this.saved();
      if (saved?.templates?.length) {
        this.revokeTemplates(saved);
        await this.saveTemplates(saved);
      }
      if (saved?.controls) {
        this.revokeControls(saved);
        await this.save(saved);
      }
      if (saved?.pending) {
        delete saved.pending;
        // The relay may have accepted the batch before a lost acknowledgement.
        // Never reuse its sequence with different content after local deletion.
        saved.mode = "pairing_required";
        await this.save(saved);
      }
      remove();
    });
  }
  async rotate() {
    return this.exclusive(async () => {
      const s = await this.active();
      if (s.pending) throw new RemoteClientError("PENDING_DELIVERY");
      this.revokeTemplates(s);
      delete s.templates;
      this.revokeControls(s);
      delete s.controls;
      s.mode = "rotation_pending";
      await this.save(s);
      const rotated = grantSchema.safeParse(
        await this.post("rotate", {}, s.grant.credential),
      );
      if (
        !rotated.success ||
        rotated.data.deviceId !== s.grant.deviceId ||
        rotated.data.ownerId !== s.grant.ownerId ||
        rotated.data.epoch !== s.grant.epoch + 1 ||
        rotated.data.expiresAt !== s.grant.expiresAt ||
        rotated.data.credential === s.grant.credential
      )
        throw new RemoteClientError("INVALID_RESPONSE");
      s.grant = rotated.data;
      s.mode = "active";
      await this.save(s);
      return this.status();
    });
  }
  /** Local removal only; caller must explain that remote revocation is a separate owner action. */
  async forgetLocal() {
    return this.exclusive(async () => {
      this.pendingPair = undefined;
      const saved = await this.saved();
      if (saved) {
        this.revokeTemplates(saved);
        this.revokeControls(saved);
      }
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new RemoteClientError("STORAGE_UNAVAILABLE");
      return { removedLocally: true, remoteRevocationConfirmed: false };
    });
  }
}
