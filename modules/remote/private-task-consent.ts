import { randomUUID } from "node:crypto";
import { PrivatePeerChecks } from "./private-peer-checks.js";
import { z } from "zod";
import { id } from "../contracts/index.js";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import { privateBindingSchema } from "./private-peer-contracts.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
import { PrivateKeyLifecycle } from "./private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "./private-peers.js";
import type { PrivateTaskAuthority } from "./private-task-receiver.js";
import type { PrivateSendAuthority } from "./private-task-outbox.js";
import type { PrivateResponseAuthority } from "./private-task-responses.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const choices = z
  .strictObject({
    peerId: z.uuid(),
    peerKeyEpoch: positive,
    receiveTasks: z.boolean(),
    sendTasks: z.boolean(),
    sendReceipts: z.boolean(),
    sendResults: z.boolean(),
    modelProfileId: id.nullable(),
    expiresAt: positive,
  })
  .refine(
    (v) =>
      (v.receiveTasks || v.sendTasks) &&
      v.receiveTasks === (v.modelProfileId !== null) &&
      (!v.sendReceipts || v.receiveTasks) &&
      (!v.sendResults || v.sendReceipts),
  );
const localProof = z.strictObject({
  revision: positive,
  keyId: z.uuid(),
  keyEpoch: positive,
  binding: privateBindingSchema,
  publicKey: z.string().length(87),
});
const peerProof = z.strictObject({
  revision: positive,
  binding: privateBindingSchema,
  peerId: z.uuid(),
  keyEpoch: positive,
  fingerprint: hex,
});
const grantSchema = z
  .strictObject({
    id: z.uuid(),
    revision: positive,
    approvedAt: positive,
    revoked: z.boolean(),
    choices,
    local: localProof,
    peer: peerProof,
    modelHash: hex.nullable(),
  })
  .refine(
    (v) =>
      v.choices.peerId === v.peer.peerId &&
      v.choices.peerKeyEpoch === v.peer.keyEpoch &&
      same(v.local.binding, v.peer.binding),
  );
const grantsSchema = z
  .array(grantSchema)
  .max(20)
  .refine((v) => new Set(v.map((g) => g.choices.peerId)).size === v.length);
type Grant = z.infer<typeof grantSchema>;
type Snapshot = { revision: number; needsReview: boolean; grants: Grant[] };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const purpose = (owner: Owner) =>
  JSON.stringify(["private-task-consent:v1", owner.tenantId, owner.userId]);
export class PrivateConsentError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
export function exportPrivateTaskConsent(
  store: Store,
  vault: Vault,
  owner: Owner,
): Snapshot {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,locked,payload FROM private_task_consents WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as
      { revision: number; locked: number; payload: Buffer | null } | undefined;
    if (!row) return { revision: 0, needsReview: false, grants: [] };
    if (
      !positive.safeParse(row.revision).success ||
      ![0, 1].includes(row.locked) ||
      (row.payload && row.payload.length > 131072)
    )
      throw Error();
    return {
      revision: row.revision,
      needsReview: row.locked === 1,
      grants: row.payload
        ? grantsSchema.parse(vault.open(row.payload, purpose(owner)))
        : [],
    };
  } catch {
    throw new PrivateConsentError("STORAGE_UNAVAILABLE");
  }
}
/** Internal trusted-consent boundary. Host supplies fresh verified identity and
 * actual key/peer lifecycles; no network listener, background work or implicit grant. */
