import { AsyncEntry } from "@napi-rs/keyring";
import { createHash, randomBytes } from "node:crypto";
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
});
type Saved = z.infer<typeof savedSchema>;
export class RemoteClientError extends Error {
  constructor(
    public code:
      | "BUSY"
      | "PAIRING_REQUIRED"
      | "INVALID_RESPONSE"
      | "STORAGE_UNAVAILABLE"
      | "UNAVAILABLE"
      | "DENIED"
      | "PENDING_DELIVERY"
      | "CONTROL_CONFIRMATION_REQUIRED",
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
      if (raw.length > 32768) throw Error();
      const s = savedSchema.parse(
        JSON.parse(Buffer.from(raw).toString("utf8")),
      );
      if (
        s.localOwner !== this.localOwner ||
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
      if (bytes.length > 32768) throw Error();
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
  private async post(path: string, body: unknown, credential?: string) {
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
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
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
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
      expiresAt: s.grant.expiresAt,
      state:
        s.mode !== "active"
          ? "pairing_required"
          : s.grant.expiresAt <= this.now()
            ? "expired"
            : "paired",
      pendingDelivery: !!s.pending,
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
      manageUrl: origin,
    };
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
  /** One bounded delivery pass. Constructor and status refresh never start a polling loop. */
  async pollControls() {
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
          .safeParse(await this.post("commands/poll", {}, grant.credential));
        if (
          !delivery.success ||
          delivery.data.identity.ownerId !== grant.ownerId ||
          delivery.data.identity.deviceId !== grant.deviceId ||
          delivery.data.identity.epoch !== grant.epoch ||
          delivery.data.identity.controlId !== grant.controlId ||
          delivery.data.commands.some((c) => c.deviceId !== grant.deviceId)
        )
          throw new RemoteClientError("INVALID_RESPONSE");
        const receipts: z.infer<typeof remoteReceiptSchema>[] = [];
        for (const command of delivery.data.commands) {
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
              await this.post("commands/receipt", receipt, grant.credential),
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
      if (saved) this.revokeControls(saved);
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new RemoteClientError("STORAGE_UNAVAILABLE");
      return { removedLocally: true, remoteRevocationConfirmed: false };
    });
  }
}
