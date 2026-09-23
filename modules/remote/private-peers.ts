import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  inspectPrivateInvitation,
  privateInvitationTime,
  privateBindingSchema,
  type PrivateBinding,
  type PrivateInvitation,
} from "./private-peer-contracts.js";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
import {
  privatePeerStateSchema as stateSchema,
  type PrivatePeerState as State,
} from "./private-peer-state.js";
type Snapshot = {
  revision: number;
  anchor: string;
  locked: boolean;
  state: State | null;
};
const purpose = (owner: Owner) =>
  JSON.stringify(["private-peers:v1", owner.tenantId, owner.userId]);
export class PrivatePeerError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "REPAIR_REQUIRED"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
function read(store: Store, vault: Vault, owner: Owner): Snapshot {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,anchor,locked,payload FROM private_peer_states WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as
      | {
          revision: number;
          anchor: string;
          locked: number;
          payload: Buffer | null;
        }
      | undefined;
    if (!row) return { revision: 0, anchor: "", locked: false, state: null };
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision <= 0 ||
      ![0, 1].includes(row.locked) ||
      !hex.safeParse(row.anchor).success ||
      (row.payload && row.payload.length > 262144)
    )
      throw Error();
    return {
      revision: row.revision,
      anchor: row.anchor,
      locked: row.locked === 1,
      state: row.payload
        ? stateSchema.parse(vault.open(row.payload, purpose(owner)))
        : null,
    };
  } catch {
    throw new PrivatePeerError("STORAGE_UNAVAILABLE");
  }
}
/** Owner-scoped content export, without granting trust or exposing internal anchor hashes. */
export function exportPrivatePeers(store: Store, vault: Vault, owner: Owner) {
  const value = read(store, vault, owner);
  return {
    revision: value.revision,
    needsFreshPairing: value.locked,
    state: value.state,
  };
}
type Review = {
  id: string;
  revision: number;
  binding: PrivateBinding;
  invitation: PrivateInvitation;
  fingerprint: string;
  keyHash: string;
  expiresAt: number;
};
export type PrivatePeerProof = {
  revision: number;
  binding: PrivateBinding;
  peerId: string;
  keyEpoch: number;
  fingerprint: string;
};
/** Internal local authority boundary. current() must read trusted current pairing state, never caller/envelope identity.
 * No network, private key storage, HTTP route or task dispatch. UI must compare the full fingerprint out of band.
 */
