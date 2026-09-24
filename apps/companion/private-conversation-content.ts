import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CompanionPrivateRelay } from "./private-relay.js";
import type { PrivateRelayClient } from "../../modules/remote/private-relay-client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateConversationConsent } from "../../modules/remote/private-conversation-consent.js";
import {
  PrivateConversationContent,
  ConversationContentError,
  conversationPrepareInputSchema,
  conversationSealInputSchema,
  conversationReceiveInputSchema,
  conversationReconcileInputSchema,
  type ConversationTaskAccess,
} from "../../modules/remote/private-conversation-content.js";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const relayRequest = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"),
    id: z.uuid(),
    permissionId: z.uuid(),
    expectedRevision: revision,
    connection: z.strictObject({ id: z.uuid(), expectedRevision: revision }),
  }),
  z.strictObject({
    action: z.literal("stop"),
    id: z.uuid(),
    permissionId: z.uuid(),
    expectedRevision: revision,
  }),
]);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type RelayReview = {
  id: string;
  request: z.infer<typeof relayRequest>;
  entry: Entry;
  recipient?: Awaited<ReturnType<PrivateRelayClient["recipient"]>>;
  createdAt: number;
  expiresAt: number;
  monotonicAt: number;
  generation: number;
};
type Entry = Awaited<ReturnType<PrivateConversationContent["prepare"]>>;
// No task text, key proofs, source bindings or ciphertext in status/receipts.
function summary(entry: Entry) {
  const v = entry.value;
  return {
    id: v.content.id,
    permissionId: v.grant.id,
    revision: entry.revision,
    direction: v.direction,
    kind: v.content.type,
    state: v.state,
    locked: entry.locked,
    peerId: v.grant.choices.peerId,
    localMessageId: v.localMessageId,
    expiresAt: v.header.expiresAt,
    relayAttempts: v.relay?.attempts ?? 0,
    relayStopped: v.relay?.stopped ?? false,
    relayObservation: v.relay?.observation ?? null,
    receiptPrepared: v.direction === "incoming" && !!v.receiptEnvelope,
    recipientAccepted: v.direction === "outgoing" && !!v.receiptEnvelope,
    recipientAcceptedAt:
      v.direction === "outgoing" ? (v.receipt?.acceptedAt ?? null) : null,
  };
}

/** Authenticated local handoff. The parent holds key/peer/permission exclusion.
 * Construction/status never accesses native keys or the network. This class
 * does not poll, submit to a relay, or claim recipient delivery. */
