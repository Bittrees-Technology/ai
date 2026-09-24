import { CompanionConversationOffers } from "./private-conversation-offers.js";
import { CompanionConversationPermissions } from "./private-conversation-permissions.js";
import {
  privateRelaySelectionSchema,
  relayQueueReview,
  relaySelectionMatches,
} from "../../modules/remote/private-relay-queue.js";
import type { CompanionPrivateRelay } from "./private-relay.js";
import { privateRelayPageSchema } from "../../modules/remote/private-relay-contracts.js";
import { CompanionPeerChecks } from "./private-peer-checks.js";
import { CompanionPrivateTaskPermissions } from "./private-task-permissions.js";
import {
  CompanionPrivateTasks,
  responsePrepareSchema,
  responseDeliverySchema,
} from "./private-tasks.js";
import { CompanionPrivatePeers } from "./private-peers.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PrivateKeyLifecycle,
  PrivateKeyLifecycleError,
} from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateKeyEntries } from "../../modules/remote/private-endpoint-keys.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const relayConnectionSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const request = z.strictObject({
  action: z.enum([
    "create",
    "replace",
    "resume",
    "remove",
    "revoke",
    "cleanup",
  ]),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  keyId: z.uuid().optional(),
});
type Review = z.infer<typeof request> & {
  id: string;
  createdAt: number;
  expiresAt: number;
  binding: PrivateBinding | null;
};
/** Trusted local owner only. Review never creates keys; confirmation rechecks the
 * exact revision and verified registration. No content transport or source grants; private-task choices require separate review.
 */
