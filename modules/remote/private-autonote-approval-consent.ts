import { splitAutoNoteApproval } from "./private-autonote-approval-content.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { AutoNoteApprovalConnector } from "../connectors/autonote-approval.js";
import type { AutoNoteTasks } from "../connectors/autonote-tasks.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
import type { PrivateKeyLifecycle } from "./private-key-lifecycle.js";
import type { PrivatePeerEnrollment } from "./private-peers.js";
import { PrivatePeerChecks } from "./private-peer-checks.js";
import {
  autoNotePeerApprovalGrantSchema,
  autoNotePeerApprovalGrantsSchema,
  type AutoNotePeerApprovalGrant,
} from "./private-autonote-approval-consent-contracts.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export class AutoNotePeerApprovalError extends Error {
  constructor(readonly code: "DENIED" | "CONFLICT" | "CAPACITY") {
    super(code);
  }
}
/** Internal Mac-owned consent, distinct from source approval and other peer grants.
 * Host must use current verified identity and actual protected key/peer lifecycles. */
export class PrivateAutoNoteApprovalConsent {
  private generation = 0;
  private review?: {
    id: string;
    revision: number;
    grant: AutoNotePeerApprovalGrant;
    started: number;
    expires: number;
    mono: number;
    check: () => void;
  };
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private current: () => PrivateBinding | null,
    private keys: PrivateKeyLifecycle,
    private peers: PrivatePeerEnrollment,
    private approval: AutoNoteApprovalConnector,
    private sources: AutoNoteTasks,
    private now = Date.now,
    private mono = () => performance.now(),
  ) {
    this.owner = { ...owner };
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  list(operationId: string) {
    const item = this.store.autoNoteReview(
      this.owner,
      z.uuid().parse(operationId),
    );
    return {
      revision: item.revision,
      grants: autoNotePeerApprovalGrantsSchema.parse(
        item.approvalDelegations ?? [],
      ),
    };
  }
  private valid(g: AutoNotePeerApprovalGrant, requireSource = true) {
    try {
      const item = this.store.autoNoteReview(this.owner, g.operationId),
        task = this.store.get(this.owner, g.taskId);
      return (
        !g.revoked &&
        g.approvedAt <= this.now() &&
        g.expiresAt > this.now() &&
        (!requireSource || item.state === "prepared") &&
        task.revision === g.taskRevision &&
        item.grantId === g.grantId &&
        item.response?.reviewId === g.reviewId &&
        item.response.digest === g.proposalDigest &&
        same(this.current(), g.local.binding) &&
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
        ).validFor(g.local, g.peer)
      );
    } catch {
      return false;
    }
  }
  private async source(
    g: Pick<AutoNotePeerApprovalGrant, "operationId" | "grantId" | "reviewId">,
  ) {
    const item = this.store.autoNoteReview(this.owner, g.operationId),
      binding = this.store.sourceBinding(this.owner, item.taskId);
    if (
      !binding ||
      item.state !== "prepared" ||
      item.grantId !== g.grantId ||
      item.response?.reviewId !== g.reviewId
    )
      throw new AutoNotePeerApprovalError("DENIED");
    await this.sources.validate(binding);
    const inspected = await this.approval.inspect(g.grantId, g.reviewId);
    if (
      "receipt" in inspected.detail ||
      !same(inspected.detail.proposal, item.proposal) ||
      inspected.detail.digest !== item.response.digest ||
      inspected.detail.expiresAt !== item.response.expiresAt ||
      hash(item.proposal) !== inspected.detail.digest
    )
      throw new AutoNotePeerApprovalError("DENIED");
    return {
      ...inspected,
      detail: inspected.detail,
      detailHash: hash(inspected.detail),
    };
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation;
    const input = z
      .strictObject({
        operationId: z.uuid(),
        expectedRevision: revision,
        peerId: z.uuid(),
        peerKeyEpoch: revision,
        expiresAt: revision,
      })
      .parse(raw);
    const item = this.store.autoNoteReview(this.owner, input.operationId);
    if (
      item.revision !== input.expectedRevision ||
      !item.response ||
      item.state !== "prepared"
    )
      throw new AutoNotePeerApprovalError("CONFLICT");
    const started = this.now(),
      monotonic = this.mono();
    if (input.expiresAt <= started || input.expiresAt > started + 600000)
      throw new AutoNotePeerApprovalError("DENIED");
    const local = await this.keys.resolve(),
      peer = await this.peers.resolve(input.peerId, input.peerKeyEpoch);
    const inspected = await this.source({
      operationId: item.id,
      grantId: item.grantId,
      reviewId: item.response.reviewId,
    });
    const grant = autoNotePeerApprovalGrantSchema.parse({
      id: randomUUID(),
      scope: "autonote:approve-exact-notes",
      operationId: item.id,
      taskId: item.taskId,
      taskRevision: item.taskRevision,
      grantId: item.grantId,
      sourceApprovalId: inspected.approvalId,
      reviewId: item.response.reviewId,
      proposalDigest: item.response.digest,
      detailHash: inspected.detailHash,
      approvedAt: started,
      expiresAt: input.expiresAt,
      revoked: false,
      local: local.proof,
      peer: peer.proof,
    });
    if (
      input.expiresAt >
        Math.min(
          Date.parse(item.response.expiresAt),
          Date.parse(inspected.approvalExpiresAt),
        ) ||
      generation !== this.generation ||
      this.list(item.id).revision !== item.revision ||
      !this.valid(grant)
    )
      throw new AutoNotePeerApprovalError("DENIED");
    inspected.check();
    const expires = Math.min(started + 60000, input.expiresAt);
    if (this.now() >= expires || this.mono() - monotonic >= expires - started)
      throw new AutoNotePeerApprovalError("DENIED");
    this.review = {
      id: randomUUID(),
      revision: item.revision,
      grant,
      started,
      expires,
      mono: monotonic,
      check: inspected.check,
    };
    return {
      id: this.review.id,
      revision: item.revision,
      grant: structuredClone(grant),
      expiresAt: expires,
      title: inspected.detail.title,
      visibility: inspected.detail.visibility,
    };
  }
  async approve(raw: unknown) {
    const r = this.review;
    this.review = undefined;
    const input = z
      .strictObject({
        reviewId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
      })
      .parse(raw);
    if (!r || input.reviewId !== r.id || input.expectedRevision !== r.revision)
      throw new AutoNotePeerApprovalError("DENIED");
    const generation = this.generation;
    const guard = () => {
      r.check();
      if (
        generation !== this.generation ||
        this.now() < r.started ||
        this.now() >= r.expires ||
        this.mono() < r.mono ||
        this.mono() - r.mono >= r.expires - r.started ||
        !this.valid(r.grant)
      )
        throw new AutoNotePeerApprovalError("DENIED");
    };
    guard();
    const fresh = await this.source(r.grant);
    if (
      fresh.approvalId !== r.grant.sourceApprovalId ||
      fresh.detailHash !== r.grant.detailHash
    )
      throw new AutoNotePeerApprovalError("DENIED");
    fresh.check();
    guard();
    return this.store.db
      .transaction(() => {
        guard();
        const before = this.list(r.grant.operationId);
        if (before.revision !== r.revision)
          throw new AutoNotePeerApprovalError("CONFLICT");
        const grants = before.grants.filter(
          (g) =>
            g.peer.peerId !== r.grant.peer.peerId && g.expiresAt > this.now(),
        );
        if (grants.length >= 64)
          throw new AutoNotePeerApprovalError("CAPACITY");
        grants.push(r.grant);
        const item = this.store.setAutoNoteApprovalDelegations(
          this.owner,
          r.grant.operationId,
          r.revision,
          grants,
        );
        return { revision: item.revision, grant: structuredClone(r.grant) };
      })
      .immediate();
  }
  revoke(raw: unknown) {
    this.invalidate();
    const input = z
      .strictObject({
        operationId: z.uuid(),
        permissionId: z.uuid(),
        expectedRevision: revision,
        confirmed: z.literal(true),
      })
      .parse(raw);
    const before = this.list(input.operationId);
    if (before.revision !== input.expectedRevision)
      throw new AutoNotePeerApprovalError("CONFLICT");
    const grant = before.grants.find((g) => g.id === input.permissionId);
    if (!grant) throw new AutoNotePeerApprovalError("DENIED");
    grant.revoked = true;
    return {
      revision: this.store.setAutoNoteApprovalDelegations(
        this.owner,
        input.operationId,
        before.revision,
        before.grants,
      ).revision,
    };
  }
  /** Internal plaintext preparation; caller must retain once before encryption/upload. */
  async frameOffer(operationId: string, permissionId: string, offerId: string) {
    z.uuid().parse(offerId);
    const handle = await this.resolve(operationId, permissionId),
      grant = handle.grant;
    const transfer = await splitAutoNoteApproval(
      handle.detail,
      {
        offerId,
        permissionId: grant.id,
        sourceApprovalId: grant.sourceApprovalId,
        grantId: grant.grantId,
        issuedAt: this.now(),
        expiresAt: grant.expiresAt,
      },
      this.now,
    );
    handle.check();
    if (transfer.manifest.detailHash !== grant.detailHash)
      throw new AutoNotePeerApprovalError("DENIED");
    return { grant, ...transfer };
  }
  /** Peer authentication for retained decisions/results only; never source-write authority. */
  async resolvePeer(operationId: string, permissionId: string) {
    const grant = this.list(operationId).grants.find(
        (g) => g.id === permissionId,
      ),
      generation = this.generation;
    if (!grant || !this.valid(grant, false))
      throw new AutoNotePeerApprovalError("DENIED");
    const local = await this.keys.resolve(),
      peer = await this.peers.resolve(grant.peer.peerId, grant.peer.keyEpoch);
    const check = () => {
      const retained = this.list(operationId).grants.find(
        (g) => g.id === permissionId,
      );
      if (
        generation !== this.generation ||
        !same(retained, grant) ||
        !this.valid(grant, false) ||
        !same(local.proof, grant.local) ||
        !same(peer.proof, grant.peer)
      )
        throw new AutoNotePeerApprovalError("DENIED");
    };
    check();
    return {
      grant: structuredClone(grant),
      localKey: { ...local.pair },
      peerPublicKey: peer.publicKey,
      check,
    };
  }
  async resolve(operationId: string, permissionId: string) {
    const grant = this.list(operationId).grants.find(
      (g) => g.id === permissionId,
    );
    if (!grant || !this.valid(grant))
      throw new AutoNotePeerApprovalError("DENIED");
    const local = await this.keys.resolve(),
      peer = await this.peers.resolve(grant.peer.peerId, grant.peer.keyEpoch),
      fresh = await this.source(grant);
    const check = () => {
      fresh.check();
      const retained = this.list(operationId).grants.find(
        (g) => g.id === permissionId,
      );
      if (
        !same(retained, grant) ||
        !this.valid(grant) ||
        !same(local.proof, grant.local) ||
        !same(peer.proof, grant.peer) ||
        fresh.approvalId !== grant.sourceApprovalId ||
        fresh.detailHash !== grant.detailHash
      )
        throw new AutoNotePeerApprovalError("DENIED");
    };
    check();
    return {
      grant: structuredClone(grant),
      detail: fresh.detail,
      localKey: { ...local.pair },
      peerPublicKey: peer.publicKey,
      check,
    };
  }
}
