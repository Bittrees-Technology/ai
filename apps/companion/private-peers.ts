import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PrivatePeerEnrollment,
  PrivatePeerError,
  exportPrivatePeers,
} from "../../modules/remote/private-peers.js";
import {
  privateInvitationSchema,
  type PrivateBinding,
} from "../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    expectedRevision: revision,
    expectedKeyRevision: revision,
    invitation: privateInvitationSchema,
  }),
  z.strictObject({
    action: z.literal("revoke"),
    expectedRevision: revision,
    peerId: z.uuid(),
  }),
]);
type Review = {
  id: string;
  createdAt: number;
  expiresAt: number;
  request: z.infer<typeof request>;
  binding: PrivateBinding | null;
  fingerprint: string;
};
/** Called only under the parent key controller's shared operation lock. The
 * constructor/status are local-only; no credential or key read until explicit action. */
export class CompanionPrivatePeers {
  private review?: Review;
  private generation = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (
      current?: () => PrivateBinding | null,
    ) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  status() {
    const saved = exportPrivatePeers(this.store, this.vault, this.owner);
    const keyState = this.keys().list();
    return {
      available: true,
      canSetup: this.enabled && !!this.remote,
      revision: saved.revision,
      needsFreshPairing: saved.needsFreshPairing || keyState.needsFreshPairing,
      keyRevision: keyState.revision,
      hasSelectedKey: keyState.slots.some((s) => s.state === "active"),
      peers:
        saved.state?.peers.map((p) => ({
          peerId: p.peerId,
          keyEpoch: p.keyEpoch,
          fingerprint: p.fingerprint,
          revoked: p.revoked,
        })) ?? [],
    };
  }
  private live() {
    if (!this.enabled || !this.remote) throw new PrivatePeerError("DENIED");
    return this.remote;
  }
  private sameKeys(expected: number) {
    if (this.keys().list().revision !== expected)
      throw new PrivatePeerError("CONFLICT");
  }
  private peers(current: () => PrivateBinding | null = () => null) {
    return new PrivatePeerEnrollment(
      this.store,
      this.vault,
      this.owner,
      current,
      this.now,
    );
  }
  async invitation(raw: unknown) {
    this.invalidate();
    const parsed = z
      .strictObject({
        recipientId: z.uuid(),
        expectedKeyRevision: revision,
        confirmed: z.literal(true),
      })
      .safeParse(raw);
    if (!parsed.success) throw new PrivatePeerError("DENIED");
    const input = parsed.data;
    return this.live().withVerifiedDevice(async (scope) => {
      this.sameKeys(input.expectedKeyRevision);
      const result = await this.keys(scope.current).invitation({
        recipientId: input.recipientId,
        confirmed: true,
      });
      this.sameKeys(input.expectedKeyRevision);
      return result;
    });
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation;
    const parsed = request.safeParse(raw);
    if (!parsed.success) throw new PrivatePeerError("DENIED");
    const input = parsed.data;
    const save = (
      binding: PrivateBinding | null,
      value: string,
      expiresAt: number,
      replaces: unknown = null,
    ) => {
      if (generation !== this.generation) throw new PrivatePeerError("DENIED");
      this.review = {
        id: randomUUID(),
        createdAt: this.now(),
        expiresAt,
        request: input,
        binding,
        fingerprint: value,
      };
      return structuredClone({
        id: this.review.id,
        action: input.action,
        expiresAt,
        binding,
        fingerprint: value,
        peerId:
          input.action === "approve" ? input.invitation.peerId : input.peerId,
        keyEpoch: input.action === "approve" ? input.invitation.keyEpoch : null,
        replaces,
      });
    };
    if (input.action === "revoke") {
      const status = this.status();
      if (status.revision !== input.expectedRevision)
        throw new PrivatePeerError("CONFLICT");
      const peer = status.peers.find(
        (p) => p.peerId === input.peerId && !p.revoked,
      );
      if (!peer) throw new PrivatePeerError("DENIED");
      return save(null, peer.fingerprint, this.now() + 300000);
    }
    try {
      return await this.live().withVerifiedDevice(async (scope) => {
        this.sameKeys(input.expectedKeyRevision);
        const keys = this.keys(scope.current),
          { proof } = await keys.resolve();
        const prepared = await this.peers(scope.current).prepare(
          input.invitation,
        );
        if (
          prepared.expectedRevision !== input.expectedRevision ||
          !keys.validate(proof)
        )
          throw new PrivatePeerError("CONFLICT");
        return save(
          scope.current(),
          prepared.fingerprint,
          prepared.expiresAt,
          prepared.replaces,
        );
      });
    } catch (error) {
      this.review = undefined;
      throw error;
    }
  }
  async confirm(raw: unknown) {
    const r = this.review;
    this.review = undefined;
    const parsed = z
      .strictObject({
        reviewId: z.uuid(),
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
        comparedFingerprint: fingerprint.optional(),
      })
      .safeParse(raw);
    if (
      !parsed.success ||
      !r ||
      parsed.data.reviewId !== r.id ||
      r.createdAt > this.now() ||
      r.expiresAt <= this.now()
    )
      throw new PrivatePeerError("DENIED");
    const input = r.request;
    if (input.action === "revoke") {
      if (parsed.data.comparedFingerprint !== undefined)
        throw new PrivatePeerError("DENIED");
      this.peers().revoke({
        peerId: input.peerId,
        expectedRevision: input.expectedRevision,
        confirmed: true,
      });
    } else {
      if (parsed.data.comparedFingerprint !== r.fingerprint)
        throw new PrivatePeerError("DENIED");
      await this.live().withVerifiedDevice(async (scope) => {
        if (
          JSON.stringify(scope.current()) !== JSON.stringify(r.binding) ||
          this.now() >= r.expiresAt ||
          this.now() < r.createdAt
        )
          throw new PrivatePeerError("DENIED");
        this.sameKeys(input.expectedKeyRevision);
        const keys = this.keys(scope.current),
          { proof } = await keys.resolve(),
          peers = this.peers(scope.current);
        const fresh = await peers.prepare(input.invitation);
        if (
          fresh.expectedRevision !== input.expectedRevision ||
          fresh.fingerprint !== r.fingerprint ||
          !keys.validate(proof)
        )
          throw new PrivatePeerError("CONFLICT");
        // Hold SQLite's write lock across both authority checks and publication.
        // Another process must not rotate the Mac key between proof and pin save.
        this.store.db
          .transaction(() => {
            if (!keys.validate(proof)) throw new PrivatePeerError("CONFLICT");
            peers.approve({
              reviewId: fresh.reviewId,
              expectedRevision: fresh.expectedRevision,
              comparedFingerprint: parsed.data.comparedFingerprint,
              confirmed: true,
            });
          })
          .immediate();
      });
    }
    return this.status();
  }
}
