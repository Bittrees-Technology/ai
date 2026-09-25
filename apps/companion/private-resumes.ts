import type { CompanionPrivateRelay } from "./private-relay.js";
import type { PrivateRelayClient } from "../../modules/remote/private-relay-client.js";
import {
  privateRelayQueueQuerySchema,
  privateRelaySelectionSchema,
  relayQueueReview,
  relaySelectionMatches,
} from "../../modules/remote/private-relay-queue.js";
import { CompanionResumeOffers } from "./private-resume-offers.js";
import type { PinnedModel } from "../../modules/models/ollama.js";
import {
  PrivateResumeDelivery,
  exportPrivateResumeDelivery,
} from "../../modules/remote/private-resume-delivery.js";
import type { ResumeAccess } from "../../modules/storage/remote-resumes.js";
import type { Ollama } from "../../modules/models/ollama.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PrivateResumeConsent,
  PrivateResumeConsentError,
} from "../../modules/remote/private-resume-consent.js";
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
const connection = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const relayQuery = privateRelayQueueQuerySchema.extend({ connection });
const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("grant"),
    expectedRevision: revision,
    expectedKeyRevision: revision,
    expectedPeerRevision: revision,
    peerId: z.uuid(),
    peerKeyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minutes: z.union([z.literal(15), z.literal(60)]),
    taskId: z.uuid(),
    taskRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    action: z.literal("revoke"),
    expectedRevision: revision,
    permissionId: z.uuid(),
  }),
]);
type Prepared = Awaited<ReturnType<PrivateResumeConsent["prepare"]>>;
type Review = {
  id: string;
  createdAt: number;
  expiresAt: number;
  request: z.infer<typeof request>;
  prepared: Prepared | null;
  monotonicCreatedAt: number;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Parent owns the shared key/peer/permission operation lock and logout fence. */
export class CompanionPrivateResumes {
  private review?: Review;
  private offerControls: CompanionResumeOffers;
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
    private mono = () => performance.now(),
    private runtime?: Pick<Ollama, "pin">,
    private taskAccess?: ResumeAccess,
  ) {
    this.owner = { ...owner };
    this.offerControls = new CompanionResumeOffers(
      store,
      vault,
      this.owner,
      keys,
      remote,
      enabled && !!runtime && !!taskAccess,
      now,
      mono,
      (taskId, revision) => this.pinModel(taskId, revision),
    );
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
    this.offerControls.invalidate();
  }
  offerStatus() {
    return this.offerControls.status();
  }
  prepareOffer(raw: unknown) {
    this.invalidate();
    return this.offerControls.prepare(raw);
  }
  confirmOffer(raw: unknown) {
    return this.offerControls.confirm(raw);
  }
  private consent(current: () => PrivateBinding | null = () => null) {
    return new PrivateResumeConsent(
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
      this.mono,
    );
  }
  status() {
    const saved = this.consent().list(),
      keyState = this.keys().list(),
      peers = exportPrivatePeers(this.store, this.vault, this.owner);
    return {
      deliveries: exportPrivateResumeDelivery(
        this.store,
        this.vault,
        this.owner,
      ).map(({ id, locked, value }) => ({
        commandId: id,
        locked,
        permissionId: value.permissionId,
        receipt: value.receipt,
        expiresAt: value.header.expiresAt,
      })),
      available: true,
      canSetup:
        this.enabled && !!this.remote && !!this.runtime && !!this.taskAccess,
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
  private async pinModel(taskId: string, taskRevision: number) {
    if (!this.runtime || !this.taskAccess)
      throw new PrivateResumeConsentError("DENIED");
    const snapshot = () => {
      const task = this.store.get(this.owner, taskId);
      if (task.status !== "paused" || task.revision !== taskRevision)
        throw new PrivateResumeConsentError("CONFLICT");
      return {
        task,
        profile: this.store.profile(this.owner, task.input.modelProfileId),
        source: this.store.sourceBinding(this.owner, taskId),
      };
    };
    const before = snapshot();
    const pinned = await this.runtime.pin(
      structuredClone(before.profile),
      AbortSignal.timeout(10000),
    );
    if (
      !same(snapshot(), before) ||
      !same(pinned.profile, before.profile) ||
      !/^[a-f0-9]{64}$/.test(pinned.digest)
    )
      throw new PrivateResumeConsentError("CONFLICT");
    return pinned.digest;
  }
  private async delivery<T>(
    action: (receiver: PrivateResumeDelivery) => Promise<T>,
  ) {
    const generation = this.generation;
    if (!this.taskAccess) throw new PrivateResumeConsentError("DENIED");
    return this.live().withVerifiedDevice(async (scope) => {
      const current = () =>
        generation === this.generation ? scope.current() : null;
      if (!current()) throw new PrivateResumeConsentError("DENIED");
      const receiver = new PrivateResumeDelivery(
        this.store,
        this.vault,
        this.owner,
        this.consent(current),
        this.taskAccess!,
        this.now,
      );
      const result = await action(receiver);
      if (!current()) throw new PrivateResumeConsentError("DENIED");
      return result;
    });
  }
  receive(raw: unknown) {
    this.invalidate();
    return this.delivery((receiver) => receiver.receive(raw));
  }
  receipt(raw: unknown) {
    this.invalidate();
    return this.delivery((receiver) => receiver.receipt(raw));
  }
  private relayScope<T>(
    relay: CompanionPrivateRelay,
    raw: z.infer<typeof connection>,
    action: (
      client: PrivateRelayClient,
      receiver: PrivateResumeDelivery,
      check: () => void,
    ) => Promise<T>,
  ) {
    if (!this.enabled || !this.remote || !this.taskAccess)
      throw new PrivateResumeConsentError("DENIED");
    const generation = this.generation;
    return relay.withTransport(raw, async (client, binding) => {
      const current = () => (generation === this.generation ? binding() : null);
      const check = () => {
        if (!current()) throw new PrivateResumeConsentError("DENIED");
      };
      check();
      const receiver = new PrivateResumeDelivery(
        this.store,
        this.vault,
        this.owner,
        this.consent(current),
        this.taskAccess!,
        this.now,
      );
      const result = await action(client, receiver, check);
      check();
      return result;
    });
  }
  inspectRelay(raw: unknown, relay: CompanionPrivateRelay) {
    const input = relayQuery.parse(raw);
    return this.relayScope(
      relay,
      input.connection,
      async (client, _receiver, check) => {
        const page = await client.poll({ after: input.after, limit: 1 });
        check();
        return {
          transportOnly: true as const,
          item: relayQueueReview(page.items[0]),
          nextCursor: page.nextCursor,
        };
      },
    );
  }
  /** Exact task/model permission and shared replay admission precede acknowledgement. */
  receiveRelay(raw: unknown, relay: CompanionPrivateRelay) {
    const input = relayQuery
      .extend({
        selection: privateRelaySelectionSchema,
        permissionId: z.uuid(),
      })
      .parse(raw);
    return this.relayScope(
      relay,
      input.connection,
      async (client, receiver, check) => {
        const page = await client.poll({ after: input.after, limit: 1 });
        check();
        const item = page.items[0];
        if (!item || !relaySelectionMatches(item, input.selection))
          throw new PrivateResumeConsentError("CONFLICT");
        const received = await receiver.receive({
          permissionId: input.permissionId,
          envelope: item.envelope,
          confirmed: true,
        });
        check();
        const transport = await client.acknowledge({
          messageId: item.receipt.messageId,
          envelopeHash: item.receipt.envelopeHash,
          expectedRevision: item.receipt.revision,
          confirmed: true,
        });
        check();
        return {
          received,
          transport: { transportOnly: true as const, ...transport },
          nextCursor: page.nextCursor,
        };
      },
    );
  }
  /** Receipt transmission is separate from acceptance. A lost reply can be retried
   * with the original retained ciphertext, without executing the command again. */
  sendRelayReceipt(raw: unknown, relay: CompanionPrivateRelay) {
    const input = z
      .strictObject({
        connection,
        permissionId: z.uuid(),
        commandId: z.uuid(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.relayScope(
      relay,
      input.connection,
      async (client, receiver, check) => {
        const receiptRequest = {
          permissionId: input.permissionId,
          commandId: input.commandId,
          confirmed: true as const,
        };
        const envelope = await receiver.receipt(receiptRequest);
        check();
        const result = await client.submit(
          { version: 1, envelope },
          async () => {
            check();
            const current = await receiver.receipt(receiptRequest);
            check();
            if (!same(current, envelope))
              throw new PrivateResumeConsentError("CONFLICT");
          },
        );
        check();
        return {
          commandId: input.commandId,
          transport: { transportOnly: true as const, ...result },
        };
      },
    );
  }
  async withExecution<T>(
    taskId: string,
    model: PinnedModel,
    action: (privateAuthority: (permissionId: string) => void) => T,
  ): Promise<T> {
    const generation = this.generation;
    return this.live().withVerifiedDevice(async (scope) => {
      const current = () =>
        generation === this.generation ? scope.current() : null;
      const consent = this.consent(current);
      const check = (permissionId: string) => {
        if (!current()) throw new PrivateResumeConsentError("DENIED");
        consent.check(permissionId);
      };
      this.store.remoteResumes.checkExecutionModel(
        this.owner,
        taskId,
        model,
        check,
      );
      return action(check);
    });
  }
  private live() {
    if (!this.enabled || !this.remote)
      throw new PrivateResumeConsentError("DENIED");
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
      throw new PrivateResumeConsentError("CONFLICT");
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation,
      parsed = request.safeParse(raw);
    if (!parsed.success) throw new PrivateResumeConsentError("DENIED");
    const input = parsed.data;
    const save = (prepared: Prepared | null) => {
      if (generation !== this.generation)
        throw new PrivateResumeConsentError("DENIED");
      const now = this.now();
      this.review = {
        id: randomUUID(),
        createdAt: now,
        expiresAt: prepared?.expiresAt ?? now + 300000,
        request: input,
        prepared,
        monotonicCreatedAt: this.mono(),
      };
      const displayed =
        prepared?.grant ??
        this.consent()
          .list()
          .grants.find(
            (g) => input.action === "revoke" && g.id === input.permissionId,
          );
      return structuredClone({
        id: this.review.id,
        action: input.action,
        expiresAt: this.review.expiresAt,
        peerId: displayed?.choices.peerId ?? null,
        permissionId: input.action === "revoke" ? input.permissionId : null,
        choices: displayed?.choices ?? null,
        binding: displayed?.local.binding ?? null,
        fingerprint: displayed?.peer.fingerprint ?? null,
      });
    };
    if (input.action === "revoke") {
      const state = this.consent().list();
      if (state.revision !== input.expectedRevision)
        throw new PrivateResumeConsentError("CONFLICT");
      if (!state.grants.some((g) => g.id === input.permissionId && !g.revoked))
        throw new PrivateResumeConsentError("DENIED");
      return save(null);
    }
    try {
      return await this.live().withVerifiedDevice(async (scope) => {
        this.checkRevisions(input);
        const binding = scope.current();
        if (!binding) throw new PrivateResumeConsentError("DENIED");
        const prepared = await this.consent(scope.current).prepare({
          expectedRevision: input.expectedRevision,
          choices: {
            peerId: input.peerId,
            peerKeyEpoch: input.peerKeyEpoch,
            taskId: input.taskId,
            taskRevision: input.taskRevision,
            modelDigest: await this.pinModel(input.taskId, input.taskRevision),
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
    const generation = this.generation,
      r = this.review;
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
      this.now() >= r.expiresAt ||
      this.mono() < r.monotonicCreatedAt ||
      this.mono() - r.monotonicCreatedAt >= r.expiresAt - r.createdAt
    )
      throw new PrivateResumeConsentError("DENIED");
    const input = r.request;
    const commit = (action: () => unknown) =>
      this.store.db
        .transaction(() => {
          if (
            generation !== this.generation ||
            this.now() >= r.expiresAt ||
            this.now() < r.createdAt ||
            this.mono() < r.monotonicCreatedAt ||
            this.mono() - r.monotonicCreatedAt >= r.expiresAt - r.createdAt
          )
            throw new PrivateResumeConsentError("DENIED");
          return action();
        })
        .immediate();
    if (input.action === "revoke")
      commit(() =>
        this.consent().revoke({
          permissionId: input.permissionId,
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
          throw new PrivateResumeConsentError("DENIED");
        this.checkRevisions(input);
        if (
          (await this.pinModel(input.taskId, input.taskRevision)) !==
          original.grant.choices.modelDigest
        )
          throw new PrivateResumeConsentError("CONFLICT");
        const consent = this.consent(scope.current),
          fresh = await consent.prepare({
            expectedRevision: input.expectedRevision,
            choices: original.grant.choices,
          });
        if (
          !same(fresh.grant.local, original.grant.local) ||
          !same(fresh.grant.peer, original.grant.peer) ||
          fresh.grant.scopeHash !== original.grant.scopeHash ||
          this.now() >= r.expiresAt ||
          this.mono() < r.monotonicCreatedAt ||
          this.mono() - r.monotonicCreatedAt >= r.expiresAt - r.createdAt
        )
          throw new PrivateResumeConsentError("CONFLICT");
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
