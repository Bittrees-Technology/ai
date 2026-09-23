import { randomUUID } from "node:crypto";
import { z } from "zod";
import { id } from "../../modules/contracts/index.js";
import {
  PrivateTaskConsent,
  PrivateConsentError,
} from "../../modules/remote/private-task-consent.js";
import {
  PrivatePeerEnrollment,
  exportPrivatePeers,
} from "../../modules/remote/private-peers.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Owner, Store } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("grant"),
    expectedRevision: revision,
    expectedKeyRevision: revision,
    expectedPeerRevision: revision,
    peerId: z.uuid(),
    peerKeyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minutes: z.union([z.literal(15), z.literal(60)]),
    receiveTasks: z.boolean(),
    sendTasks: z.boolean(),
    sendReceipts: z.boolean(),
    sendResults: z.boolean(),
    modelProfileId: id.nullable(),
  }),
  z.strictObject({
    action: z.literal("revoke"),
    expectedRevision: revision,
    peerId: z.uuid(),
  }),
]);
type Prepared = Awaited<ReturnType<PrivateTaskConsent["prepare"]>>;
type Review = {
  id: string;
  createdAt: number;
  expiresAt: number;
  request: z.infer<typeof request>;
  prepared: Prepared | null;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Parent owns the shared key/peer/permission operation lock and logout fence. */
export class CompanionPrivateTaskPermissions {
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
  private consent(current: () => PrivateBinding | null = () => null) {
    return new PrivateTaskConsent(
      this.store,
      this.vault,
      this.owner,
      current,
      this.keys(current),
      new PrivatePeerEnrollment(
        this.store,
        this.vault,
        this.owner,
        current,
        this.now,
      ),
      this.now,
    );
  }
  status() {
    const saved = this.consent().list(),
      keyState = this.keys().list(),
      peers = exportPrivatePeers(this.store, this.vault, this.owner);
    return {
      available: true,
      canSetup: this.enabled && !!this.remote,
      revision: saved.revision,
      keyRevision: keyState.revision,
      peerRevision: peers.revision,
      needsFreshPairing: keyState.needsFreshPairing || peers.needsFreshPairing,
      hasSelectedKey: keyState.slots.some((v) => v.state === "active"),
      peers:
        peers.state?.peers
          .filter((p) => !p.revoked)
          .map((p) => ({
            peerId: p.peerId,
            keyEpoch: p.keyEpoch,
            fingerprint: p.fingerprint,
          })) ?? [],
      profiles: this.store
        .profiles(this.owner)
        .filter((p) => p.runtime === "ollama")
        .map((p) => ({ id: p.id, model: p.model })),
      grants: saved.grants.map((g) => ({
        id: g.id,
        choices: g.choices,
        state: g.revoked
          ? "revoked"
          : g.choices.expiresAt <= this.now()
            ? "expired"
            : saved.needsReview ||
                keyState.needsFreshPairing ||
                peers.needsFreshPairing ||
                keyState.revision !== g.local.revision ||
                peers.revision !== g.peer.revision
              ? "needs-review"
              : "saved",
      })),
    };
  }
  private live() {
    if (!this.enabled || !this.remote) throw new PrivateConsentError("DENIED");
    return this.remote;
  }
  private checkRevisions(
    input: Extract<z.infer<typeof request>, { action: "grant" }>,
  ) {
    const status = this.status();
    if (
      status.revision !== input.expectedRevision ||
      status.keyRevision !== input.expectedKeyRevision ||
      status.peerRevision !== input.expectedPeerRevision
    )
      throw new PrivateConsentError("CONFLICT");
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation,
      parsed = request.safeParse(raw);
    if (!parsed.success) throw new PrivateConsentError("DENIED");
    const input = parsed.data;
    const save = (prepared: Prepared | null) => {
      if (generation !== this.generation)
        throw new PrivateConsentError("DENIED");
      const now = this.now();
      this.review = {
        id: randomUUID(),
        createdAt: now,
        expiresAt: prepared?.expiresAt ?? now + 300000,
        request: input,
        prepared,
      };
      return structuredClone({
        id: this.review.id,
        action: input.action,
        expiresAt: this.review.expiresAt,
        peerId: input.peerId,
        choices: prepared?.grant.choices ?? null,
        binding: prepared?.grant.local.binding ?? null,
        fingerprint: prepared?.grant.peer.fingerprint ?? null,
        model: prepared?.grant.choices.modelProfileId
          ? this.store.profile(
              this.owner,
              prepared.grant.choices.modelProfileId,
            ).model
          : null,
      });
    };
    if (input.action === "revoke") {
      const state = this.consent().list();
      if (state.revision !== input.expectedRevision)
        throw new PrivateConsentError("CONFLICT");
      if (
        !state.grants.some(
          (g) => g.choices.peerId === input.peerId && !g.revoked,
        )
      )
        throw new PrivateConsentError("DENIED");
      return save(null);
    }
    try {
      return await this.live().withVerifiedDevice(async (scope) => {
        this.checkRevisions(input);
        const binding = scope.current();
        if (!binding) throw new PrivateConsentError("DENIED");
        const prepared = await this.consent(scope.current).prepare({
          expectedRevision: input.expectedRevision,
          choices: {
            peerId: input.peerId,
            peerKeyEpoch: input.peerKeyEpoch,
            receiveTasks: input.receiveTasks,
            sendTasks: input.sendTasks,
            sendReceipts: input.sendReceipts,
            sendResults: input.sendResults,
            modelProfileId: input.modelProfileId,
            expiresAt: Math.min(
              this.now() + input.minutes * 60000,
              binding.expiresAt,
            ),
          },
        });
        this.checkRevisions(input);
        return save(prepared);
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
      })
      .safeParse(raw);
    if (
      !parsed.success ||
      !r ||
      parsed.data.reviewId !== r.id ||
      this.now() < r.createdAt ||
      this.now() >= r.expiresAt
    )
      throw new PrivateConsentError("DENIED");
    const input = r.request;
    const commit = (action: () => unknown) =>
      this.store.db
        .transaction(() => {
          if (this.now() >= r.expiresAt || this.now() < r.createdAt)
            throw new PrivateConsentError("DENIED");
          return action();
        })
        .immediate();
    if (input.action === "revoke")
      commit(() =>
        this.consent().revoke({
          peerId: input.peerId,
          expectedRevision: input.expectedRevision,
          confirmed: true,
        }),
      );
    else {
      const original = r.prepared!;
      await this.live().withVerifiedDevice(async (scope) => {
        if (
          !same(scope.current(), original.grant.local.binding) ||
          this.now() >= r.expiresAt ||
          this.now() < r.createdAt
        )
          throw new PrivateConsentError("DENIED");
        this.checkRevisions(input);
        const consent = this.consent(scope.current),
          fresh = await consent.prepare({
            expectedRevision: input.expectedRevision,
            choices: original.grant.choices,
          });
        if (
          !same(fresh.grant.local, original.grant.local) ||
          !same(fresh.grant.peer, original.grant.peer) ||
          fresh.grant.modelHash !== original.grant.modelHash ||
          this.now() >= r.expiresAt
        )
          throw new PrivateConsentError("CONFLICT");
        commit(() =>
          consent.approve({
            reviewId: fresh.id,
            expectedRevision: fresh.revision,
            confirmed: true,
            acknowledged: true,
          }),
        );
      });
    }
    return this.status();
  }
}