export class CompanionPrivateKeys {
  private peers: CompanionPrivatePeers;
  private peerChecks: CompanionPeerChecks;
  private permissions: CompanionPrivateTaskPermissions;
  private conversations: CompanionConversationPermissions;
  private conversationOffers: CompanionConversationOffers;
  private tasks: CompanionPrivateTasks;
  private review?: Review;
  private running = false;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private entries: (id: string) => PrivateKeyEntries,
    private remote?: RemoteClient,
    private setupEnabled = false,
    private now = Date.now,
    private privateTasksEnabled = false,
  ) {
    this.owner = { ...owner };
    this.peerChecks = new CompanionPeerChecks(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled,
      now,
    );
    this.tasks = new CompanionPrivateTasks(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled && privateTasksEnabled,
      now,
    );
    this.permissions = new CompanionPrivateTaskPermissions(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled,
      now,
    );
    this.conversations = new CompanionConversationPermissions(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled,
      now,
    );
    this.conversationOffers = new CompanionConversationOffers(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled,
      now,
    );
    this.peers = new CompanionPrivatePeers(
      store,
      vault,
      this.owner,
      (current) => this.keys(current),
      remote,
      setupEnabled,
      now,
    );
  }
  get busy() {
    return this.running;
  }
  private keys(current: () => PrivateBinding | null = () => null) {
    return new PrivateKeyLifecycle(
      this.store,
      this.vault,
      this.owner,
      current,
      this.entries,
      undefined,
      this.now,
    );
  }
  status() {
    return {
      available: true,
      canSetup: this.setupEnabled && !!this.remote,
      state: this.keys().list(),
    };
  }
  invalidate() {
    this.review = undefined;
    this.peers.invalidate();
    this.permissions.invalidate();
    this.conversations.invalidate();
    this.conversationOffers.invalidate();
    this.remote?.invalidatePrivateIdentity();
  }
  peerStatus() {
    return this.peers.status();
  }
  peerInvitation(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.permissions.invalidate();
      this.conversations.invalidate();
      this.conversationOffers.invalidate();
      return this.peers.invitation(raw);
    });
  }
  preparePeer(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.permissions.invalidate();
      this.conversations.invalidate();
      this.conversationOffers.invalidate();
      return this.peers.prepare(raw);
    });
  }
  confirmPeer(raw: unknown) {
    return this.exclusive(async () => this.peers.confirm(raw));
  }
  permissionStatus() {
    return this.permissions.status();
  }
  peerCheckStatus() {
    return this.peerChecks.status();
  }
  beginPeerCheck(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.begin(raw));
  }
  respondPeerCheck(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.respond(raw));
  }
  completePeerCheck(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.complete(raw));
  }
  resumePeerCheck(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.resume(raw));
  }
  peerCheckEnvelope(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.envelope(raw));
  }
  stopPeerCheck(raw: unknown) {
    return this.protocolOperation(() => this.peerChecks.stop(raw));
  }
  taskStatus() {
    return this.tasks.status();
  }
  private protocolOperation<T>(fn: () => Promise<T> | T) {
    return this.exclusive(async () => {
      this.invalidate();
      return fn();
    });
  }
  receiveTask(raw: unknown) {
    return this.protocolOperation(() => this.tasks.receive(raw));
  }
  /** Inspect one queued transport record without decrypting, admitting or acknowledging it. */
  inspectRelayedTask(relay: CompanionPrivateRelay, raw: unknown) {
    if (!this.setupEnabled || !this.privateTasksEnabled || !this.remote)
      return Promise.reject(new PrivateKeyLifecycleError("DENIED"));
    const input = z
      .strictObject({
        id: z.uuid(),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        after: privateRelayPageSchema.shape.after,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.protocolOperation(() =>
      relay.withTransport(
        { id: input.id, expectedRevision: input.expectedRevision },
        async (client, current) => {
          const page = await client.poll({ after: input.after, limit: 1 });
          if (!current()) throw new PrivateKeyLifecycleError("DENIED");
          return {
            transportOnly: true as const,
            item: relayQueueReview(page.items[0]),
            nextCursor: page.nextCursor,
          };
        },
      ),
    );
  }
  /** One explicit bounded pull. Transport acknowledgement follows durable local
   * authenticated admission; it is never a receipt/result sent to the browser. */
  checkRelayedTask(relay: CompanionPrivateRelay, raw: unknown) {
    if (!this.setupEnabled || !this.privateTasksEnabled || !this.remote)
      return Promise.reject(new PrivateKeyLifecycleError("DENIED"));
    const input = z
      .strictObject({
        id: z.uuid(),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        after: privateRelayPageSchema.shape.after,
        selection: privateRelaySelectionSchema.optional(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.protocolOperation(() =>
      relay.withTransport(
        { id: input.id, expectedRevision: input.expectedRevision },
        async (client, current) => {
          const page = await client.poll({ after: input.after, limit: 1 });
          const item = page.items[0];
          if (!relaySelectionMatches(item, input.selection))
            throw new PrivateKeyLifecycleError("CONFLICT");
          if (!item) return { received: null, nextCursor: page.nextCursor };
          const received = await this.tasks.receiveVerified(
            item.envelope,
            current,
          );
          // A stop/logout after admission may leave a queued task but must fence ack.
          // Retrying the exact message reconciles the durable local receipt.
          if (!current()) throw new PrivateKeyLifecycleError("DENIED");
          const transport = await client.acknowledge({
            messageId: item.receipt.messageId,
            envelopeHash: item.receipt.envelopeHash,
            expectedRevision: item.receipt.revision,
            confirmed: true,
          });
          return {
            received: { ...received, messageId: item.receipt.messageId },
            transport: { transportOnly: true, ...transport },
            nextCursor: page.nextCursor,
          };
        },
      ),
    );
  }
  prepareRelayedResponse(relay: CompanionPrivateRelay, raw: unknown) {
    if (!this.setupEnabled || !this.privateTasksEnabled || !this.remote)
      return Promise.reject(new PrivateKeyLifecycleError("DENIED"));
    const input = z
      .strictObject({
        connection: relayConnectionSchema,
        response: responsePrepareSchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.protocolOperation(() =>
      relay.withTransport(
        input.connection,
        async (client, current, expiresAt) => {
          const recipient = await client.recipient({
            endpointId: input.response.peerId,
          });
          return this.tasks.prepareResponseVerified(
            input.response,
            current,
            Math.min(expiresAt, recipient.expiresAt),
          );
        },
      ),
    );
  }
  sendRelayedResponse(relay: CompanionPrivateRelay, raw: unknown) {
    if (!this.setupEnabled || !this.privateTasksEnabled || !this.remote)
      return Promise.reject(new PrivateKeyLifecycleError("DENIED"));
    const input = z
      .strictObject({
        connection: relayConnectionSchema,
        response: responseDeliverySchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.protocolOperation(async () => {
      const target = this.tasks.responseTarget(input.response);
      return relay.withTransport(
        input.connection,
        async (client, current, expiresAt) => {
          const recipient = await client.recipient({
            endpointId: target.peerId,
          });
          const envelope = await this.tasks.responseEnvelopeVerified(
            input.response,
            current,
            Math.min(expiresAt, recipient.expiresAt),
          );
          const result = await client.submit({ version: 1, envelope });
          if (!current()) throw new PrivateKeyLifecycleError("DENIED");
          await this.tasks.recordResponseDelivery(
            input.response.id,
            input.response.expectedRevision + 1,
            envelope,
            result.receipt,
          );
          // Server storage acknowledgement is not a browser application receipt.
          return { transportOnly: true as const, ...result };
        },
      );
    });
  }
  prepareTaskResponse(raw: unknown) {
    return this.protocolOperation(() => this.tasks.prepareResponse(raw));
  }
  resumeTaskResponse(raw: unknown) {
    return this.protocolOperation(() => this.tasks.resumeResponse(raw));
  }
  taskResponseEnvelope(raw: unknown) {
    return this.protocolOperation(() => this.tasks.responseEnvelope(raw));
  }
  stopTaskResponse(raw: unknown) {
    return this.protocolOperation(() => this.tasks.stopResponse(raw));
  }
  preparePermission(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.peers.invalidate();
      this.conversations.invalidate();
      this.conversationOffers.invalidate();
      return this.permissions.prepare(raw);
    });
  }
  confirmPermission(raw: unknown) {
    return this.exclusive(async () => this.permissions.confirm(raw));
  }
  conversationPermissionStatus() {
    return this.conversations.status();
  }
  prepareConversationPermission(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.peers.invalidate();
      this.permissions.invalidate();
      this.conversationOffers.invalidate();
      return this.conversations.prepare(raw);
    });
  }
  confirmConversationPermission(raw: unknown) {
    return this.exclusive(async () => this.conversations.confirm(raw));
  }
  conversationOfferStatus() {
    return this.conversationOffers.status();
  }
  prepareConversationOffer(raw: unknown, relay?: CompanionPrivateRelay) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.peers.invalidate();
      this.permissions.invalidate();
      this.conversations.invalidate();
      return this.conversationOffers.prepare(raw, relay);
    });
  }
  confirmConversationOffer(raw: unknown, relay?: CompanionPrivateRelay) {
    return this.exclusive(async () =>
      this.conversationOffers.confirm(raw, relay),
    );
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.running) throw new PrivateKeyLifecycleError("BUSY");
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
  private validate(input: z.infer<typeof request>) {
    const state = this.keys().list();
    if (state.revision !== input.expectedRevision)
      throw new PrivateKeyLifecycleError("CONFLICT");
    const slot = state.slots.find((v) => v.id === input.keyId);
    const selected = state.slots.find(
      (v) => v.state === "active" || v.state === "preparing",
    );
    const requiresKey = ["resume", "remove", "revoke"].includes(input.action);
    if (requiresKey !== !!input.keyId)
      throw new PrivateKeyLifecycleError("DENIED");
    if (
      (input.action === "create" && selected) ||
      (input.action === "replace" && !selected) ||
      (input.action === "resume" && slot?.state !== "preparing") ||
      (input.action === "remove" && (!slot || slot.state === "deleted")) ||
      (input.action === "revoke" &&
        (!slot || !["preparing", "active"].includes(slot.state))) ||
      (input.action === "cleanup" && !state.pendingKeyDeletionCount)
    )
      throw new PrivateKeyLifecycleError("DENIED");
    if (
      ["create", "replace", "resume"].includes(input.action) &&
      state.needsFreshPairing
    )
      throw new PrivateKeyLifecycleError("REPAIR_REQUIRED");
  }
  async prepare(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      this.peers.invalidate();
      this.permissions.invalidate();
      this.conversations.invalidate();
      this.conversationOffers.invalidate();
      const parsed = request.safeParse(raw);
      if (!parsed.success) throw new PrivateKeyLifecycleError("DENIED");
      const input = parsed.data;
      this.validate(input);
      const save = (binding: PrivateBinding | null) => {
        this.validate(input);
        this.review = {
          ...input,
          id: randomUUID(),
          createdAt: this.now(),
          expiresAt: Math.min(
            this.now() + 300000,
            binding?.expiresAt ?? Infinity,
          ),
          binding,
        };
        return structuredClone(this.review);
      };
      if (["create", "replace", "resume"].includes(input.action)) {
        if (!this.setupEnabled || !this.remote)
          throw new PrivateKeyLifecycleError("DENIED");
        return this.remote
          .withVerifiedDevice(async (scope) => {
            const binding = scope.current();
            if (!binding) throw new PrivateKeyLifecycleError("DENIED");
            return save(binding);
          })
          .catch((error) => {
            this.review = undefined;
            throw error;
          });
      }
      return save(null);
    });
  }
  async confirm(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .safeParse(raw);
      const review = this.review;
      this.review = undefined;
      if (
        !input.success ||
        !review ||
        input.data.reviewId !== review.id ||
        review.expiresAt <= this.now() ||
        review.createdAt > this.now()
      )
        throw new PrivateKeyLifecycleError("DENIED");
      this.validate(review);
      const local = this.keys();
      const target = {
        keyId: review.keyId,
        expectedRevision: review.expectedRevision,
        confirmed: true,
      };
      if (review.action === "remove") await local.remove(target);
      else if (review.action === "revoke") local.revoke(target);
      else if (review.action === "cleanup")
        await local.cleanupPending({
          expectedRevision: review.expectedRevision,
          confirmed: true,
        });
      else {
        if (!this.setupEnabled || !this.remote)
          throw new PrivateKeyLifecycleError("DENIED");
        await this.remote.withVerifiedDevice(async (scope) => {
          if (
            JSON.stringify(scope.current()) !==
              JSON.stringify(review.binding) ||
            review.expiresAt <= this.now()
          )
            throw new PrivateKeyLifecycleError("DENIED");
          this.validate(review);
          const keys = this.keys(scope.current);
          const reserved =
            review.action === "resume"
              ? { keyId: review.keyId!, revision: review.expectedRevision }
              : keys.begin({
                  expectedRevision: review.expectedRevision,
                  confirmed: true,
                });
          await keys.provision({
            keyId: reserved.keyId,
            expectedRevision: reserved.revision,
            confirmed: true,
          });
        });
      }
      return this.status();
    });
  }
  async clearAll() {
    return this.exclusive(async () => {
      this.invalidate();
      await this.keys().clearAll({ confirmed: true });
    });
  }
}