export class PrivateTaskConsent {
  private review?: {
    id: string;
    revision: number;
    createdAt: number;
    expiresAt: number;
    grant: Grant;
  };
  private generation = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private current: () => PrivateBinding | null,
    private keys: PrivateKeyLifecycle,
    private peers: PrivatePeerEnrollment,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  list() {
    return exportPrivateTaskConsent(this.store, this.vault, this.owner);
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  private profileHash(profileId: string | null) {
    if (!profileId) return null;
    const profile = this.store.profile(this.owner, profileId);
    if (profile.runtime !== "ollama") throw new PrivateConsentError("DENIED");
    return this.vault.fingerprint([
      "private-task-model:v1",
      this.owner,
      profile,
    ]);
  }
  private valid(g: Grant) {
    try {
      return (
        !g.revoked &&
        g.approvedAt <= this.now() &&
        g.choices.expiresAt > this.now() &&
        same(this.current(), g.local.binding) &&
        g.local.binding.expiresAt > this.now() &&
        this.keys.validate(g.local) &&
        this.peers.validate(g.peer) &&
        new PrivatePeerChecks(
          this.store,
          this.vault,
          this.owner,
          this.current,
          this.keys,
          this.peers,
          this.now,
        ).validFor(g.local, g.peer) &&
        this.profileHash(g.choices.modelProfileId) === g.modelHash
      );
    } catch {
      return false;
    }
  }
  private write(before: Snapshot, grants: Grant[], locked = false) {
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateConsentError("CAPACITY");
    const payload = this.vault.seal(
      grantsSchema.parse(grants),
      purpose(this.owner),
    );
    if (payload.length > 131072) throw new PrivateConsentError("CAPACITY");
    this.store.db
      .prepare(
        "INSERT INTO private_task_consents VALUES(?,?,?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET revision=excluded.revision,locked=excluded.locked,payload=excluded.payload",
      )
      .run(
        this.owner.userId,
        this.owner.tenantId,
        before.revision + 1,
        locked ? 1 : 0,
        payload,
      );
    return before.revision + 1;
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation;
    const parsed = z
      .strictObject({ expectedRevision: revision, choices })
      .safeParse(raw);
    if (!parsed.success) throw new PrivateConsentError("DENIED");
    const input = parsed.data,
      before = this.list(),
      now = this.now();
    if (before.revision !== input.expectedRevision)
      throw new PrivateConsentError("CONFLICT");
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateConsentError("CAPACITY");
    if (
      before.grants.length >= 20 &&
      !before.grants.some((g) => g.choices.peerId === input.choices.peerId)
    )
      throw new PrivateConsentError("CAPACITY");
    if (
      input.choices.expiresAt <= now ||
      input.choices.expiresAt > now + 86400000
    )
      throw new PrivateConsentError("DENIED");
    const key = await this.keys.resolve(),
      peer = await this.peers.resolve(
        input.choices.peerId,
        input.choices.peerKeyEpoch,
      );
    const grant = grantSchema.parse({
      id: randomUUID(),
      revision: before.revision + 1,
      approvedAt: now,
      revoked: false,
      choices: input.choices,
      local: key.proof,
      peer: peer.proof,
      modelHash: this.profileHash(input.choices.modelProfileId),
    });
    if (
      input.choices.expiresAt > grant.local.binding.expiresAt ||
      !this.valid(grant)
    )
      throw new PrivateConsentError("DENIED");
    if (
      generation !== this.generation ||
      before.revision !== this.list().revision
    )
      throw new PrivateConsentError("CONFLICT");
    const review = {
      id: randomUUID(),
      revision: before.revision,
      createdAt: now,
      expiresAt: Math.min(now + 300000, input.choices.expiresAt),
      grant,
    };
    this.review = review;
    return structuredClone(review);
  }
  approve(raw: unknown) {
    const r = this.review;
    this.review = undefined;
    const parsed = z
      .strictObject({
        reviewId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
      })
      .safeParse(raw);
    if (
      !parsed.success ||
      !r ||
      parsed.data.reviewId !== r.id ||
      parsed.data.expectedRevision !== r.revision ||
      this.now() < r.createdAt ||
      this.now() >= r.expiresAt
    )
      throw new PrivateConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== r.revision)
          throw new PrivateConsentError("CONFLICT");
        if (!this.valid(r.grant) || this.now() >= r.expiresAt)
          throw new PrivateConsentError("DENIED");
        // Clearing the row's restore lock must not re-enable its other old grants.
        const grants = before.grants
          .map((g) => (before.needsReview ? { ...g, revoked: true } : g))
          .filter((g) => g.choices.peerId !== r.grant.choices.peerId);
        grants.push(r.grant);
        return {
          revision: this.write(before, grants),
          grant: structuredClone(r.grant),
        };
      })
      .immediate();
  }
  revoke(raw: unknown) {
    this.invalidate();
    const parsed = z
      .strictObject({
        peerId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!parsed.success) throw new PrivateConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== parsed.data.expectedRevision)
          throw new PrivateConsentError("CONFLICT");
        const grant = before.grants.find(
          (g) => g.choices.peerId === parsed.data.peerId,
        );
        if (!grant || grant.revoked) throw new PrivateConsentError("DENIED");
        grant.revoked = true;
        return {
          revision: this.write(before, before.grants, before.needsReview),
        };
      })
      .immediate();
  }
  /** Resolve native keys once for stable handles. Every provider call re-reads
   * current consent and proof state; pass callbacks directly to protocol modules. */
  async resolve(peerId: string) {
    const before = this.list(),
      grant = before.grants.find((g) => g.choices.peerId === peerId);
    if (before.needsReview || !grant || !this.valid(grant))
      throw new PrivateConsentError("DENIED");
    const key = await this.keys.resolve(),
      peer = await this.peers.resolve(peerId, grant.peer.keyEpoch);
    if (!same(key.proof, grant.local) || !same(peer.proof, grant.peer))
      throw new PrivateConsentError("DENIED");
    const current = () => {
      try {
        const state = this.list(),
          latest = state.grants.find((g) => g.choices.peerId === peerId);
        return !state.needsReview &&
          latest &&
          same(latest, grant) &&
          this.valid(latest)
          ? latest
          : null;
      } catch {
        return null;
      }
    };
    if (!current()) throw new PrivateConsentError("DENIED");
    return {
      receive: (target: string): PrivateTaskAuthority | null => {
        const g = current();
        return g && target === peerId && g.choices.receiveTasks
          ? {
              binding: structuredClone(g.local.binding),
              peerId,
              recipientKeyEpoch: g.local.keyEpoch,
              permissionRevision: g.revision,
              modelProfileId: g.choices.modelProfileId!,
              tasksEnabled: true,
              recipientKey: { ...key.pair },
            }
          : null;
      },
      send: (target: string): PrivateSendAuthority | null => {
        const g = current();
        return g && target === peerId && g.choices.sendTasks
          ? {
              binding: structuredClone(g.local.binding),
              peerId,
              senderKeyEpoch: g.local.keyEpoch,
              permissionRevision: g.revision,
              sendingEnabled: true,
              senderKey: { ...key.pair },
            }
          : null;
      },
      respond: (target: string): PrivateResponseAuthority | null => {
        const g = current();
        return g && target === peerId && g.choices.sendReceipts
          ? {
              binding: structuredClone(g.local.binding),
              peerId,
              senderKeyEpoch: g.local.keyEpoch,
              permissionRevision: g.revision,
              admissionRevision: g.revision,
              acceptanceEnabled: true,
              resultsEnabled: g.choices.sendResults,
              senderKey: { ...key.pair },
            }
          : null;
      },
    };
  }
}
