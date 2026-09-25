import { randomUUID } from "node:crypto";
import { PrivatePeerChecks } from "./private-peer-checks.js";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import { privateBindingSchema } from "./private-peer-contracts.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
import { PrivateKeyLifecycle } from "./private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "./private-peers.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const choices = z.strictObject({
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  taskId: z.uuid(),
  taskRevision: positive,
  modelDigest: hex,
  expiresAt: positive,
});
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
    scopeHash: hex,
  })
  .refine(
    (v) =>
      v.choices.peerId === v.peer.peerId &&
      v.choices.peerKeyEpoch === v.peer.keyEpoch &&
      same(v.local.binding, v.peer.binding),
  );
const grantsSchema = z
  .array(grantSchema)
  .max(64)
  .refine(
    (v) =>
      new Set(v.map((g) => channel(g.choices))).size === v.length &&
      new Set(v.map((g) => g.id)).size === v.length,
  );
const channel = (c: z.infer<typeof choices>) =>
  JSON.stringify([c.peerId, c.taskId]);
type Grant = z.infer<typeof grantSchema>;
type Snapshot = { revision: number; needsReview: boolean; grants: Grant[] };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const purpose = (owner: Owner) =>
  JSON.stringify(["private-resume-consent:v1", owner.tenantId, owner.userId]);
export class PrivateResumeConsentError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
export function exportPrivateResumeConsent(
  store: Store,
  vault: Vault,
  owner: Owner,
): Snapshot {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,locked,payload FROM private_resume_consents WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as
      { revision: number; locked: number; payload: Buffer | null } | undefined;
    if (!row) return { revision: 0, needsReview: false, grants: [] };
    if (
      !positive.safeParse(row.revision).success ||
      ![0, 1].includes(row.locked) ||
      (row.payload && row.payload.length > 262144)
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
    throw new PrivateResumeConsentError("STORAGE_UNAVAILABLE");
  }
}
/** Internal trusted-consent boundary. Host supplies fresh verified identity and
 * actual key/peer lifecycles; no network listener, background work or implicit grant. */
