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
import {
  conversationPermissionsSchema,
  conversationScopeSchema,
} from "./private-conversation-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const choices = z.strictObject({
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  conversationId: id,
  inboxId: id,
  permissions: conversationPermissionsSchema,
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
    conversationRef: z.uuid(),
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
      new Set(v.map((g) => g.id)).size === v.length &&
      new Set(v.map((g) => g.conversationRef)).size === v.length,
  );
const channel = (c: z.infer<typeof choices>) =>
  JSON.stringify([c.peerId, c.conversationId, c.inboxId]);
type Grant = z.infer<typeof grantSchema>;
type Snapshot = { revision: number; needsReview: boolean; grants: Grant[] };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const purpose = (owner: Owner) =>
  JSON.stringify([
    "private-conversation-consent:v1",
    owner.tenantId,
    owner.userId,
  ]);
export class PrivateConversationConsentError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
export function exportPrivateConversationConsent(
  store: Store,
  vault: Vault,
  owner: Owner,
): Snapshot {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,locked,payload FROM private_conversation_consents WHERE user_id=? AND tenant_id=?",
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
    throw new PrivateConversationConsentError("STORAGE_UNAVAILABLE");
  }
}
/** Internal trusted-consent boundary. Host supplies fresh verified identity and
 * actual key/peer lifecycles; no network listener, background work or implicit grant. */
export class PrivateConversationConsent {
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
    return exportPrivateConversationConsent(this.store, this.vault, this.owner);
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  private scopeHash(c: z.infer<typeof choices>) {
    const inbox = this.store
      .inboxes(this.owner)
      .find((i) => i.id === c.inboxId);
    if (
      !inbox ||
      inbox.tenantId !== this.owner.tenantId ||
      inbox.ownerType !== "user" ||
      inbox.ownerId !== this.owner.userId ||
      inbox.teamId !== undefined ||
      inbox.memberUserIds.length !== 1 ||
      inbox.memberUserIds[0] !== this.owner.userId
    )
      throw new PrivateConversationConsentError("DENIED");
    const conversation = this.store.db
      .prepare(
        "SELECT rowid FROM conversations WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(c.conversationId, this.owner.userId, this.owner.tenantId);
    const row = this.store.db
      .prepare(
        "SELECT definition FROM inboxes WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(c.inboxId, this.owner.userId, this.owner.tenantId) as
      { definition: Buffer } | undefined;
    if (!conversation || !row)
      throw new PrivateConversationConsentError("DENIED");
    // Bind the exact selected Inbox definition. Even an identical rewrite needs
    // fresh review; no model or task permission is consulted or inherited.
    return this.vault.fingerprint([
      "private-conversation-scope:v1",
      this.owner,
      c.conversationId,
      conversation,
      c.inboxId,
      row.definition.toString("base64"),
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
        this.scopeHash(g.choices) === g.scopeHash
      );
    } catch {
      return false;
    }
  }
  private write(before: Snapshot, grants: Grant[], locked = false) {
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateConversationConsentError("CAPACITY");
    const payload = this.vault.seal(
      grantsSchema.parse(grants),
      purpose(this.owner),
    );
    if (payload.length > 262144)
      throw new PrivateConversationConsentError("CAPACITY");
    this.store.db
      .prepare(
        "INSERT INTO private_conversation_consents VALUES(?,?,?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET revision=excluded.revision,locked=excluded.locked,payload=excluded.payload",
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
    if (!parsed.success) throw new PrivateConversationConsentError("DENIED");
    const input = parsed.data,
      before = this.list(),
      now = this.now();
    if (before.revision !== input.expectedRevision)
      throw new PrivateConversationConsentError("CONFLICT");
    if (before.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateConversationConsentError("CAPACITY");
    if (
      before.grants.length >= 64 &&
      !before.grants.some((g) => channel(g.choices) === channel(input.choices))
    )
      throw new PrivateConversationConsentError("CAPACITY");
    if (
      input.choices.expiresAt <= now ||
      input.choices.expiresAt > now + 86400000
    )
      throw new PrivateConversationConsentError("DENIED");
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
      conversationRef:
        before.grants.find((g) => channel(g.choices) === channel(input.choices))
          ?.conversationRef ?? randomUUID(),
      scopeHash: this.scopeHash(input.choices),
    });
    if (
      input.choices.expiresAt > grant.local.binding.expiresAt ||
      !this.valid(grant)
    )
      throw new PrivateConversationConsentError("DENIED");
    if (
      generation !== this.generation ||
      before.revision !== this.list().revision
    )
      throw new PrivateConversationConsentError("CONFLICT");
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
      throw new PrivateConversationConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== r.revision)
          throw new PrivateConversationConsentError("CONFLICT");
        if (!this.valid(r.grant) || this.now() >= r.expiresAt)
          throw new PrivateConversationConsentError("DENIED");
        // Clearing the row's restore lock must not re-enable its other old grants.
        const grants = before.grants
          .map((g) => (before.needsReview ? { ...g, revoked: true } : g))
          .filter((g) => channel(g.choices) !== channel(r.grant.choices));
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
    if (!parsed.success) throw new PrivateConversationConsentError("DENIED");
    return this.store.db
      .transaction(() => {
        const before = this.list();
        if (before.revision !== parsed.data.expectedRevision)
          throw new PrivateConversationConsentError("CONFLICT");
        const grant = before.grants.find(
          (g) => g.id === parsed.data.permissionId,
        );
        if (!grant || grant.revoked)
          throw new PrivateConversationConsentError("DENIED");
        grant.revoked = true;
        return {
          revision: this.write(before, before.grants, before.needsReview),
        };
      })
      .immediate();
  }
  /** Stable native handles, with fresh authority checks on every use. The
   * transport must also enforce parent/task/source authority and atomic replay. */
  async resolve(permissionId: string) {
    const before = this.list(),
      grant = before.grants.find((g) => g.id === permissionId);
    if (before.needsReview || !grant || !this.valid(grant))
      throw new PrivateConversationConsentError("DENIED");
    const key = await this.keys.resolve(),
      peer = await this.peers.resolve(grant.peer.peerId, grant.peer.keyEpoch);
    if (!same(key.proof, grant.local) || !same(peer.proof, grant.peer))
      throw new PrivateConversationConsentError("DENIED");
    const current = () => {
      try {
        const state = this.list(),
          latest = state.grants.find((g) => g.id === permissionId);
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
    if (!current()) throw new PrivateConversationConsentError("DENIED");
    return {
      access: (
        rawScope: unknown,
        direction: keyof z.infer<typeof conversationPermissionsSchema>,
      ) => {
        const scope = conversationScopeSchema.safeParse(rawScope),
          g = current();
        if (
          !scope.success ||
          !g ||
          scope.data.permissionId !== g.id ||
          scope.data.conversationRef !== g.conversationRef ||
          g.choices.permissions[direction] !== true
        )
          return null;
        return {
          grant: structuredClone(g),
          localKey: { ...key.pair },
          peerPublicKey: peer.publicKey,
        };
      },
    };
  }
}
