import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  PrivateEndpointKeys,
  type PrivateKeyEntries,
  type PrivateKeyAuthority,
} from "./private-endpoint-keys.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slotSchema = z.strictObject({
  id: z.uuid(),
  keyEpoch: positive,
  binding: privateBindingSchema,
  createdAt: positive,
  state: z.enum(["preparing", "active", "retired", "deleting", "deleted"]),
  publicKey: z
    .string()
    .length(87)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
const stateSchema = z
  .strictObject({
    slots: z.array(slotSchema).max(20),
    pending: z.array(z.uuid()).max(20),
  })
  .refine(
    (s) =>
      new Set(s.slots.map((v) => v.id)).size === s.slots.length &&
      new Set(s.slots.map((v) => v.keyEpoch)).size === s.slots.length &&
      new Set(s.pending).size === s.pending.length &&
      s.slots.filter((v) => v.state === "active" || v.state === "preparing")
        .length <= 1 &&
      s.slots.every((v) => v.state !== "active" || !!v.publicKey) &&
      s.slots.every(
        (v) => (v.state === "deleting") === s.pending.includes(v.id),
      ),
  );
type State = z.infer<typeof stateSchema>;
type Snapshot = {
  revision: number;
  anchor: string;
  locked: boolean;
  state: State;
};
export type PrivateKeyProof = {
  revision: number;
  keyId: string;
  keyEpoch: number;
  binding: PrivateBinding;
  publicKey: string;
};
export class PrivateKeyLifecycleError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "REPAIR_REQUIRED"
      | "STORAGE_UNAVAILABLE"
      | "BUSY",
  ) {
    super(code);
  }
}
export const endpointKeyOwner = (owner: Owner) =>
  JSON.stringify([owner.tenantId, owner.userId]);
const purpose = (owner: Owner) =>
  JSON.stringify(["private-key-lifecycle:v1", owner.tenantId, owner.userId]);
function read(store: Store, vault: Vault, owner: Owner): Snapshot {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,anchor,locked,payload FROM private_key_lifecycle WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as
      | {
          revision: number;
          anchor: string;
          locked: number;
          payload: Buffer | null;
        }
      | undefined;
    if (!row)
      return {
        revision: 0,
        anchor: "",
        locked: false,
        state: { slots: [], pending: [] },
      };
    if (
      !positive.safeParse(row.revision).success ||
      !/^[a-f0-9]{64}$/.test(row.anchor) ||
      ![0, 1].includes(row.locked) ||
      (row.payload && row.payload.length > 32768)
    )
      throw Error();
    return {
      revision: row.revision,
      anchor: row.anchor,
      locked: row.locked === 1,
      state: row.payload
        ? stateSchema.parse(vault.open(row.payload, purpose(owner)))
        : { slots: [], pending: [] },
    };
  } catch {
    throw new PrivateKeyLifecycleError("STORAGE_UNAVAILABLE");
  }
}
function write(store: Store, vault: Vault, owner: Owner, s: Snapshot) {
  if (s.revision >= Number.MAX_SAFE_INTEGER)
    throw new PrivateKeyLifecycleError("CAPACITY");
  stateSchema.parse(s.state);
  const payload =
    s.state.slots.length || s.state.pending.length
      ? vault.seal(s.state, purpose(owner))
      : null;
  if (payload && payload.length > 32768)
    throw new PrivateKeyLifecycleError("CAPACITY");
  store.db
    .prepare(
      "INSERT INTO private_key_lifecycle(user_id,tenant_id,revision,anchor,locked,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET revision=excluded.revision,anchor=excluded.anchor,locked=excluded.locked,payload=excluded.payload",
    )
    .run(
      owner.userId,
      owner.tenantId,
      s.revision + 1,
      s.anchor,
      s.locked ? 1 : 0,
      payload,
    );
  return s.revision + 1;
}
/** Called inside Store.deleteAll's transaction. Locks authority, preserving only opaque
 * IDs for authorized later native cleanup. This synchronous function does not delete keys.
 */
export function queuePrivateKeyDeletion(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const s = read(store, vault, owner);
  if (!s.revision) return;
  const pending = [
    ...new Set([
      ...s.state.pending,
      ...s.state.slots.filter((v) => v.state !== "deleted").map((v) => v.id),
    ]),
  ];
  s.state = { slots: [], pending };
  s.locked = true;
  write(store, vault, owner, s);
}
export function exportPrivateKeyLifecycle(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const s = read(store, vault, owner);
  return {
    revision: s.revision,
    needsFreshPairing: s.locked,
    slots: structuredClone(s.state.slots),
    pendingKeyDeletionCount: s.state.pending.length,
  };
}
/** Internal owner-bound coordinator. Verified registration is supplied by the host;
 * stored data never supplies account authority. No network or automatic startup action.
 */