export class CompanionConversationContent {
  private generation = 0;
  private relayReview?: RelayReview;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (current: () => PrivateBinding | null) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private taskAccess?: ConversationTaskAccess,
    private now = Date.now,
    private mono = () => performance.now(),
  ) {
    this.owner = { ...owner };
  }

  invalidate() {
    this.generation++;
    this.relayReview = undefined;
  }
  status() {
    return {
      available: true,
      enabled: this.enabled && !!this.remote,
      transportActive: false,
      items: this.store
        .exportPrivateConversationContent(this.owner)
        .map(summary),
    };
  }
  private engine(current: () => PrivateBinding | null = () => null) {
    const keys = this.keys(current);
    const consent = new PrivateConversationConsent(
      this.store,
      this.vault,
      this.owner,
      current,
      keys,
      new PrivatePeerEnrollment(
        this.store,
        this.vault,
        this.owner,
        current,
        this.now,
      ),
      this.now,
    );
    return new PrivateConversationContent(
      this.store,
      this.vault,
      this.owner,
      consent,
      keys,
      this.taskAccess,
      this.now,
    );
  }
  private async scope<T>(
    action: (engine: PrivateConversationContent) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled || !this.remote)
      throw new ConversationContentError("DENIED");
    const generation = this.generation;
    return this.remote.withVerifiedDevice(async (scope) => {
      const current = () =>
        generation === this.generation ? scope.current() : null;
      if (!current()) throw new ConversationContentError("DENIED");
      const engine = this.engine(current);
      const result = await action(engine);
      if (!current()) throw new ConversationContentError("DENIED");
      return result;
    });
  }
  private valid(review: RelayReview) {
    const now = this.now(),
      elapsed = this.mono() - review.monotonicAt;
    return (
      review.generation === this.generation &&
      Number.isSafeInteger(now) &&
      now >= review.createdAt &&
      now < review.expiresAt &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < review.expiresAt - review.createdAt
    );
  }
  async prepareRelay(raw: unknown, relay?: CompanionPrivateRelay) {
    this.invalidate();
    const generation = this.generation,
      request = relayRequest.parse(raw);
    const save = (
      entry: Entry,
      recipient?: RelayReview["recipient"],
      limit = Infinity,
    ) => {
      if (
        generation !== this.generation ||
        entry.revision !== request.expectedRevision
      )
        throw new ConversationContentError("CONFLICT");
      const createdAt = this.now(),
        monotonicAt = this.mono();
      const expiresAt =
        request.action === "stop"
          ? createdAt + 120000
          : Math.min(createdAt + 120000, entry.value.header.expiresAt, limit);
      if (
        !Number.isSafeInteger(createdAt) ||
        createdAt <= 0 ||
        !Number.isFinite(monotonicAt) ||
        expiresAt <= createdAt
      )
        throw new ConversationContentError("DENIED");
      this.relayReview = {
        id: randomUUID(),
        request,
        entry,
        recipient,
        createdAt,
        expiresAt,
        monotonicAt,
        generation,
      };
      return {
        id: this.relayReview.id,
        action: request.action,
        expiresAt,
        entry: summary(entry),
        fingerprint: entry.value.grant.peer.fingerprint,
        transportOnly: true as const,
        ...(recipient ? { relayRecipient: structuredClone(recipient) } : {}),
      };
    };
    if (request.action === "stop") {
      const entry = this.store
        .exportPrivateConversationContent(this.owner)
        .find(
          (e) =>
            e.value.grant.id === request.permissionId &&
            e.value.content.id === request.id,
        );
      if (!entry) throw new ConversationContentError("DENIED");
      return save(entry);
    }
    if (!this.enabled || !this.remote || !relay)
      throw new ConversationContentError("DENIED");
    return relay.withTransport(
      request.connection,
      async (client, binding, limit) => {
        const current = () =>
          generation === this.generation ? binding() : null;
        const engine = this.engine(current),
          input = {
            id: request.id,
            permissionId: request.permissionId,
            expectedRevision: request.expectedRevision,
            confirmed: true,
          };
        const entry = await engine.inspectRelayDelivery(input);
        const recipient = await client.recipient({
          endpointId: entry.value.grant.choices.peerId,
        });
        const fresh = await engine.inspectRelayDelivery(input);
        if (
          !current() ||
          !same(entry, fresh) ||
          entry.value.header.expiresAt > Math.min(limit, recipient.expiresAt)
        )
          throw new ConversationContentError("DENIED");
        return save(fresh, recipient, Math.min(limit, recipient.expiresAt));
      },
    );
  }
  async confirmRelay(raw: unknown, relay?: CompanionPrivateRelay) {
    const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .parse(raw),
      review = this.relayReview;
    this.relayReview = undefined;
    if (!review || review.id !== input.reviewId || !this.valid(review))
      throw new ConversationContentError("DENIED");
    const request = review.request;
    const original = {
      id: request.id,
      permissionId: request.permissionId,
      expectedRevision: request.expectedRevision,
      confirmed: true,
    };
    if (request.action === "stop") {
      const entry = this.store.db
        .transaction(() => {
          if (!this.valid(review)) throw new ConversationContentError("DENIED");
          const result = this.engine().stopRelayDelivery(original);
          if (!this.valid(review)) throw new ConversationContentError("DENIED");
          return result;
        })
        .immediate();
      return { entry: summary(entry), envelope: null };
    }
    if (!this.enabled || !this.remote || !relay || !review.recipient)
      throw new ConversationContentError("DENIED");
    return relay.withTransport(
      request.connection,
      async (client, binding, limit) => {
        const current = () => (this.valid(review) ? binding() : null),
          engine = this.engine(current);
        const entry = await engine.inspectRelayDelivery(original);
        if (!same(entry, review.entry))
          throw new ConversationContentError("CONFLICT");
        const recipient = await client.recipient({
          endpointId: entry.value.grant.choices.peerId,
        });
        if (!same(recipient, review.recipient))
          throw new ConversationContentError("CONFLICT");
        const attempt = await engine.beginRelayDelivery({
          ...original,
          deliveryExpiresAt: Math.min(limit, recipient.expiresAt),
        });
        if (!current()) throw new ConversationContentError("DENIED");
        const sent = await client.submit(
          {
            version: 1,
            envelope: attempt.envelope,
          },
          () => {
            if (!current()) throw new ConversationContentError("DENIED");
            attempt.check();
          },
        );
        if (!current()) throw new ConversationContentError("DENIED");
        const saved = await engine.recordRelayDelivery({
          ...original,
          expectedRevision: attempt.entry.revision,
          receipt: sent.receipt,
        });
        if (!current()) throw new ConversationContentError("DENIED");
        return {
          entry: summary(saved),
          envelope: null,
          transport: { transportOnly: true as const, ...sent },
        };
      },
    );
  }
  prepare(raw: unknown) {
    const input = conversationPrepareInputSchema.parse(raw);
    return this.scope(async (engine) => ({
      entry: summary(await engine.prepare(input)),
    }));
  }
  envelope(raw: unknown) {
    const input = conversationSealInputSchema.parse(raw);
    return this.scope(async (engine) => ({
      envelope: await engine.seal(input),
    }));
  }
  receive(raw: unknown) {
    const input = conversationReceiveInputSchema.parse(raw);
    return this.scope(async (engine) => {
      const result = await engine.accept(input);
      return {
        status: "accepted-locally" as const,
        duplicate: result.duplicate,
        entry: summary(result.entry),
      };
    });
  }
  reconcile(raw: unknown) {
    const input = conversationReconcileInputSchema.parse(raw);
    return this.scope(async (engine) => {
      const result = await engine.reconcile(input);
      return {
        status: "recipient-storage-confirmed" as const,
        duplicate: result.duplicate,
        entry: summary(result.entry),
      };
    });
  }
}
