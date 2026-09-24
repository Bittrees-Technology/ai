import type { PrivateRelayClient } from "../../modules/remote/private-relay-client.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PrivateRelayCustody,
  type PrivateRelaySecretEntries,
} from "../../modules/remote/private-relay-custody.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Owner, Store } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), permissionId: z.uuid() }),
  z.strictObject({
    action: z.enum(["stop", "reconcile", "revoke", "remove"]),
    id: z.uuid(),
    expectedRevision: revision,
  }),
  z.strictObject({ action: z.literal("cleanup"), after: z.uuid().nullable() }),
]);
export type RelayAction = z.infer<typeof requestSchema>["action"];
const codes = new Set([
  "DENIED",
  "CONFLICT",
  "BUSY",
  "CAPACITY",
  "INVALID_RESPONSE",
  "STORAGE_UNAVAILABLE",
  "PAIRING_REQUIRED",
  "PARENT_PENDING",
  "UNAVAILABLE",
]);
export class CompanionRelayError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
/** Authenticated local controls. No request returns credentials or sends messages. */
export class CompanionPrivateRelay {
  private custody: PrivateRelayCustody;
  private generation = 0;
  private running = false;
  private review?: {
    id: string;
    input: z.infer<typeof requestSchema>;
    expiresAt: number;
    at: number;
    mono: number;
    generation: number;
    coreReviewId?: string;
  };
  constructor(
    store: Store,
    vault: Vault,
    owner: Owner,
    entries: PrivateRelaySecretEntries,
    private remote?: RemoteClient,
    private setupEnabled = false,
    private now = Date.now,
    private monotonic = () => performance.now(),
    transport: typeof fetch = fetch,
  ) {
    this.custody = new PrivateRelayCustody(
      store,
      vault,
      owner,
      entries,
      remote ?? {
        async withPrivateRelayEnrollment() {
          throw new CompanionRelayError("PAIRING_REQUIRED");
        },
      },
      transport,
      now,
      monotonic,
    );
  }
  get busy() {
    return this.running;
  }
  status() {
    return {
      available: true,
      canSetup: !!this.remote && this.setupEnabled,
      canCheckRemote: !!this.remote,
      transportActive: false as const,
      state: this.custody.list(),
    };
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
    this.custody.invalidate();
    this.remote?.invalidatePrivateIdentity();
  }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.running) throw new CompanionRelayError("BUSY");
    this.running = true;
    try {
      return await action();
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new CompanionRelayError(
        e instanceof Error && codes.has(e.message) ? e.message : "UNAVAILABLE",
      );
    } finally {
      this.running = false;
    }
  }
  /** Native coordinator only. The parent must already hold key/peer exclusion.
   * No client, credential or live authority callback crosses a local HTTP route. */
  withTransport<T>(
    raw: unknown,
    action: (
      client: PrivateRelayClient,
      current: () => PrivateBinding | null,
      deliveryExpiresAt: number,
    ) => Promise<T>,
  ) {
    return this.exclusive(async () => {
      if (!this.setupEnabled || !this.remote) throw Error("DENIED");
      this.invalidate();
      return this.custody.withClient(raw, action);
    });
  }
  async prepare(raw: unknown) {
    return this.exclusive(async () => {
      this.invalidate();
      const input = requestSchema.parse(raw);
      const generation = this.generation,
        at = this.now(),
        mono = this.monotonic();
      if (!Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(mono))
        throw Error("DENIED");
      let permission: unknown = null,
        binding: unknown = null,
        record: unknown = null,
        coreReviewId: string | undefined;
      let expiresAt = at + 120000;
      if (input.action === "accept") {
        if (!this.setupEnabled || !this.remote) throw Error("DENIED");
        const result = await this.custody.review({ id: input.permissionId });
        permission = result.permission;
        binding = result.binding;
        coreReviewId = result.reviewId;
        expiresAt = Math.min(expiresAt, result.permission.approvalExpiresAt!);
      } else if (input.action !== "cleanup") {
        if (["reconcile", "revoke"].includes(input.action) && !this.remote)
          throw Error("PAIRING_REQUIRED");
        const row = this.custody.list().items.find((r) => r.id === input.id);
        if (!row || row.revision !== input.expectedRevision)
          throw Error("CONFLICT");
        if (
          ["deleting", "deleted"].includes(row.phase) &&
          input.action !== "remove"
        )
          throw Error("DENIED");
        record = row;
        permission = row.permission;
        binding = row.binding;
      }
      const elapsed = this.monotonic() - mono,
        currentTime = this.now();
      if (
        this.generation !== generation ||
        !Number.isSafeInteger(currentTime) ||
        currentTime < at ||
        currentTime >= expiresAt ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= 120000
      )
        throw Error("DENIED");
      const id = randomUUID();
      this.review = {
        id,
        input,
        at,
        mono,
        generation,
        expiresAt,
        coreReviewId,
      };
      return {
        id,
        action: input.action,
        expiresAt,
        permission,
        binding,
        record,
        cleanupAfter: input.action === "cleanup" ? input.after : null,
      };
    });
  }
  async confirm(raw: unknown) {
    return this.exclusive(async () => {
      const r = this.review;
      this.review = undefined;
      const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .parse(raw);
      const elapsed = r ? this.monotonic() - r.mono : NaN,
        now = this.now();
      if (
        !r ||
        r.id !== input.reviewId ||
        r.generation !== this.generation ||
        !Number.isSafeInteger(now) ||
        now < r.at ||
        now >= r.expiresAt ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= 120000
      )
        throw Error("DENIED");
      let result: unknown;
      if (r.input.action === "accept") {
        if (!this.setupEnabled || !this.remote || !r.coreReviewId)
          throw Error("DENIED");
        result = await this.custody.confirm({
          reviewId: r.coreReviewId,
          confirmed: true,
        });
      } else if (r.input.action === "cleanup") {
        result = await this.custody.cleanup({
          after: r.input.after,
          limit: 20,
          confirmed: true,
        });
      } else {
        const target = {
          id: r.input.id,
          expectedRevision: r.input.expectedRevision,
          confirmed: true,
        };
        result = await this.custody[r.input.action](target);
      }
      if (r.generation !== this.generation) throw Error("DENIED");
      return { ...this.status(), completedAction: r.input.action, result };
    });
  }
  /** Explicit global content deletion only; no startup/background cleanup. */
  clearAll() {
    return this.exclusive(async () => {
      this.invalidate();
      for (const row of this.custody.list().items)
        await this.custody.remove({
          id: row.id,
          expectedRevision: row.revision,
          confirmed: true,
        });
    });
  }
}