export class PrivateKeyLifecycle {
  private keys: PrivateEndpointKeys;
  private busy = false;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private current: () => PrivateBinding | null,
    entries: (id: string) => PrivateKeyEntries,
    private freshRegistration: (binding: PrivateBinding) => boolean = () =>
      false,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
    if (endpointKeyOwner(owner).length > 256)
      throw new PrivateKeyLifecycleError("DENIED");
    this.keys = new PrivateEndpointKeys(
      endpointKeyOwner(owner),
      entries,
      () => this.authority(),
      now,
    );
  }
  invalidate() {
    this.keys.invalidate();
  }
  private binding() {
    const value = privateBindingSchema.safeParse(this.current());
    if (!value.success || value.data.expiresAt <= this.now())
      throw new PrivateKeyLifecycleError("DENIED");
    return value.data;
  }
  private anchor(b: PrivateBinding) {
    return this.vault.fingerprint([
      "private-key-anchor:v1",
      this.owner,
      b.deviceId,
    ]);
  }
  private authority(): PrivateKeyAuthority | null {
    try {
      const binding = this.binding(),
        s = read(this.store, this.vault, this.owner);
      if (s.locked) return null;
      const slot = s.state.slots.find(
        (v) => v.state === "preparing" || v.state === "active",
      );
      if (!slot || JSON.stringify(slot.binding) !== JSON.stringify(binding))
        return null;
      return {
        localOwner: endpointKeyOwner(this.owner),
        binding,
        keyId: slot.id,
        keyEpoch: slot.keyEpoch,
        creationAllowed: slot.state === "preparing",
      };
    } catch {
      return null;
    }
  }
  list() {
    return exportPrivateKeyLifecycle(this.store, this.vault, this.owner);
  }
  private checked(raw: unknown) {
    const parsed = z
      .strictObject({ expectedRevision: revision, confirmed: z.literal(true) })
      .safeParse(raw);
    if (!parsed.success) throw new PrivateKeyLifecycleError("DENIED");
    return parsed.data;
  }
  private tx<T>(fn: (s: Snapshot) => T) {
    return this.store.db
      .transaction(() => fn(read(this.store, this.vault, this.owner)))
      .immediate();
  }
  private same(s: Snapshot, expected: number) {
    if (s.revision !== expected) throw new PrivateKeyLifecycleError("CONFLICT");
  }
  begin(raw: unknown) {
    const input = this.checked(raw);
    const result = this.tx((s) => {
      this.same(s, input.expectedRevision);
      const binding = this.binding();
      if (s.locked) throw new PrivateKeyLifecycleError("REPAIR_REQUIRED");
      if (s.state.pending.length)
        throw new PrivateKeyLifecycleError("CONFLICT");
      if (s.state.slots.length >= 20)
        throw new PrivateKeyLifecycleError("CAPACITY");
      const keyEpoch = Math.max(0, ...s.state.slots.map((v) => v.keyEpoch)) + 1;
      if (!Number.isSafeInteger(keyEpoch))
        throw new PrivateKeyLifecycleError("CAPACITY");
      for (const slot of s.state.slots)
        if (slot.state === "active" || slot.state === "preparing")
          slot.state = "retired";
      const slot = {
        id: randomUUID(),
        keyEpoch,
        binding,
        createdAt: this.now(),
        state: "preparing" as const,
        publicKey: null,
      };
      s.state.slots.push(slot);
      s.anchor = this.anchor(binding);
      return {
        revision: write(this.store, this.vault, this.owner, s),
        keyId: slot.id,
        keyEpoch,
      };
    });
    this.invalidate();
    return result;
  }
  reset(raw: unknown) {
    const input = this.checked(raw);
    const result = this.tx((s) => {
      this.same(s, input.expectedRevision);
      const binding = this.binding();
      if (
        !s.locked ||
        s.anchor === this.anchor(binding) ||
        !this.freshRegistration(binding)
      )
        throw new PrivateKeyLifecycleError("REPAIR_REQUIRED");
      if (s.state.pending.length)
        throw new PrivateKeyLifecycleError("CONFLICT");
      for (const slot of s.state.slots)
        if (slot.state === "active" || slot.state === "preparing")
          slot.state = "retired";
      s.locked = false;
      s.anchor = this.anchor(binding);
      return { revision: write(this.store, this.vault, this.owner, s) };
    });
    this.invalidate();
    return result;
  }
  private target(raw: unknown) {
    const p = z
      .strictObject({
        keyId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!p.success) throw new PrivateKeyLifecycleError("DENIED");
    return p.data;
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new PrivateKeyLifecycleError("BUSY");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async provision(raw: unknown) {
    return this.exclusive(async () => {
      const input = this.target(raw),
        before = read(this.store, this.vault, this.owner);
      this.same(before, input.expectedRevision);
      const a = this.authority(),
        slot = before.state.slots.find((v) => v.id === input.keyId);
      if (!a || a.keyId !== input.keyId || slot?.state !== "preparing")
        throw new PrivateKeyLifecycleError("DENIED");
      const created = await this.keys.create({
        keyId: a.keyId,
        keyEpoch: a.keyEpoch,
        confirmed: true,
      });
      return this.tx((s) => {
        this.same(s, input.expectedRevision);
        const current = this.authority(),
          v = s.state.slots.find((x) => x.id === input.keyId);
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(a) ||
          !v ||
          v.state !== "preparing" ||
          created.keyId !== v.id ||
          created.keyEpoch !== v.keyEpoch
        )
          throw new PrivateKeyLifecycleError("CONFLICT");
        v.state = "active";
        v.publicKey = created.publicKey;
        return {
          revision: write(this.store, this.vault, this.owner, s),
          keyId: v.id,
          keyEpoch: v.keyEpoch,
          publicKey: v.publicKey,
        };
      });
    });
  }
  private proof() {
    const a = this.authority(),
      s = read(this.store, this.vault, this.owner),
      slot = s.state.slots.find((v) => v.id === a?.keyId);
    if (!a || !slot || slot.state !== "active" || !slot.publicKey)
      throw new PrivateKeyLifecycleError("DENIED");
    return {
      revision: s.revision,
      keyId: slot.id,
      keyEpoch: slot.keyEpoch,
      binding: a.binding,
      publicKey: slot.publicKey,
    };
  }
  validate(proof: PrivateKeyProof) {
    try {
      return JSON.stringify(this.proof()) === JSON.stringify(proof);
    } catch {
      return false;
    }
  }
  async resolve() {
    return this.exclusive(async () => {
      const proof = this.proof(),
        key = await this.keys.resolve();
      if (
        !this.validate(proof) ||
        key.keyId !== proof.keyId ||
        key.keyEpoch !== proof.keyEpoch ||
        key.publicKey !== proof.publicKey
      )
        throw new PrivateKeyLifecycleError("CONFLICT");
      return { pair: key.pair, proof };
    });
  }
  async invitation(raw: unknown) {
    return this.exclusive(async () => {
      const proof = this.proof(),
        invitation = await this.keys.invitation(raw);
      if (
        !this.validate(proof) ||
        invitation.invitation.publicKey !== proof.publicKey
      )
        throw new PrivateKeyLifecycleError("CONFLICT");
      return invitation;
    });
  }
  revoke(raw: unknown) {
    const input = this.target(raw);
    const result = this.tx((s) => {
      this.same(s, input.expectedRevision);
      const slot = s.state.slots.find((v) => v.id === input.keyId);
      if (!slot || !["preparing", "active"].includes(slot.state))
        throw new PrivateKeyLifecycleError("DENIED");
      slot.state = "retired";
      return {
        revision: write(this.store, this.vault, this.owner, s),
        revokedLocally: true,
        remoteRevocationConfirmed: false,
      };
    });
    this.invalidate();
    return result;
  }
  private async cleanup(ids: string[]) {
    for (const id of ids) {
      // Marking was committed before this asynchronous native action; partial failure remains resumable.
      await this.keys.remove({ keyId: id, confirmed: true });
      this.tx((s) => {
        if (!s.state.pending.includes(id)) return;
        s.state.pending = s.state.pending.filter((v) => v !== id);
        const slot = s.state.slots.find((v) => v.id === id);
        if (slot) {
          slot.state = "deleted";
          slot.publicKey = null;
        }
        write(this.store, this.vault, this.owner, s);
      });
    }
  }
  async remove(raw: unknown) {
    return this.exclusive(async () => {
      const input = this.target(raw);
      this.tx((s) => {
        this.same(s, input.expectedRevision);
        const slot = s.state.slots.find((v) => v.id === input.keyId);
        if (!slot || slot.state === "deleted")
          throw new PrivateKeyLifecycleError("DENIED");
        slot.state = "deleting";
        if (!s.state.pending.includes(slot.id)) s.state.pending.push(slot.id);
        write(this.store, this.vault, this.owner, s);
      });
      this.invalidate();
      await this.cleanup([input.keyId]);
      return this.list();
    });
  }
  async cleanupPending(raw: unknown) {
    return this.exclusive(async () => {
      const input = this.checked(raw),
        s = read(this.store, this.vault, this.owner);
      this.same(s, input.expectedRevision);
      this.invalidate();
      await this.cleanup(s.state.pending);
      return this.list();
    });
  }
  async clearAll(raw: unknown) {
    return this.exclusive(async () => {
      if (
        !z.strictObject({ confirmed: z.literal(true) }).safeParse(raw).success
      )
        throw new PrivateKeyLifecycleError("DENIED");
      this.tx(() =>
        queuePrivateKeyDeletion(this.store, this.vault, this.owner),
      );
      this.invalidate();
      await this.cleanup(
        read(this.store, this.vault, this.owner).state.pending,
      );
      return this.list();
    });
  }
}