export class PrivateResumeConsent {
  private review?: {
    id: string;
    revision: number;
    createdAt: number;
    expiresAt: number;
    grant: Grant;
    monotonicCreatedAt: number;
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
    private monotonic = () => performance.now(),
  ) {
    this.owner = { ...owner };
  }
  list() {
    return exportPrivateResumeConsent(this.store, this.vault, this.owner);
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  private scopeHash(c: z.infer<typeof choices>) {
    const task = this.store.get(this.owner, c.taskId);
    return this.vault.fingerprint({
      input: task.input,
      source: this.store.sourceBinding(this.owner, task.id),
      profile: this.store.profile(this.owner, task.input.modelProfileId),
    });
  }
  private valid(g: Grant) {
    try {
      return (
        !g.revoked &&
        g.approvedAt <= this.now() &&
        g.choices.expiresAt > this.now() &&
        same(this.current(), g.local.binding) &&
        g.local.binding.expiresAt > this.now() &&
        this.keys.validateReplayCoverage(g.local) &&
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
        this.scopeHash(g.choices) === g.scopeHash
      );
    } catch {
      return false;
    }
  }
  private write(before: Snapshot, grants: Grant[], locked = false) {
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateResumeConsentError("CAPACITY");
    const payload = this.vault.seal(
      grantsSchema.parse(grants),
      purpose(this.owner),
    );
    if (payload.length > 262144)
      throw new PrivateResumeConsentError("CAPACITY");
    this.store.db
      .prepare(
        "INSERT INTO private_resume_consents VALUES(?,?,?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET revision=excluded.revision,locked=excluded.locked,payload=excluded.payload",
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
    if (!parsed.success) throw new PrivateResumeConsentError("DENIED");
    const input = parsed.data,
      before = this.list(),
      now = this.now();
    if (before.revision !== input.expectedRevision)
      throw new PrivateResumeConsentError("CONFLICT");
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateResumeConsentError("CAPACITY");
    if (
      before.grants.length >= 64 &&
      !before.grants.some((g) => channel(g.choices) === channel(input.choices))
    )
      throw new PrivateResumeConsentError("CAPACITY");
    if (
      input.choices.expiresAt <= now ||
      input.choices.expiresAt > now + 86400000
    )
      throw new PrivateResumeConsentError("DENIED");
    const task = this.store.get(this.owner, input.choices.taskId);
    if (
      task.status !== "paused" ||
      task.revision !== input.choices.taskRevision
    )
      throw new PrivateResumeConsentError("CONFLICT");
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
      scopeHash: this.scopeHash(input.choices),
    });
    if (
      input.choices.expiresAt > grant.local.binding.expiresAt ||
      !this.valid(grant)
    )
      throw new PrivateResumeConsentError("DENIED");
    if (
      generation !== this.generation ||
      before.revision !== this.list().revision
    )
      throw new PrivateResumeConsentError("CONFLICT");
    const review = {
      id: randomUUID(),
      revision: before.revision,
      createdAt: now,
      expiresAt: Math.min(now + 300000, input.choices.expiresAt),
      grant,
      monotonicCreatedAt: this.monotonic(),
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
      this.now() >= r.expiresAt ||
      this.monotonic() < r.monotonicCreatedAt ||
      this.monotonic() - r.monotonicCreatedAt >= r.expiresAt - r.createdAt
    )
      throw new PrivateResumeConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== r.revision)
          throw new PrivateResumeConsentError("CONFLICT");
        if (!this.valid(r.grant) || this.now() >= r.expiresAt)
          throw new PrivateResumeConsentError("DENIED");
        // Clearing the row's restore lock must not re-enable its other old grants.
        const grants = before.grants
          .map((g) => (before.needsReview ? { ...g, revoked: true } : g))
          .filter((g) => channel(g.choices) !== channel(r.grant.choices));
        this.store.remoteResumes.approve(this.owner, {
          identity: this.identity(r.grant),
          taskId: r.grant.choices.taskId,
          taskRevision: r.grant.choices.taskRevision,
          modelDigest: r.grant.choices.modelDigest,
          expiresAt: r.grant.choices.expiresAt,
          confirmed: true,
          privatePeerBound: true,
        });
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
        permissionId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!parsed.success) throw new PrivateResumeConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== parsed.data.expectedRevision)
          throw new PrivateResumeConsentError("CONFLICT");
        const grant = before.grants.find(
          (g) => g.id === parsed.data.permissionId,
        );
        if (!grant || grant.revoked)
          throw new PrivateResumeConsentError("DENIED");
        grant.revoked = true;
        this.store.remoteResumes.revokePermission(this.owner, grant.id);
        return {
          revision: this.write(before, before.grants, before.needsReview),
        };
      })
      .immediate();
  }
  private identity(grant: Grant) {
    return {
      scope: "tasks:resume" as const,
      remoteOwnerId: grant.local.binding.ownerId,
      deviceId: grant.local.binding.deviceId,
      epoch: grant.local.binding.credentialEpoch,
      permissionId: grant.id,
    };
  }
  /** Synchronous guard for delivery commits AND every queued generation. */
  check(permissionId: string) {
    const before = this.list(),
      grant = before.grants.find((g) => g.id === permissionId);
    const retained = this.store.remoteResumes
      .history(this.owner)
      .find((p) => p.id === permissionId)?.permission;
    if (
      before.needsReview ||
      !grant ||
      !this.valid(grant) ||
      !retained ||
      retained.approval.privatePeerBound !== true ||
      !same(retained.approval.identity, this.identity(grant)) ||
      retained.approval.taskId !== grant.choices.taskId ||
      retained.approval.taskRevision !== grant.choices.taskRevision ||
      retained.approval.modelDigest !== grant.choices.modelDigest ||
      retained.approval.expiresAt !== grant.choices.expiresAt
    )
      throw new PrivateResumeConsentError("DENIED");
    return structuredClone(grant);
  }
  async resolve(permissionId: string) {
    const grant = this.check(permissionId),
      local = await this.keys.resolve(),
      peer = await this.peers.resolve(grant.peer.peerId, grant.peer.keyEpoch);
    if (!same(local.proof, grant.local) || !same(peer.proof, grant.peer))
      throw new PrivateResumeConsentError("DENIED");
    const check = () => {
      if (!same(this.check(permissionId), grant))
        throw new PrivateResumeConsentError("DENIED");
    };
    check();
    return {
      grant: structuredClone(grant),
      identity: this.identity(grant),
      localKey: { ...local.pair },
      peerPublicKey: peer.publicKey,
      check,
    };
  }
}
export { grantSchema as privateResumeGrantSchema };