export class PrivatePeerEnrollment {
  private reviews = new Map<string, Review>();
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private current: () => PrivateBinding | null,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  private binding() {
    const result = privateBindingSchema.safeParse(this.current());
    if (!result.success || result.data.expiresAt <= this.now())
      throw new PrivatePeerError("DENIED");
    return result.data;
  }
  private anchor(binding: PrivateBinding) {
    return this.vault.fingerprint([
      "private-peer-anchor:v1",
      this.owner,
      binding.deviceId,
    ]);
  }
  private snapshot(binding: PrivateBinding) {
    const snap = read(this.store, this.vault, this.owner);
    if (snap.locked) throw new PrivatePeerError("REPAIR_REQUIRED");
    if (
      snap.state &&
      JSON.stringify(snap.state.binding) !== JSON.stringify(binding)
    )
      throw new PrivatePeerError("CONFLICT");
    return snap;
  }
  private unchanged(binding: PrivateBinding, revision: number) {
    if (
      JSON.stringify(this.binding()) !== JSON.stringify(binding) ||
      this.snapshot(binding).revision !== revision
    )
      throw new PrivatePeerError("CONFLICT");
  }
  private persist(
    previous: Snapshot,
    binding: PrivateBinding,
    state: State,
    unlock = false,
  ) {
    stateSchema.parse(state);
    if (previous.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivatePeerError("CAPACITY");
    const payload = this.vault.seal(state, purpose(this.owner));
    if (payload.length > 262144) throw new PrivatePeerError("CAPACITY");
    this.store.db
      .prepare(
        "INSERT INTO private_peer_states(user_id,tenant_id,revision,anchor,locked,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET revision=excluded.revision,anchor=excluded.anchor,locked=excluded.locked,payload=excluded.payload",
      )
      .run(
        this.owner.userId,
        this.owner.tenantId,
        previous.revision + 1,
        this.anchor(binding),
        previous.locked && !unlock ? 1 : 0,
        payload,
      );
    return previous.revision + 1;
  }
  private allowed(snap: Snapshot, i: PrivateInvitation, keyHash: string) {
    const state = snap.state;
    const old = state?.peers.find((p) => p.peerId === i.peerId);
    if (
      state?.retired.some((p) => p.keyHash === keyHash) ||
      state?.peers.some((p) => p.keyHash === keyHash) ||
      i.keyEpoch <=
        Math.max(
          old?.keyEpoch ?? 0,
          ...(state?.retired
            .filter((p) => p.peerId === i.peerId)
            .map((p) => p.keyEpoch) ?? []),
        )
    )
      throw new PrivatePeerError("DENIED");
    if (
      (!old && (state?.peers.length ?? 0) >= 20) ||
      (old && (state?.retired.length ?? 0) >= 512)
    )
      throw new PrivatePeerError("CAPACITY");
  }
  async prepare(raw: unknown) {
    const binding = this.binding(),
      before = this.snapshot(binding);
    let inspected: Awaited<ReturnType<typeof inspectPrivateInvitation>>;
    try {
      inspected = await inspectPrivateInvitation(raw, this.now());
    } catch {
      throw new PrivatePeerError("DENIED");
    }
    this.unchanged(binding, before.revision);
    const i = inspected.invitation;
    if (
      !privateInvitationTime(i, this.now()) ||
      i.ownerId !== binding.ownerId ||
      i.recipientId !== binding.deviceId
    )
      throw new PrivatePeerError("DENIED");
    this.allowed(before, i, inspected.keyHash);
    for (const [id, r] of this.reviews)
      if (r.expiresAt <= this.now()) this.reviews.delete(id);
    if (this.reviews.size >= 4) throw new PrivatePeerError("CAPACITY");
    const review: Review = {
      id: randomUUID(),
      revision: before.revision,
      binding,
      invitation: i,
      fingerprint: inspected.fingerprint,
      keyHash: inspected.keyHash,
      expiresAt: Math.min(i.expiresAt, binding.expiresAt, this.now() + 300000),
    };
    this.reviews.set(review.id, review);
    return structuredClone({
      reviewId: review.id,
      expectedRevision: review.revision,
      fingerprint: review.fingerprint,
      invitation: i,
      expiresAt: review.expiresAt,
      replaces: before.state?.peers.find((p) => p.peerId === i.peerId) ?? null,
    });
  }
  approve(raw: unknown) {
    const input = z
      .strictObject({
        reviewId: z.uuid(),
        expectedRevision: z.number().int().nonnegative(),
        comparedFingerprint: hex,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!input.success) throw new PrivatePeerError("DENIED");
    const r = this.reviews.get(input.data.reviewId);
    this.reviews.delete(input.data.reviewId);
    if (
      !r ||
      r.expiresAt <= this.now() ||
      r.fingerprint !== input.data.comparedFingerprint ||
      r.revision !== input.data.expectedRevision
    )
      throw new PrivatePeerError("DENIED");
    return this.store.db
      .transaction(() => {
        if (
          r.expiresAt <= this.now() ||
          !privateInvitationTime(r.invitation, this.now())
        )
          throw new PrivatePeerError("DENIED");
        this.unchanged(r.binding, r.revision);
        const snap = this.snapshot(r.binding),
          i = r.invitation;
        this.allowed(snap, i, r.keyHash);
        const state = snap.state ?? {
          binding: r.binding,
          peers: [],
          retired: [],
        };
        const old = state.peers.find((p) => p.peerId === i.peerId);
        if (old)
          state.retired.push({
            peerId: old.peerId,
            keyEpoch: old.keyEpoch,
            keyHash: old.keyHash,
          });
        state.peers = state.peers.filter((p) => p.peerId !== i.peerId);
        state.peers.push({
          peerId: i.peerId,
          keyEpoch: i.keyEpoch,
          publicKey: i.publicKey,
          keyHash: r.keyHash,
          fingerprint: r.fingerprint,
          approvedAt: this.now(),
          revoked: false,
        });
        return {
          revision: this.persist(snap, r.binding, state),
          peerId: i.peerId,
          keyEpoch: i.keyEpoch,
          fingerprint: r.fingerprint,
        };
      })
      .immediate();
  }
  list() {
    const binding = this.binding(),
      snap = this.snapshot(binding);
    return {
      revision: snap.revision,
      peers:
        snap.state?.peers.map((p) => ({
          peerId: p.peerId,
          keyEpoch: p.keyEpoch,
          fingerprint: p.fingerprint,
          revoked: p.revoked,
        })) ?? [],
    };
  }
  revoke(raw: unknown) {
    const input = z
      .strictObject({
        peerId: z.uuid(),
        expectedRevision: positive,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!input.success) throw new PrivatePeerError("DENIED");
    return this.store.db
      .transaction(() => {
        const snap = read(this.store, this.vault, this.owner);
        if (snap.revision !== input.data.expectedRevision)
          throw new PrivatePeerError("CONFLICT");
        const pin = snap.state?.peers.find(
          (p) => p.peerId === input.data.peerId,
        );
        if (!pin || !snap.state) throw new PrivatePeerError("DENIED");
        pin.revoked = true;
        this.reviews.clear();
        return { revision: this.persist(snap, snap.state.binding, snap.state) };
      })
      .immediate();
  }
  /** Reset after ordinary binding change; after restore/delete, a different local device ID is mandatory. */
  reset(raw: unknown) {
    const input = z
      .strictObject({
        expectedRevision: z.number().int().nonnegative(),
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!input.success) throw new PrivatePeerError("DENIED");
    return this.store.db
      .transaction(() => {
        const binding = this.binding(),
          snap = read(this.store, this.vault, this.owner);
        if (snap.revision !== input.data.expectedRevision)
          throw new PrivatePeerError("CONFLICT");
        if (snap.locked && snap.anchor === this.anchor(binding))
          throw new PrivatePeerError("REPAIR_REQUIRED");
        const retired = [
          ...new Map(
            [
              ...(snap.state?.retired ?? []),
              ...(snap.state?.peers.map((p) => ({
                peerId: p.peerId,
                keyEpoch: p.keyEpoch,
                keyHash: p.keyHash,
              })) ?? []),
            ].map((p) => [p.keyHash, p]),
          ).values(),
        ];
        if (retired.length > 512) throw new PrivatePeerError("CAPACITY");
        this.reviews.clear();
        return {
          revision: this.persist(
            snap,
            binding,
            {
              binding,
              peers: [],
              retired,
            },
            true,
          ),
        };
      })
      .immediate();
  }
  validate(proof: PrivatePeerProof) {
    try {
      const binding = this.binding();
      if (JSON.stringify(binding) !== JSON.stringify(proof.binding))
        return false;
      const snap = this.snapshot(binding),
        pin = snap.state?.peers.find((p) => p.peerId === proof.peerId);
      return (
        snap.revision === proof.revision &&
        !!pin &&
        !pin.revoked &&
        pin.keyEpoch === proof.keyEpoch &&
        pin.fingerprint === proof.fingerprint
      );
    } catch {
      return false;
    }
  }
  async resolve(peerId: string, keyEpoch: number) {
    const binding = this.binding(),
      snap = this.snapshot(binding),
      pin = snap.state?.peers.find((p) => p.peerId === peerId);
    if (!pin || pin.revoked || pin.keyEpoch !== keyEpoch)
      throw new PrivatePeerError("DENIED");
    const proof = {
      revision: snap.revision,
      binding,
      peerId,
      keyEpoch,
      fingerprint: pin.fingerprint,
    };
    let publicKey: CryptoKey;
    try {
      publicKey = await crypto.subtle.importKey(
        "raw",
        Buffer.from(pin.publicKey, "base64url"),
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
    } catch {
      throw new PrivatePeerError("STORAGE_UNAVAILABLE");
    }
    if (!this.validate(proof)) throw new PrivatePeerError("CONFLICT");
    return { publicKey, proof: structuredClone(proof) };
  }
}
