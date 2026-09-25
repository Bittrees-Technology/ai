import { BrowserAutoNoteApprovalInbox } from "./browser-autonote-approval-inbox.js";
import { BrowserResumeDelivery } from "./browser-resume-delivery.js";
import { BrowserResumeConsent } from "./browser-resume-consent.js";
import { BrowserConversationContent } from "./browser-conversation-content.js";
import { BrowserConversationConsent } from "./browser-conversation-consent.js";
import {
  privateRelaySelectionSchema,
  privateRelayQueueQuerySchema,
  relayQueueReview,
  relaySelectionMatches,
} from "./private-relay-queue.js";
import { privateRelayPageSchema } from "./private-relay-contracts.js";
import { BrowserRelayTransport } from "./browser-relay-transport.js";
import { BrowserPrivateOutbox } from "./browser-outbox.js";
import { BrowserTaskComposition } from "./browser-task-composition.js";
import { BrowserTaskHistory } from "./browser-task-history.js";
import { BrowserTaskConsent } from "./browser-task-consent.js";
import { z } from "zod";
import { privateTaskPayloadSchema } from "./private-task-contracts.js";
import {
  BrowserDeviceClient,
  type BrowserDeviceContext,
} from "./browser-device-client.js";
import {
  BrowserKeyLifecycle,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import { BrowserPeerChecks } from "./browser-peer-checks.js";
import { BrowserPeerEnrollment } from "./browser-peers.js";
import type { VerifiedBrowserDeviceScope } from "./browser-device-contracts.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
const contextSchema = z.strictObject({
  ownerId: z.uuid(),
  scope: z.string().min(1).max(1024),
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** One trusted signed-in owner/session scope. Displayed identity is never an
 * offline grant: every online key operation obtains its own verified scope. */
export class BrowserKeyHost {
  private generation = 0;
  private closed = false;
  private busy = false;
  private binding: PrivateBinding | null = null;
  private freshUntil = 0;
  private sessionUntil = 0;
  private freshStarted = 0;
  private freshMono = 0;
  private active: VerifiedBrowserDeviceScope | null = null;
  private keys!: BrowserKeyLifecycle;
  private peers!: BrowserPeerEnrollment;
  private checks?: BrowserPeerChecks;
  private consents?: BrowserTaskConsent;
  private conversations?: BrowserConversationConsent;
  private resumes?: BrowserResumeConsent;
  private resumeDelivery?: BrowserResumeDelivery;
  private approvalInbox?: BrowserAutoNoteApprovalInbox;
  private conversationContent?: BrowserConversationContent;
  private compositions?: BrowserTaskComposition;
  private taskHistory?: BrowserTaskHistory;
  private peerKey: BrowserKeyProof | null = null;
  private client: BrowserDeviceClient;
  private relay: BrowserRelayTransport;
  readonly localOwner: string;
  private constructor(
    private original: BrowserDeviceContext,
    private context: () => BrowserDeviceContext | null,
    transport: typeof fetch,
    private now: () => number,
    private monotonic: () => number,
  ) {
    this.localOwner = "browser:" + original.ownerId;
    this.relay = new BrowserRelayTransport(
      () => {
        const context = this.currentContext(),
          binding = this.active?.current();
        return context && binding ? { ...context, binding } : null;
      },
      transport,
      now,
      monotonic,
    );

    this.client = new BrowserDeviceClient(
      () => this.currentContext(),
      transport,
      now,
      monotonic,
    );
  }
  static async open(
    context: () => BrowserDeviceContext | null,
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    now = Date.now,
    monotonic = () => performance.now(),
  ) {
    const original = contextSchema.parse(context());
    const self = new BrowserKeyHost(
      original,
      context,
      transport,
      now,
      monotonic,
    );
    try {
      self.keys = await BrowserKeyLifecycle.open(
        self.localOwner,
        () => self.active?.current() ?? null,
        (b) => self.active?.freshRegistration(b) ?? false,
        now,
      );
      self.peers = await BrowserPeerEnrollment.open(
        self.localOwner,
        () =>
          self.peerKey &&
          self.currentContext() &&
          same(self.active?.current(), self.peerKey.binding)
            ? self.peerKey
            : null,
        now,
        monotonic,
      );
      if (!self.currentContext()) {
        self.close();
        throw Error("DENIED");
      }
      return self;
    } catch (e) {
      self.close();
      throw e;
    }
  }
  private currentContext() {
    if (this.closed) return null;
    try {
      const c = contextSchema.parse(this.context());
      return same(c, this.original) ? c : null;
    } catch {
      return null;
    }
  }
  /** View cancellation counter only; it supplies no key or identity authority. */
  reviewVersion() {
    return this.generation;
  }
  session() {
    return this.currentContext();
  }
  keyContext() {
    const c = this.currentContext();
    if (!c) return null;
    const n = this.now(),
      elapsed = this.monotonic() - this.freshMono;
    const binding =
      this.binding && this.binding.expiresAt > n && this.sessionUntil > n
        ? { ...this.binding }
        : null;
    return {
      localOwner: this.localOwner,
      scope: JSON.stringify(c),
      binding,
      freshRegistration:
        !!binding &&
        n >= this.freshStarted &&
        n < this.freshUntil &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed < 120000,
    };
  }
  /** View cancellation invalidates in-flight key work, not an idle acknowledged
   * registration. Otherwise opening a key review would erase its own authority. */
  cancelKeys() {
    this.generation++;
    this.relay.invalidate();
    this.active = null;
    this.peerKey = null;
    this.keys?.invalidate();
    this.peers?.invalidate();
    this.checks?.invalidate();
    this.consents?.invalidate();
    this.conversations?.invalidate();
    this.resumes?.invalidate();
    this.resumeDelivery?.invalidate();
    this.approvalInbox?.invalidate();
    this.conversationContent?.invalidate();
    this.compositions?.invalidate();
    this.taskHistory?.invalidate();
  }
  /** Trusted host calls this immediately on logout, lock or account/scope change. */
  invalidate() {
    this.cancelKeys();
    this.client.invalidate();
    this.binding = null;
    this.sessionUntil = 0;
    this.freshUntil = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    this.keys?.close();
    this.peers?.close();
    this.checks?.close();
    this.consents?.close();
    this.conversations?.close();
    this.resumes?.close();
    this.resumeDelivery?.close();
    this.approvalInbox?.close();
    this.conversationContent?.close();
    this.compositions?.close();
    this.taskHistory?.close();
  }
  private check(g: number) {
    if (g !== this.generation || !this.currentContext()) throw Error("DENIED");
  }
  private async operation<T>(fn: (g: number) => Promise<T>) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const g = this.generation;
    try {
      this.check(g);
      const result = await fn(g);
      this.check(g);
      return result;
    } finally {
      this.busy = false;
    }
  }
  async inspect() {
    return this.operation(async (g) => {
      try {
        const result = await this.client.inspect();
        this.check(g);
        this.sessionUntil = result.sessionExpiresAt;
        const next =
          result.registration?.revokedAt === null &&
          result.registration.binding.expiresAt > this.now()
            ? result.registration.binding
            : null;
        if (!same(next, this.binding)) {
          this.keys.invalidate();
          this.peers.invalidate();
          this.checks?.invalidate();
          this.consents?.invalidate();
          this.conversations?.invalidate();
          this.resumes?.invalidate();
          this.resumeDelivery?.invalidate();
          this.approvalInbox?.invalidate();
          this.conversationContent?.invalidate();
          this.compositions?.invalidate();
          this.taskHistory?.invalidate();
          this.freshUntil = 0;
        }
        this.binding = next ? { ...next } : null;
        return result;
      } catch (e) {
        this.binding = null;
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  async register(raw: unknown) {
    this.cancelKeys();
    return this.operation(async (g) => {
      this.binding = null;
      this.freshUntil = 0;
      const start = this.now(),
        mono = this.monotonic();
      try {
        const result = await this.client.register(raw);
        this.check(g);
        this.binding = { ...result.binding };
        this.sessionUntil = result.sessionExpiresAt;
        this.freshStarted = start;
        this.freshMono = mono;
        this.freshUntil = Math.min(
          start + 120000,
          result.binding.expiresAt,
          result.sessionExpiresAt,
        );
        return result;
      } catch (e) {
        this.client.invalidate();
        throw e;
      }
    });
  }
  list(raw: unknown = {}) {
    return this.operation(async () => {
      try {
        return await this.client.list(raw);
      } catch (e) {
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  async revoke(raw: unknown) {
    this.cancelKeys();
    return this.operation(async (g) => {
      this.freshUntil = 0;
      try {
        const result = await this.client.revoke(raw);
        this.check(g);
        if (result.deviceId === this.binding?.deviceId) this.binding = null;
        return result;
      } catch (e) {
        this.binding = null;
        throw e;
      }
    });
  }
  private verified<T>(fn: () => Promise<T>) {
    return this.operation(async (g) => {
      const binding = this.binding ? { ...this.binding } : null;
      if (!binding) throw Error("DENIED");
      try {
        return await this.client.withVerifiedDevice(binding, async (scope) => {
          this.check(g);
          const current = () => {
            try {
              this.check(g);
              return scope.current();
            } catch {
              return null;
            }
          };
          const active = {
            current,
            freshRegistration: (b: PrivateBinding) =>
              !!current() && scope.freshRegistration(b),
          };
          this.active = active;
          try {
            if (!current()) throw Error("DENIED");
            return await fn();
          } finally {
            if (this.active === active) this.active = null;
          }
        });
      } catch (e) {
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  /** No key handles leave this setup host. Separate peer/task consent is required
   * by future private-content callers; registration alone cannot supply it. */
  readonly keyAPI = {
    status: () => this.operation(() => this.keys.status()),
    begin: (raw: unknown) => this.verified(() => this.keys.begin(raw)),
    prepareRecovery: (raw: unknown, code: string) =>
      this.verified(() => this.keys.prepareRecovery(raw, code)),
    activatePrepared: (raw: unknown, code: string, kit: unknown) =>
      this.verified(() => this.keys.activatePrepared(raw, code, kit)),
    reset: (raw: unknown) => this.verified(() => this.keys.reset(raw)),
    revoke: (raw: unknown) => this.operation(() => this.keys.revoke(raw)),
    remove: (raw: unknown) => this.operation(() => this.keys.remove(raw)),
    clear: (raw: unknown) => this.operation(() => this.keys.clear(raw)),
    recovery: (raw: unknown) => this.operation(() => this.keys.recovery(raw)),
    invalidate: () => this.cancelKeys(),
  };
  private verifiedPeer<T>(fn: () => Promise<T>) {
    return this.verified(async () => {
      const key = await this.keys.resolve();
      this.peerKey = key.proof;
      try {
        return await fn();
      } finally {
        this.peerKey = null;
      }
    });
  }
  /** Public invitations/pins only. No private key handle, possession grant or task
   * consent is exposed by this API. Each enrollment step verifies online identity. */
  readonly peerAPI = {
    status: () => this.operation(() => this.peers.status()),
    invitation: (raw: unknown) =>
      this.verified(() => this.keys.invitation(raw)),
    prepare: (raw: unknown) => this.verifiedPeer(() => this.peers.prepare(raw)),
    approve: (raw: unknown) => this.verifiedPeer(() => this.peers.approve(raw)),
    reset: (raw: unknown) => this.verifiedPeer(() => this.peers.reset(raw)),
    revoke: (raw: unknown) => this.operation(() => this.peers.revoke(raw)),
    clear: (raw: unknown) => this.operation(() => this.peers.clear(raw)),
    invalidate: () => this.cancelKeys(),
  };
  // Lazy opening keeps ordinary key recovery usable when history needs repair.
  private async checkStore() {
    if (this.checks) return this.checks;
    const g = this.generation;
    const created = await BrowserPeerChecks.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.checks = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  private async consentStore() {
    if (this.consents) return this.consents;
    const g = this.generation;
    const created = await BrowserTaskConsent.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.consents = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  private async conversationStore() {
    if (this.conversations) return this.conversations;
    const g = this.generation;
    const created = await BrowserConversationConsent.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.conversations = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  private async resumeStore() {
    if (this.resumes) return this.resumes;
    const g = this.generation;
    const created = await BrowserResumeConsent.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.resumes = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  private async approvalInboxStore() {
    if (this.approvalInbox) return this.approvalInbox;
    const generation = this.generation;
    const created = await BrowserAutoNoteApprovalInbox.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(generation);
      this.approvalInbox = created;
      return created;
    } catch (error) {
      created.close();
      throw error;
    }
  }
  private async resumeDeliveryStore() {
    if (this.resumeDelivery) return this.resumeDelivery;
    const generation = this.generation;
    const consent = await this.resumeStore();
    this.check(generation);
    const created = await BrowserResumeDelivery.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      consent,
      this.now,
      this.monotonic,
    );
    try {
      this.check(generation);
      this.resumeDelivery = created;
      return created;
    } catch (error) {
      created.close();
      throw error;
    }
  }
  private async conversationContentStore() {
    if (this.conversationContent) return this.conversationContent;
    const generation = this.generation;
    const consent = await this.conversationStore();
    this.check(generation);
    const created = await BrowserConversationContent.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      consent,
      this.now,
      this.monotonic,
    );
    try {
      this.check(generation);
      this.conversationContent = created;
      return created;
    } catch (error) {
      created.close();
      throw error;
    }
  }
  private async compositionStore() {
    if (this.compositions) return this.compositions;
    const g = this.generation,
      consents = await this.consentStore();
    this.check(g);
    return (this.compositions = new BrowserTaskComposition(
      consents,
      () => this.active?.current() ?? null,
      () => {
        const binding = this.active?.current();
        return binding && this.active?.freshRegistration(binding)
          ? binding
          : null;
      },
      this.now,
      this.monotonic,
    ));
  }
  private async historyStore() {
    if (this.taskHistory) return this.taskHistory;
    const g = this.generation,
      created = await BrowserTaskHistory.open(
        this.original.ownerId,
        () => this.currentContext()?.ownerId ?? null,
        this.now,
        this.monotonic,
      );
    try {
      this.check(g);
      return (this.taskHistory = created);
    } catch (e) {
      created.close();
      throw e;
    }
  }
  /** Explicit relay operations over retained task ciphertext. Neither a storage
   * receipt nor recipient readiness confers task execution or decryption consent. */
  readonly relayTaskAPI = {
    /** One explicit metadata-only queue inspection; nothing is acknowledged or opened. */
    inspect: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = privateRelayQueueQuerySchema.parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 });
          check();
          return {
            transportOnly: true as const,
            item: relayQueueReview(page.items[0]),
            nextCursor: page.nextCursor,
          };
        });
      }),
    /** One explicit pull. A server delivery acknowledgement follows durable,
     * authenticated browser receipt/result storage and carries no task authority. */
    check: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            after: privateRelayPageSchema.shape.after,
            selection: privateRelaySelectionSchema.optional(),
            confirmed: z.literal(true),
          })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 });
          const item = page.items[0];
          if (!relaySelectionMatches(item, input.selection))
            throw Error("CONFLICT");
          if (!item) return { received: null, nextCursor: page.nextCursor };
          const received = await (
            await this.compositionStore()
          ).receiveMessage({ envelope: item.envelope, confirmed: true }, check);
          check();
          const transport = await client.acknowledge({
            messageId: item.receipt.messageId,
            envelopeHash: item.receipt.envelopeHash,
            expectedRevision: item.receipt.revision,
            confirmed: true,
          });
          return {
            received: { ...received, messageId: item.receipt.messageId },
            transport: { transportOnly: true as const, ...transport },
            nextCursor: page.nextCursor,
          };
        });
      }),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            peerId: z.uuid(),
            peerKeyEpoch: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            payload: privateTaskPayloadSchema,
          })
          .parse(raw);
        return this.relay.withClient(async (client, sender) => {
          const recipient = await client.recipient({
            endpointId: input.peerId,
          });
          return (await this.compositionStore()).prepare(
            input,
            Math.min(sender.expiresAt, recipient.expiresAt),
          );
        });
      }),
    send: (raw: unknown) =>
      this.verifiedPeer(async () =>
        this.relay.withClient(async (client, sender, check) => {
          const input = z
            .strictObject({
              peerId: z.uuid(),
              peerKeyEpoch: z
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER),
              id: z.uuid(),
              expectedRevision: z
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER),
              confirmed: z.literal(true),
            })
            .parse(raw);
          const recipient = await client.recipient({
            endpointId: input.peerId,
          });
          const envelope = await (
            await this.compositionStore()
          ).envelope(input);
          if (
            envelope.header.expiresAt >
            Math.min(sender.expiresAt, recipient.expiresAt)
          )
            throw Error("DENIED");
          const result = await client.submit({ version: 1, envelope });
          check();
          await (
            await this.historyStore()
          ).recordRelayDelivery(
            {
              id: input.id,
              expectedRevision: input.expectedRevision + 1,
              envelope,
              receipt: result.receipt,
            },
            check,
          );
          return { transportOnly: true as const, ...result };
        }),
      ),
  };
  /** Reviewed composition and explicit recovery. No network sender or authority
   * handle is exposed. Owner-local maintenance is independent of sending grants. */
  readonly taskAPI = {
    status: () =>
      this.operation(async () => (await this.historyStore()).status()),
    export: (raw: unknown) =>
      this.operation(async () => (await this.historyStore()).export(raw)),
    stop: (raw: unknown) =>
      this.operation(async () => (await this.historyStore()).stop(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.historyStore()).clear(raw)),
    envelope: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).envelope(raw),
      ),
    receive: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).receive(raw),
      ),
    readResult: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).readResult(raw),
      ),
    initialize: (raw: unknown) =>
      this.verified(() => {
        if (!this.active) throw Error("DENIED");
        return BrowserPrivateOutbox.initializeVerified(
          raw,
          this.active,
          this.now,
        );
      }),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).prepare(raw),
      ),
    confirm: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).confirm(raw),
      ),
    resume: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.compositionStore()).resume(raw),
      ),
    invalidate: () => this.cancelKeys(),
  };
  /** Saved permission choices are not a task route. Every online review obtains
   * fresh verified identity; offline metadata/revocation never grant authority. */
  readonly consentAPI = {
    status: () =>
      this.operation(async () => (await this.consentStore()).status()),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.consentStore()).prepare(raw)),
    approve: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.consentStore()).approve(raw)),
    revoke: (raw: unknown) =>
      this.operation(async () => (await this.consentStore()).revoke(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.consentStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.consentStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
  /** Offer transport is independent of task delivery and conversation consent.
   * Queue inspection and opening never acknowledge or approve an offer. */
  readonly relayConversationAPI = {
    inspect: (raw: unknown) => this.relayTaskAPI.inspect(raw),
    open: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            after: privateRelayPageSchema.shape.after,
            selection: privateRelaySelectionSchema,
            peerId: z.uuid(),
            peerKeyEpoch: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            expectedRevision: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            confirmed: z.literal(true),
          })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 }),
            item = page.items[0];
          check();
          if (!item || !relaySelectionMatches(item, input.selection))
            throw Error("CONFLICT");
          const opened = await (
            await this.conversationStore()
          ).inspectOffer({
            expectedRevision: input.expectedRevision,
            peerId: input.peerId,
            peerKeyEpoch: input.peerKeyEpoch,
            envelope: item.envelope,
          });
          check();
          return {
            opened,
            envelope: item.envelope,
            selection: input.selection,
            nextCursor: page.nextCursor,
            transportOnly: true as const,
          };
        });
      }),
    acknowledge: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            grantId: z.uuid(),
            expectedRevision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            confirmed: z.literal(true),
            selected: z
              .strictObject({
                after: privateRelayPageSchema.shape.after,
                selection: privateRelaySelectionSchema,
              })
              .optional(),
          })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          let selected;
          if (input.selected) {
            const page = await client.poll({
                after: input.selected.after,
                limit: 1,
              }),
              item = page.items[0];
            check();
            if (!item || !relaySelectionMatches(item, input.selected.selection))
              throw Error("CONFLICT");
            selected = {
              envelope: item.envelope,
              selection: input.selected.selection,
            };
          }
          const store = await this.conversationStore(),
            attempt = await store.beginOfferAcknowledgement(
              {
                grantId: input.grantId,
                expectedRevision: input.expectedRevision,
                confirmed: true,
                ...(selected ? { selected } : {}),
              },
              check,
            );
          check();
          const result = await client.acknowledge(attempt.acknowledgement);
          check();
          const saved = await store.recordOfferAcknowledgement(
            {
              grantId: input.grantId,
              expectedRevision: attempt.revision,
              confirmed: true,
              receipt: result.receipt,
            },
            check,
          );
          return {
            ...saved,
            transport: { transportOnly: true as const, ...result },
          };
        });
      }),
  };
  /** Explicit selected receipt and original-ciphertext delivery. Admission commits
   * before acknowledgement; sends persist attempts first. No automatic retries. */
  readonly relayConversationContentAPI = {
    inspect: (raw: unknown) => this.relayTaskAPI.inspect(raw),
    receive: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = privateRelayQueueQuerySchema
          .extend({
            selection: privateRelaySelectionSchema,
            target: z.discriminatedUnion("action", [
              z.strictObject({
                action: z.literal("receive"),
                grantId: z.uuid(),
              }),
              z.strictObject({
                action: z.literal("reconcile"),
                grantId: z.uuid(),
                id: z.uuid(),
                expectedRevision: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER),
              }),
            ]),
          })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 }),
            item = page.items[0];
          check();
          if (!item || !relaySelectionMatches(item, input.selection))
            throw Error("CONFLICT");
          const store = await this.conversationContentStore(),
            target = input.target;
          const received =
            target.action === "receive"
              ? await store.accept(
                  {
                    grantId: target.grantId,
                    envelope: item.envelope,
                    confirmed: true,
                  },
                  check,
                )
              : await store.reconcile(
                  {
                    grantId: target.grantId,
                    id: target.id,
                    expectedRevision: target.expectedRevision,
                    envelope: item.envelope,
                    confirmed: true,
                  },
                  check,
                );
          // Admission/reconciliation is durable before transport acknowledgement.
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
        });
      }),
    send: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            grantId: z.uuid(),
            id: z.uuid(),
            expectedRevision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            confirmed: z.literal(true),
          })
          .parse(raw);
        const consent = await (await this.conversationStore()).status();
        const grant = consent.grants.find((g) => g.id === input.grantId);
        if (!grant) throw Error("DENIED");
        return this.relay.withClient(async (client, sender, check) => {
          const recipient = await client.recipient({
            endpointId: grant.choices.peerId,
          });
          check();
          const store = await this.conversationContentStore();
          const attempt = await store.beginRelayDelivery({
            ...input,
            deliveryExpiresAt: Math.min(sender.expiresAt, recipient.expiresAt),
          });
          check();
          const result = await client.submit(
            { version: 1, envelope: attempt.envelope },
            async () => {
              check();
              await attempt.check();
              check();
            },
          );
          check();
          const entry = await store.recordRelayDelivery({
            ...input,
            expectedRevision: attempt.entry.revision,
            receipt: result.receipt,
          });
          check();
          return {
            entry,
            transport: { transportOnly: true as const, ...result },
          };
        });
      }),
    stop: (raw: unknown) =>
      this.operation(async () =>
        (await this.conversationContentStore()).stopRelayDelivery(raw),
      ),
    invalidate: () => this.cancelKeys(),
  };
  /** Current online identity for every content operation. Explicit archive export
   * needs matching owner/device identity but no active key or expired permission.
   * Offline deletion is bounded to this signed-in local owner and locks consent.
   * Neither operation imports authority, submits relay data or exposes a key. */
  readonly conversationContentAPI = {
    deliveryHistory: () =>
      this.operation(async () =>
        (await this.conversationContentStore()).deliveryHistory(),
      ),
    list: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).list(raw),
      ),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).prepare(raw),
      ),
    envelope: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).envelope(raw),
      ),
    accept: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).accept(raw),
      ),
    reconcile: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).reconcile(raw),
      ),
    read: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationContentStore()).read(raw),
      ),
    export: (raw: unknown) =>
      this.verified(async () =>
        (await this.conversationContentStore()).export(raw),
      ),
    clear: (raw: unknown) =>
      this.operation(async () =>
        (await this.conversationContentStore()).clear(raw),
      ),
    invalidate: () => this.cancelKeys(),
  };
  /** Independent conversation consent. Inspection authenticates an offer without
   * granting access; no keys, content-authority handle or sender leaves this API. */
  readonly conversationAPI = {
    status: () =>
      this.operation(async () => (await this.conversationStore()).status()),
    inspectOffer: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationStore()).inspectOffer(raw),
      ),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationStore()).prepare(raw),
      ),
    approve: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.conversationStore()).approve(raw),
      ),
    revoke: (raw: unknown) =>
      this.operation(async () => (await this.conversationStore()).revoke(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.conversationStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.conversationStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
  /** Retained resume requests. Offline maintenance cannot restore authority;
   * every envelope and receipt operation obtains fresh verified peer scope. */
  readonly resumeDeliveryAPI = {
    history: () =>
      this.operation(async () => (await this.resumeDeliveryStore()).history()),
    export: (raw: unknown) =>
      this.operation(async () =>
        (await this.resumeDeliveryStore()).export(raw),
      ),
    stop: (raw: unknown) =>
      this.operation(async () => (await this.resumeDeliveryStore()).stop(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.resumeDeliveryStore()).clear(raw)),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.resumeDeliveryStore()).prepare(raw),
      ),
    read: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.resumeDeliveryStore()).read(raw),
      ),
    envelope: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.resumeDeliveryStore()).envelope(raw),
      ),
    reconcile: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.resumeDeliveryStore()).reconcile(raw),
      ),
    invalidate: () => this.cancelKeys(),
  };
  /** Transport storage is not Mac acceptance. Originals are retained before any
   * upload; uncertain uploads reuse that exact envelope on an explicit retry. */
  readonly autoNoteApprovalAPI = {
    decisionHistory: () =>
      this.operation(async () =>
        (await this.approvalInboxStore()).decisionHistory(),
      ),
    exportDecision: (raw: unknown) =>
      this.operation(async () =>
        (await this.approvalInboxStore()).exportDecision(raw),
      ),
    prepareDecision: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.approvalInboxStore()).prepareDecision(raw),
      ),
    confirmDecision: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.approvalInboxStore()).confirmDecision(raw),
      ),
    decisionStatus: (raw: unknown) =>
      this.operation(async () =>
        (await this.approvalInboxStore()).decisionStatus(raw),
      ),
    sendDecision: (raw: unknown) =>
      this.verifiedPeer(async () =>
        this.relay.withClient(async (client, sender, check) => {
          return (await this.approvalInboxStore()).dispatchDecision(
            raw,
            async (envelope, current) => {
              const recipient = await client.recipient({
                endpointId: envelope.header.recipientId,
              });
              check();
              if (
                envelope.header.expiresAt >
                Math.min(sender.expiresAt, recipient.expiresAt)
              )
                throw Error("DENIED");
              const result = await client.submit(
                { version: 1, envelope },
                async () => {
                  check();
                  await current();
                  check();
                },
              );
              return result.receipt;
            },
          );
        }),
      ),
    status: () =>
      this.operation(async () => (await this.approvalInboxStore()).status()),
    reveal: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.approvalInboxStore()).reveal(raw),
      ),
    export: (raw: unknown) =>
      this.operation(async () => (await this.approvalInboxStore()).export(raw)),
    remove: (raw: unknown) =>
      this.operation(async () => (await this.approvalInboxStore()).remove(raw)),
    inspect: (raw: unknown) => this.relayTaskAPI.inspect(raw),
    receive: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = privateRelayQueueQuerySchema
          .extend({ selection: privateRelaySelectionSchema })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 }),
            item = page.items[0];
          check();
          if (!item || !relaySelectionMatches(item, input.selection))
            throw Error("CONFLICT");
          const received = await (
            await this.approvalInboxStore()
          ).receive({ envelope: item.envelope, confirmed: true }, check);
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
        });
      }),
    invalidate: () => this.cancelKeys(),
  };
  readonly relayResumeAPI = {
    inspect: (raw: unknown) => this.relayTaskAPI.inspect(raw),
    send: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = z
          .strictObject({
            grantId: z.uuid(),
            id: z.uuid(),
            expectedRevision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            confirmed: z.literal(true),
          })
          .parse(raw);
        return this.relay.withClient(async (client, sender, check) => {
          const store = await this.resumeDeliveryStore();
          const original = await store.envelope(input);
          check();
          const recipient = await client.recipient({
            endpointId: original.header.recipientId,
          });
          check();
          if (
            original.header.expiresAt >
            Math.min(sender.expiresAt, recipient.expiresAt)
          )
            throw Error("DENIED");
          const entry = await store.read({
            grantId: input.grantId,
            id: input.id,
          });
          check();
          const result = await client.submit(
            { version: 1, envelope: original },
            async () => {
              check();
              const current = await store.envelope({
                ...input,
                expectedRevision: entry.revision,
              });
              check();
              if (!same(current, original)) throw Error("CONFLICT");
            },
          );
          check();
          return {
            entry,
            transport: { transportOnly: true as const, ...result },
          };
        });
      }),
    receive: (raw: unknown) =>
      this.verifiedPeer(async () => {
        const input = privateRelayQueueQuerySchema
          .extend({
            selection: privateRelaySelectionSchema,
            grantId: z.uuid(),
            id: z.uuid(),
            expectedRevision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .parse(raw);
        return this.relay.withClient(async (client, _identity, check) => {
          const page = await client.poll({ after: input.after, limit: 1 }),
            item = page.items[0];
          check();
          if (!item || !relaySelectionMatches(item, input.selection))
            throw Error("CONFLICT");
          const received = await (
            await this.resumeDeliveryStore()
          ).reconcile(
            {
              grantId: input.grantId,
              id: input.id,
              expectedRevision: input.expectedRevision,
              envelope: item.envelope,
              confirmed: true,
            },
            check,
          );
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
        });
      }),
    invalidate: () => this.cancelKeys(),
  };
  /** Separate resume consent for a specific paused Mac task and model.
   * Public callers receive metadata only; execution authority stays internal. */
  readonly resumeAPI = {
    status: () =>
      this.operation(async () => (await this.resumeStore()).status()),
    inspectOffer: (raw: unknown) =>
      this.verifiedPeer(async () =>
        (await this.resumeStore()).inspectOffer(raw),
      ),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.resumeStore()).prepare(raw)),
    approve: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.resumeStore()).approve(raw)),
    revoke: (raw: unknown) =>
      this.operation(async () => (await this.resumeStore()).revoke(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.resumeStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.resumeStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
  /** Explicit manual device checks only. Public callers receive metadata and the
   * original encrypted envelope, never retained key handles or task permission. */
  readonly checkAPI = {
    status: () =>
      this.operation(async () => (await this.checkStore()).status()),
    begin: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).begin(raw)),
    respond: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).respond(raw)),
    complete: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).complete(raw)),
    resume: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).resume(raw)),
    envelope: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).delivery(raw)),
    stop: (raw: unknown) =>
      this.operation(async () => (await this.checkStore()).stop(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.checkStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.checkStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
}
