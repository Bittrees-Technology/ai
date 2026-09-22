import { AsyncEntry } from "@napi-rs/keyring";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ConnectorSecret } from "../connectors/crm.js";
import type { Task } from "../storage/store.js";
import { projectRemoteStatus, statusBatchSchema } from "./status.js";
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
const savedSchema = z.strictObject({
  localOwner: z.string().min(1).max(256),
  grant: grantSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["active", "rotation_pending", "pairing_required"]),
  pending: statusBatchSchema.optional(),
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
      | "PENDING_DELIVERY",
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
      manageUrl: origin,
    };
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
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new RemoteClientError("STORAGE_UNAVAILABLE");
      return { removedLocally: true, remoteRevocationConfirmed: false };
    });
  }
}
