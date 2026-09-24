import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrivateKeyEntries } from "./private-endpoint-keys.js";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  privateRelayGrantSchema,
  privateRelayAcceptanceSchema,
  type PrivateRelayGrant,
  type PrivateRelayEnrollment,
  type PrivateRelayEnrollmentScope,
} from "./private-relay-enrollment.js";
import { PrivateRelayClient } from "./private-relay-client.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownerSchema = z.strictObject({
  userId: z.string().min(1).max(256),
  tenantId: z.string().min(1).max(256),
});
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const payloadSchema = z
  .strictObject({
    binding: privateBindingSchema,
    grant: privateRelayGrantSchema,
    secretHash: hashSchema.nullable(),
  })
  .refine(
    (p) =>
      p.grant.endpointKind === "mac" &&
      p.grant.ownerId === p.binding.ownerId &&
      p.grant.endpointId === p.binding.deviceId &&
      p.grant.credentialEpoch === p.binding.credentialEpoch &&
      p.grant.expiresAt <= p.binding.expiresAt,
  );
const phaseSchema = z.enum([
  "accepting",
  "storing",
  "active",
  "stopped",
  "deleting",
  "deleted",
]);
const secretSchema = z.strictObject({
  version: z.literal(1),
  slotId: z.uuid(),
  localOwner: ownerSchema,
  permissionId: z.uuid(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const targetSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: positive,
  confirmed: z.literal(true),
});
type Payload = z.infer<typeof payloadSchema>;
type Row = {
  id: string;
  revision: number;
  locked: boolean;
  phase: z.infer<typeof phaseSchema>;
  payload: Payload | null;
};
export interface PrivateRelaySecretEntries {
  forSlot(owner: Owner, id: string): PrivateKeyEntries;
}
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-relay-custody:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function read(store: Store, vault: Vault, owner: Owner, id: string): Row {
  try {
    const row = store.db
      .prepare(
        "SELECT id,revision,locked,phase,payload FROM private_relay_credentials WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as any;
    if (
      !row ||
      !positive.safeParse(row.revision).success ||
      ![0, 1].includes(row.locked) ||
      !phaseSchema.safeParse(row.phase).success ||
      (row.payload && row.payload.length > 8192)
    )
      throw Error();
    const payload = row.payload
      ? payloadSchema.parse(vault.open(row.payload, purpose(owner, id)))
      : null;
    if (
      (!payload && !["deleting", "deleted"].includes(row.phase)) ||
      (payload &&
        ["accepting", "storing", "active"].includes(row.phase) &&
        payload.grant.state !==
          (row.phase === "accepting" ? "pending" : "active")) ||
      (payload &&
        ["storing", "active"].includes(row.phase) &&
        !payload.secretHash)
    )
      throw Error();
    return {
      id: row.id,
      revision: row.revision,
      locked: row.locked === 1,
      phase: row.phase,
      payload,
    };
  } catch {
    throw Error("STORAGE_UNAVAILABLE");
  }
}
function write(store: Store, vault: Vault, owner: Owner, row: Row) {
  if (row.revision >= Number.MAX_SAFE_INTEGER) throw Error("CAPACITY");
  const payload = row.payload
    ? vault.seal(payloadSchema.parse(row.payload), purpose(owner, row.id))
    : null;
  if (payload && payload.length > 8192) throw Error("CAPACITY");
  const result = store.db
    .prepare(
      "UPDATE private_relay_credentials SET revision=revision+1,locked=?,phase=?,payload=? WHERE user_id=? AND tenant_id=? AND id=? AND revision=?",
    )
    .run(
      row.locked ? 1 : 0,
      row.phase,
      payload,
      owner.userId,
      owner.tenantId,
      row.id,
      row.revision,
    );
  if (result.changes !== 1) throw Error("CONFLICT");
  return row.revision + 1;
}
/** Delete content and fence all late callbacks inside the caller's deletion transaction.
 * Opaque slot/permission fingerprints remain for replay fencing and native cleanup. */
export function queuePrivateRelayDeletion(store: Store, owner: Owner) {
  store.db
    .prepare(
      "UPDATE private_relay_credentials SET locked=1,phase='deleting',payload=NULL,revision=CASE WHEN revision<9007199254740991 THEN revision+1 ELSE revision END WHERE user_id=? AND tenant_id=? AND phase<>'deleted'",
    )
    .run(owner.userId, owner.tenantId);
}
export function exportPrivateRelayCredentials(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const ids = store.db
    .prepare(
      "SELECT id FROM private_relay_credentials WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 1001",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (ids.length > 1000) throw Error("CAPACITY");
  return {
    version: 1,
    restoreAuthority: false,
    items: ids.map(({ id }) => {
      const r = read(store, vault, owner, id);
      return {
        id,
        revision: r.revision,
        locked: r.locked,
        phase: r.phase,
        binding: r.payload?.binding ?? null,
        permission: r.payload?.grant ?? null,
      };
    }),
  };
}
/** Inactive native custody journal. Grant metadata is encrypted in SQLite;
 * credentials exist only in separate OS slots. No constructor I/O, UI or polling. */
export class PrivateRelayCustody {
  private owner: Owner;
  private busy = false;
  private generation = 0;
  private client: PrivateRelayClient | null = null;
  private reviewState: {
    id: string;
    grant: PrivateRelayGrant;
    binding: PrivateBinding;
    generation: number;
    at: number;
    mono: number;
  } | null = null;
  constructor(
    private store: Store,
    private vault: Vault,
    owner: Owner,
    private entries: PrivateRelaySecretEntries,
    private enrollment: PrivateRelayEnrollment,
    private transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {
    this.owner = ownerSchema.parse(owner);
  }
  invalidate() {
    this.generation++;
    this.reviewState = null;
    this.client?.invalidate();
  }
  list() {
    return exportPrivateRelayCredentials(this.store, this.vault, this.owner);
  }
  private tx<T>(fn: () => T): T {
    return this.store.db.transaction(fn).immediate();
  }
  private get(id: string) {
    return read(this.store, this.vault, this.owner, id);
  }
  private exact(id: string, revision: number) {
    const r = this.get(id);
    if (r.revision !== revision) throw Error("CONFLICT");
    return r;
  }
  private current(
    scope: PrivateRelayEnrollmentScope,
    binding?: PrivateBinding,
  ) {
    const b = privateBindingSchema.safeParse(scope.current());
    const now = this.now();
    if (
      !b.success ||
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      b.data.expiresAt <= now ||
      (binding && !same(b.data, binding))
    )
      throw Error("DENIED");
    return b.data;
  }
  private matching(grant: PrivateRelayGrant, binding: PrivateBinding) {
    if (
      grant.ownerId !== binding.ownerId ||
      grant.endpointId !== binding.deviceId ||
      grant.endpointKind !== "mac" ||
      grant.credentialEpoch !== binding.credentialEpoch ||
      grant.expiresAt > binding.expiresAt
    )
      throw Error("DENIED");
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async review(raw: unknown) {
    const { id } = z.strictObject({ id: z.uuid() }).parse(raw);
    return this.exclusive(async () =>
      this.enrollment.withPrivateRelayEnrollment(async (scope) => {
        const generation = this.generation,
          binding = this.current(scope),
          grant = privateRelayGrantSchema.parse(await scope.inspect(id));
        this.current(scope, binding);
        this.matching(grant, binding);
        if (
          generation !== this.generation ||
          grant.id !== id ||
          grant.state !== "pending" ||
          grant.createdAt > this.now() ||
          !grant.approvalExpiresAt ||
          grant.approvalExpiresAt <= this.now()
        )
          throw Error("DENIED");
        this.reviewState = {
          id: randomUUID(),
          grant,
          binding,
          generation,
          at: this.now(),
          mono: this.monotonic(),
        };
        return {
          reviewId: this.reviewState.id,
          binding: structuredClone(binding),
          permission: structuredClone(grant),
        };
      }),
    );
  }
  async confirm(raw: unknown) {
    const input = z
      .strictObject({ reviewId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.exclusive(async () => {
      const review = this.reviewState;
      this.reviewState = null;
      const checkReview = () => {
        const elapsed = this.monotonic() - review!.mono;
        if (
          !review ||
          review.id !== input.reviewId ||
          review.generation !== this.generation ||
          !Number.isSafeInteger(this.now()) ||
          this.now() < review.at ||
          this.now() >=
            Math.min(review.at + 120000, review.grant.approvalExpiresAt!) ||
          !Number.isFinite(elapsed) ||
          elapsed < 0 ||
          elapsed >= 120000
        )
          throw Error("DENIED");
      };
      if (!review) throw Error("DENIED");
      checkReview();
      let slotId: string | undefined;
      try {
        return await this.enrollment.withPrivateRelayEnrollment(
          async (scope) => {
            this.current(scope, review.binding);
            const grant = privateRelayGrantSchema.parse(
              await scope.inspect(review.grant.id),
            );
            checkReview();
            this.current(scope, review.binding);
            if (!same(grant, review.grant)) throw Error("CONFLICT");
            const id = randomUUID();
            slotId = id;
            this.tx(() => {
              checkReview();
              this.current(scope, review.binding);
              const count = this.store.db
                .prepare(
                  "SELECT count(*) AS n FROM private_relay_credentials WHERE user_id=? AND tenant_id=?",
                )
                .get(this.owner.userId, this.owner.tenantId) as { n: number };
              if (count.n >= 1000) throw Error("CAPACITY");
              const pending = this.store.db
                .prepare(
                  "SELECT 1 FROM private_relay_credentials WHERE user_id=? AND tenant_id=? AND locked=0 AND phase IN ('accepting','storing','active')",
                )
                .get(this.owner.userId, this.owner.tenantId);
              if (pending) throw Error("CONFLICT");
              const fingerprint = this.vault.fingerprint([
                "private-relay-permission:v1",
                this.owner,
                grant.id,
              ]);
              if (
                this.store.db
                  .prepare(
                    "SELECT 1 FROM private_relay_credentials WHERE user_id=? AND tenant_id=? AND grant_hash=?",
                  )
                  .get(this.owner.userId, this.owner.tenantId, fingerprint)
              )
                throw Error("CONFLICT");
              this.store.db
                .prepare(
                  "INSERT INTO private_relay_credentials(id,user_id,tenant_id,revision,locked,phase,grant_hash,payload) VALUES(?,?,?,1,0,'accepting',?,?)",
                )
                .run(
                  id,
                  this.owner.userId,
                  this.owner.tenantId,
                  fingerprint,
                  this.vault.seal(
                    { binding: review.binding, grant, secretHash: null },
                    purpose(this.owner, id),
                  ),
                );
            });
            const attempt = this.entries.forSlot(this.owner, id);
            if (
              (await attempt.deleted.getSecret()) ||
              !(await attempt.attempt.addSecretIfAbsent(
                Buffer.from(
                  JSON.stringify({
                    version: 1,
                    slotId: id,
                    permissionId: grant.id,
                  }),
                ),
              ))
            )
              throw Error("CONFLICT");
            checkReview();
            this.current(scope, review.binding);
            this.exact(id, 1);
            const accepted = privateRelayAcceptanceSchema.parse(
              await scope.accept({
                id: grant.id,
                expectedRevision: grant.revision,
                confirmed: true,
              }),
            );
            checkReview();
            this.current(scope, review.binding);
            const expected = {
              ...grant,
              state: "active",
              revision: grant.revision + 1,
              approvalExpiresAt: null,
            };
            if (!same(accepted.grant, expected))
              throw Error("INVALID_RESPONSE");
            const entry = secretSchema.parse({
              version: 1,
              slotId: id,
              localOwner: this.owner,
              permissionId: grant.id,
              credential: accepted.credential,
            });
            const bytes = Buffer.from(JSON.stringify(entry));
            const storing = this.tx(() => {
              checkReview();
              this.current(scope, review.binding);
              const r = this.exact(id, 1);
              if (r.locked || r.phase !== "accepting") throw Error("CONFLICT");
              r.phase = "storing";
              r.payload = {
                binding: review.binding,
                grant: accepted.grant,
                secretHash: this.vault.fingerprint(entry),
              };
              return write(this.store, this.vault, this.owner, r);
            });
            const slots = this.entries.forSlot(this.owner, id);
            const secret = slots.key;
            try {
              if (await slots.deleted.getSecret()) throw Error("DENIED");
              if (!(await secret.addSecretIfAbsent(bytes)))
                throw Error("CONFLICT");
              const saved = await secret.getSecret();
              try {
                if (
                  !saved ||
                  !bytes.equals(Buffer.from(saved)) ||
                  (await slots.deleted.getSecret())
                )
                  throw Error("STORAGE_UNAVAILABLE");
              } finally {
                saved?.fill(0);
              }
            } catch {
              throw Error("STORAGE_UNAVAILABLE");
            } finally {
              bytes.fill(0);
            }
            return this.tx(() => {
              checkReview();
              this.current(scope, review.binding);
              const r = this.exact(id, storing);
              if (r.locked || r.phase !== "storing") throw Error("CONFLICT");
              r.phase = "active";
              const revision = write(this.store, this.vault, this.owner, r);
              return {
                id,
                revision,
                permission: r.payload!.grant,
                active: true,
              };
            });
          },
        );
      } catch (e) {
        if (slotId) {
          try {
            const r = this.get(slotId);
            if (r.locked || r.phase === "deleting" || r.phase === "deleted")
              await this.erase(slotId);
          } catch {
            /* Journal remains fenced for explicit reconciliation/cleanup. */
          }
        }
        throw e;
      }
    });
  }
  private async secret(row: Row) {
    let bytes: Uint8Array | undefined;
    try {
      const slots = this.entries.forSlot(this.owner, row.id);
      if (await slots.deleted.getSecret()) throw Error();
      bytes = await slots.key.getSecret();
      if (!bytes || bytes.length > 4096) throw Error();
      const s = secretSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        s.slotId !== row.id ||
        !same(s.localOwner, this.owner) ||
        s.permissionId !== row.payload?.grant.id ||
        this.vault.fingerprint(s) !== row.payload.secretHash ||
        (await slots.deleted.getSecret())
      )
        throw Error();
      return s.credential;
    } catch {
      throw Error("STORAGE_UNAVAILABLE");
    } finally {
      bytes?.fill(0);
    }
  }
  private progression(before: PrivateRelayGrant, after: PrivateRelayGrant) {
    const immutable = (g: PrivateRelayGrant) => [
      g.id,
      g.ownerId,
      g.endpointKind,
      g.endpointId,
      g.credentialEpoch,
      g.operationId,
      g.createdAt,
      g.expiresAt,
    ];
    if (
      !same(immutable(before), immutable(after)) ||
      after.revision < before.revision ||
      (after.revision === before.revision && !same(before, after)) ||
      (before.state === "revoked" && !same(before, after)) ||
      (before.state === "active" && after.state === "pending")
    )
      throw Error("INVALID_RESPONSE");
  }
  stop(raw: unknown) {
    const input = targetSchema.parse(raw);
    const result = this.tx(() => {
      const r = this.exact(input.id, input.expectedRevision);
      if (["deleting", "deleted"].includes(r.phase)) throw Error("DENIED");
      r.locked = true;
      r.phase = "stopped";
      return {
        id: r.id,
        revision: write(this.store, this.vault, this.owner, r),
        stoppedLocally: true,
        remoteRevocationConfirmed: false,
      };
    });
    this.invalidate();
    return result;
  }
  async reconcile(raw: unknown) {
    const input = targetSchema.parse(raw);
    return this.exclusive(async () =>
      this.enrollment.withPrivateRelayEnrollment(async (scope) => {
        const before = this.exact(input.id, input.expectedRevision);
        if (!before.payload) throw Error("DENIED");
        this.current(scope, before.payload.binding);
        const grant = privateRelayGrantSchema.parse(
          await scope.inspect(before.payload.grant.id),
        );
        this.matching(grant, before.payload.binding);
        this.progression(before.payload.grant, grant);
        this.current(scope, before.payload.binding);
        return this.tx(() => {
          this.current(scope, before.payload!.binding);
          const r = this.exact(before.id, before.revision);
          if (!r.payload) throw Error("CONFLICT");
          r.payload.grant = grant;
          if (
            r.phase !== "active" ||
            r.locked ||
            grant.state !== "active" ||
            grant.expiresAt <= this.now()
          ) {
            r.locked = true;
            r.phase = "stopped";
          }
          const revision = write(this.store, this.vault, this.owner, r);
          return {
            id: r.id,
            revision,
            permission: grant,
            active: r.phase === "active" && !r.locked,
            repairRequired:
              grant.state === "active" && (r.phase !== "active" || r.locked),
          };
        });
      }),
    );
  }
  async revoke(raw: unknown) {
    const input = targetSchema.parse(raw);
    const stopped = this.stop(input);
    return this.exclusive(async () =>
      this.enrollment.withPrivateRelayEnrollment(async (scope) => {
        const before = this.exact(input.id, stopped.revision);
        if (!before.payload) throw Error("DENIED");
        this.current(scope, before.payload.binding);
        let grant = privateRelayGrantSchema.parse(
          await scope.inspect(before.payload.grant.id),
        );
        this.matching(grant, before.payload.binding);
        this.progression(before.payload.grant, grant);
        if (grant.state !== "revoked") {
          if (
            grant.state !== "active" ||
            grant.expiresAt <= this.now() ||
            !same(grant, before.payload.grant)
          )
            throw Error("DENIED");
          const credential = await this.secret(before);
          this.exact(before.id, before.revision);
          this.current(scope, before.payload.binding);
          grant = privateRelayGrantSchema.parse(
            await scope.revokeRelay(credential, {
              id: grant.id,
              expectedRevision: grant.revision,
              confirmed: true,
            }),
          );
        }
        this.progression(before.payload.grant, grant);
        return this.tx(() => {
          this.current(scope, before.payload!.binding);
          const r = this.exact(before.id, before.revision);
          if (
            !r.payload ||
            grant.state !== "revoked" ||
            grant.id !== r.payload.grant.id
          )
            throw Error("CONFLICT");
          r.payload.grant = grant;
          return {
            id: r.id,
            revision: write(this.store, this.vault, this.owner, r),
            stoppedLocally: true,
            remoteRevocationConfirmed: true,
          };
        });
      }),
    );
  }
  private async erase(id: string) {
    const before = this.get(id);
    if (!before.locked || !["deleting", "deleted"].includes(before.phase))
      throw Error("DENIED");
    try {
      const slots = this.entries.forSlot(this.owner, id);
      await slots.deleted.addSecretIfAbsent(
        Buffer.from(JSON.stringify({ version: 1, slotId: id })),
      );
      if (!(await slots.deleted.getSecret())) throw Error();
      await slots.key.deleteCredential();
      const remaining = await slots.key.getSecret();
      if (remaining) {
        remaining.fill(0);
        throw Error();
      }
    } catch {
      throw Error("STORAGE_UNAVAILABLE");
    }
    this.tx(() => {
      const r = this.get(id);
      if (!r.locked || !["deleting", "deleted"].includes(r.phase))
        throw Error("CONFLICT");
      if (r.phase !== "deleted") {
        r.phase = "deleted";
        r.payload = null;
        write(this.store, this.vault, this.owner, r);
      }
    });
  }
  async remove(raw: unknown) {
    const input = targetSchema.parse(raw);
    this.tx(() => {
      const r = this.exact(input.id, input.expectedRevision);
      r.locked = true;
      r.phase = "deleting";
      r.payload = null;
      write(this.store, this.vault, this.owner, r);
    });
    this.invalidate();
    await this.erase(input.id);
    return {
      id: input.id,
      revision: this.get(input.id).revision,
      credentialAbsentObserved: true,
      remoteRevocationConfirmed: false,
    };
  }
  async cleanup(raw: unknown) {
    const input = z
      .strictObject({
        after: z.uuid().nullable(),
        limit: z.number().int().min(1).max(20),
        confirmed: z.literal(true),
      })
      .parse(raw);
    const rows = this.store.db
      .prepare(
        "SELECT id FROM private_relay_credentials WHERE user_id=? AND tenant_id=? AND phase IN ('deleting','deleted') AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
      )
      .all(
        this.owner.userId,
        this.owner.tenantId,
        input.after,
        input.after,
        input.limit + 1,
      ) as { id: string }[];
    const selected = rows.slice(0, input.limit);
    for (const r of selected) await this.erase(r.id);
    return {
      checked: selected.map((r) => r.id),
      nextCursor: rows.length > input.limit ? selected.at(-1)!.id : null,
    };
  }
  async withClient<T>(
    raw: unknown,
    action: (client: PrivateRelayClient) => Promise<T>,
  ): Promise<T> {
    const input = z
      .strictObject({ id: z.uuid(), expectedRevision: positive })
      .parse(raw);
    return this.exclusive(async () =>
      this.enrollment.withPrivateRelayEnrollment(async (scope) => {
        const generation = this.generation,
          before = this.exact(input.id, input.expectedRevision);
        if (
          before.locked ||
          before.phase !== "active" ||
          !before.payload ||
          before.payload.grant.expiresAt <= this.now()
        )
          throw Error("DENIED");
        this.current(scope, before.payload.binding);
        const credential = await this.secret(before);
        this.exact(before.id, before.revision);
        this.current(scope, before.payload.binding);
        const identity = await scope.identifyRelay(credential),
          grant = before.payload.grant;
        if (
          identity.ownerId !== grant.ownerId ||
          identity.endpointId !== grant.endpointId ||
          identity.endpointKind !== "mac" ||
          identity.credentialEpoch !== grant.credentialEpoch ||
          identity.permissionId !== grant.id ||
          identity.expiresAt !==
            Math.min(grant.expiresAt, before.payload.binding.expiresAt)
        )
          throw Error("DENIED");
        const current = () => {
          try {
            const r = this.exact(before.id, before.revision);
            this.current(scope, before.payload!.binding);
            if (
              generation !== this.generation ||
              r.locked ||
              r.phase !== "active" ||
              !same(r.payload, before.payload) ||
              identity.expiresAt <= this.now()
            )
              return null;
            return {
              kind: "mac" as const,
              scope: before.id + ":" + before.revision,
              identity,
              credential,
            };
          } catch {
            return null;
          }
        };
        if (!current()) throw Error("DENIED");
        const client = new PrivateRelayClient(
          current,
          this.transport,
          this.now,
          this.monotonic,
        );
        this.client = client;
        try {
          const result = await action(client);
          if (!current()) throw Error("DENIED");
          return result;
        } finally {
          client.invalidate();
          this.client = null;
        }
      }),
    );
  }
}
