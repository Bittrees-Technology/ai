import { z } from "zod";
import { privateEnvelopeSchema } from "../../modules/remote/private-envelope.js";
import {
  privateRelayIdentitySchema,
  privateRelayStorageReceiptSchema,
} from "../../modules/remote/private-relay-contracts.js";
import {
  privateRelayStatusSchema,
  type RelayStatus,
} from "./private-relay-state.js";
import { taskQuestionViewSchema } from "../../modules/contracts/task-answer.js";
import type { ConversationPermissionStatus } from "./conversation-permission-state.js";

const positive = z.number().int().positive();
export const conversationDeliveryItemSchema = z.object({
  id: z.uuid(),
  permissionId: z.uuid(),
  revision: positive,
  direction: z.enum(["incoming", "outgoing"]),
  kind: z.enum([
    "conversation.message",
    "conversation.question",
    "conversation.answer",
  ]),
  state: z.enum(["preparing", "ready", "accepted"]),
  locked: z.boolean(),
  peerId: z.uuid(),
  localMessageId: z.uuid(),
  expiresAt: positive,
  relayAttempts: z.number().int().nonnegative(),
  relayStopped: z.boolean(),
  relayObservation: z
    .object({
      receipt: privateRelayStorageReceiptSchema,
      observedAt: positive,
      attempt: positive,
    })
    .nullable(),
  receiptPrepared: z.boolean(),
  recipientAccepted: z.boolean(),
  recipientAcceptedAt: positive.nullable(),
});
export type ConversationDeliveryItem = z.infer<
  typeof conversationDeliveryItemSchema
>;
const statusSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  transportActive: z.literal(false),
  items: z.array(conversationDeliveryItemSchema),
});
const messageSchema = z.object({
  id: z.uuid(),
  input: z
    .object({
      content: z.string(),
      type: z.string(),
      recipientInboxId: z.string(),
      conversationId: z.uuid(),
      requestId: z.uuid().optional(),
      replyToId: z.uuid().optional(),
    })
    .passthrough(),
  taskAccess: z.literal("unavailable").optional(),
});
type Message = z.infer<typeof messageSchema>;
const relayReviewSchema = z.object({
  id: z.uuid(),
  action: z.enum(["send", "stop"]),
  expiresAt: positive,
  entry: conversationDeliveryItemSchema,
  fingerprint: z.string().min(1),
  transportOnly: z.literal(true),
  relayRecipient: privateRelayIdentitySchema.optional(),
});
type Prepare = {
  id: string;
  permissionId: string;
  expectedConsentRevision: number;
  localMessageId: string;
  parentId: string | null;
  kind: "message" | "question";
  expiresAt: number;
  confirmed: true;
};
export type ContentReview = {
  action: "prepare" | "seal" | "send" | "stop";
  expiresAt: number;
  peerId: string;
  fingerprint: string;
  entry?: ConversationDeliveryItem;
  request?: Prepare;
  message?: Message;
  question?: z.infer<typeof taskQuestionViewSchema>;
  server?: z.infer<typeof relayReviewSchema>;
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export async function conversationCopyId(
  permissionId: string,
  messageId: string,
) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "bittrees-conversation-copy-v1",
          permissionId,
          messageId,
        ]),
      ),
    ),
  );
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes.slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const endpoint = "/v1/private-conversation-content";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** UI reviews are bounded displays, never authority to access a source or send. */
export class ConversationContentPanelState {
  status: z.infer<typeof statusSchema> | null = null;
  relayStatus: RelayStatus | null = null;
  review: ContentReview | null = null;
  busy = false;
  error = "";
  notice = "";
  private generation = 0;
  private disposed = false;
  private received = { wall: 0, mono: 0 };
  constructor(
    private api: Api,
    private scope: { inboxId: string; conversationId: string },
    public permissions: ConversationPermissionStatus,
    private changed = () => {},
    private now = Date.now,
    private mono = () => performance.now(),
    private identify = conversationCopyId,
  ) {
    this.scope = { ...scope };
    this.permissions = structuredClone(permissions);
  }
  private render() {
    if (!this.disposed) this.changed();
  }
  discard() {
    this.generation++;
    this.review = null;
    this.error = "";
    this.notice = "";
    this.render();
  }
  hide() {
    this.discard();
    this.status = null;
    this.relayStatus = null;
    this.render();
  }
  dispose() {
    this.disposed = true;
    this.hide();
  }
  private valid(r: ContentReview) {
    return (
      this.now() >= this.received.wall &&
      this.now() < r.expiresAt &&
      this.mono() >= this.received.mono &&
      this.mono() - this.received.mono < r.expiresAt - this.received.wall
    );
  }
  expire() {
    if (this.review && !this.valid(this.review)) {
      this.discard();
      this.notice =
        "Review expired. Refresh delivery history and review again.";
      this.render();
    }
  }
  grants() {
    return this.permissions.grants.filter(
      (g) =>
        g.choices.inboxId === this.scope.inboxId &&
        g.choices.conversationId === this.scope.conversationId,
    );
  }
  items() {
    return (
      this.status?.items.filter((e) =>
        this.grants().some(
          (g) => g.id === e.permissionId && g.choices.peerId === e.peerId,
        ),
      ) ?? []
    );
  }
  connections() {
    return this.relayStatus?.canCheckRemote
      ? this.relayStatus.state.items.filter(
          (e) =>
            !e.locked &&
            e.phase === "active" &&
            e.binding &&
            e.binding.expiresAt > this.now() &&
            e.permission?.state === "active" &&
            e.permission.expiresAt > this.now(),
        )
      : [];
  }
  private async act(work: (current: () => boolean) => Promise<void>) {
    if (this.busy || this.disposed) return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.render();
    const current = () => !this.disposed && generation === this.generation;
    try {
      await work(current);
    } catch {
      if (current()) {
        this.review = null;
        this.status = null;
        this.relayStatus = null;
        this.error =
          "The delivery change could not be confirmed. Refresh delivery history before reviewing again. No automatic retry was made.";
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }
  private async load() {
    return statusSchema.parse(await this.api(endpoint));
  }
  refresh() {
    this.discard();
    return this.act(async (current) => {
      const s = await this.load();
      if (current()) this.status = s;
    });
  }
  refreshConnections() {
    this.discard();
    return this.act(async (current) => {
      const s = privateRelayStatusSchema.parse(
        await this.api("/v1/private-relay"),
      );
      if (current()) this.relayStatus = s;
    });
  }
  private async read(id: string) {
    const m = messageSchema.parse(
      await this.api("/v1/messages/" + encodeURIComponent(id)),
    );
    if (
      m.id !== id ||
      m.input.conversationId !== this.scope.conversationId ||
      m.input.recipientInboxId !== this.scope.inboxId ||
      m.taskAccess === "unavailable"
    )
      throw Error("SOURCE_CHANGED");
    return m;
  }
  private async question(m: Message) {
    if (m.input.type !== "clarification") return undefined;
    const q = taskQuestionViewSchema.parse(
      await this.api(
        "/v1/messages/" + encodeURIComponent(m.id) + "/task-question",
      ),
    );
    if (
      q.questionId !== m.id ||
      q.taskId !== m.input.requestId ||
      q.inboxId !== this.scope.inboxId ||
      q.conversationId !== this.scope.conversationId ||
      q.question !== m.input.content ||
      !q.canAnswer ||
      q.replyId ||
      q.deadline <= this.now()
    )
      throw Error("QUESTION_CHANGED");
    return q;
  }
  private accept(r: ContentReview, started: { wall: number; mono: number }) {
    // Reading/source verification time is part of the display lease.
    this.received = started;
    if (!this.valid(r)) throw Error("EXPIRED");
    this.review = r;
  }
  prepare(messageId: string, permissionId: string, existingId?: string) {
    const grant = this.grants().find((g) => g.id === permissionId),
      entry = existingId
        ? this.items().find(
            (e) => e.id === existingId && e.permissionId === permissionId,
          )
        : undefined;
    if (
      !this.status?.enabled ||
      !this.permissions.canSetup ||
      !grant ||
      grant.state !== "saved" ||
      grant.choices.expiresAt <= this.now() ||
      (existingId &&
        (!entry ||
          entry.locked ||
          entry.relayStopped ||
          entry.state !== "preparing" ||
          entry.direction !== "outgoing" ||
          entry.localMessageId !== messageId))
    )
      return;
    if (
      !existingId &&
      this.items().some(
        (e) =>
          e.localMessageId === messageId && e.permissionId === permissionId,
      )
    ) {
      this.notice =
        "A copy of this message is already retained. Use its saved delivery history.";
      this.render();
      return;
    }
    this.discard();
    const started = { wall: this.now(), mono: this.mono() };
    return this.act(async (current) => {
      const message = await this.read(messageId);
      if (!current()) return;
      const question = await this.question(message);
      if (!current()) return;
      const kind = question ? "question" : "message";
      if (
        !(kind === "question"
          ? grant.choices.permissions.questionsToBrowser
          : grant.choices.permissions.messagesToBrowser)
      )
        throw Error("DENIED");
      const parents = message.input.replyToId
        ? this.items().filter(
            (e) =>
              e.permissionId === permissionId &&
              e.localMessageId === message.input.replyToId,
          )
        : [];
      if (message.input.replyToId && parents.length !== 1)
        throw Error("PARENT_UNAVAILABLE");
      const expiresAt =
        entry?.expiresAt ??
        Math.min(
          this.now() + 300000,
          grant.choices.expiresAt,
          question?.deadline ?? Infinity,
        );
      const peer = this.permissions.peers.find(
        (p) =>
          p.peerId === grant.choices.peerId &&
          p.keyEpoch === grant.choices.peerKeyEpoch,
      );
      if (!peer) throw Error("PEER_CHANGED");
      const id = entry?.id ?? (await this.identify(permissionId, messageId));
      if (!current()) return;
      this.accept(
        {
          action: entry ? "seal" : "prepare",
          expiresAt: Math.min(started.wall + 15000, expiresAt),
          peerId: grant.choices.peerId,
          fingerprint: peer.fingerprint,
          message,
          question,
          entry,
          request: {
            id,
            permissionId,
            expectedConsentRevision: this.permissions.revision,
            localMessageId: messageId,
            parentId: parents[0]?.id ?? null,
            kind,
            expiresAt,
            confirmed: true,
          },
        },
        started,
      );
    });
  }
  relay(
    id: string,
    permissionId: string,
    action: "send" | "stop",
    connectionId = "",
  ) {
    const entry = this.items().find(
        (e) => e.id === id && e.permissionId === permissionId,
      ),
      connection = this.connections().find((e) => e.id === connectionId);
    if (
      !entry ||
      entry.relayStopped ||
      (action === "send" &&
        (!connection ||
          !this.status?.enabled ||
          entry.locked ||
          entry.expiresAt <= this.now() ||
          (entry.direction === "incoming"
            ? !entry.receiptPrepared
            : entry.state !== "ready")))
    )
      return;
    const retained = structuredClone(entry),
      selected = structuredClone(connection);
    this.discard();
    const started = { wall: this.now(), mono: this.mono() };
    return this.act(async (current) => {
      const server = relayReviewSchema.parse(
        await this.api(endpoint + "/relay-review", "POST", {
          action,
          id,
          permissionId,
          expectedRevision: retained.revision,
          ...(action === "send"
            ? {
                connection: {
                  id: selected!.id,
                  expectedRevision: selected!.revision,
                },
              }
            : {}),
        }),
      );
      if (!current()) return;
      if (
        server.action !== action ||
        !same(server.entry, retained) ||
        server.expiresAt > this.now() + 120000
      )
        throw Error("REVIEW_CHANGED");
      if (action === "send") {
        const recipient = server.relayRecipient,
          peer = this.permissions.peers.find(
            (p) => p.peerId === retained.peerId,
          );
        if (
          !recipient ||
          recipient.endpointKind !== "browser" ||
          recipient.endpointId !== retained.peerId ||
          recipient.ownerId !== selected!.binding?.ownerId ||
          recipient.expiresAt < retained.expiresAt ||
          server.expiresAt > retained.expiresAt ||
          !peer ||
          server.fingerprint !== peer.fingerprint
        )
          throw Error("DESTINATION_CHANGED");
      }
      this.accept(
        {
          action,
          expiresAt: Math.min(server.expiresAt, started.wall + 120000),
          entry: retained,
          peerId: retained.peerId,
          fingerprint: server.fingerprint,
          server,
        },
        started,
      );
    });
  }
  confirm(ack: boolean, available: () => boolean) {
    const r = this.review;
    if (!ack || !available() || !r || !this.valid(r)) {
      this.expire();
      return;
    }
    return this.act(async (current) => {
      this.review = null;
      const active = () => current() && available() && this.valid(r);
      if (r.action === "prepare" || r.action === "seal") {
        const m = await this.read(r.message!.id);
        if (!active()) return;
        const q = await this.question(m);
        if (!active()) return;
        if (!same(m, r.message) || !same(q, r.question))
          throw Error("SOURCE_CHANGED");
        const request = r.request!;
        let entry = r.entry;
        if (!entry) {
          const result = await this.api(endpoint + "/prepare", "POST", request);
          if (!active()) return;
          entry = conversationDeliveryItemSchema.parse(result.entry);
        }
        if (
          entry.id !== request.id ||
          entry.permissionId !== request.permissionId ||
          entry.localMessageId !== request.localMessageId ||
          entry.direction !== "outgoing" ||
          entry.peerId !== r.peerId ||
          entry.kind !== "conversation." + request.kind ||
          entry.expiresAt !== request.expiresAt ||
          entry.locked ||
          entry.state !== "preparing"
        )
          throw Error("ORIGINAL_CHANGED");
        const result = await this.api(endpoint + "/envelope", "POST", {
          id: entry.id,
          permissionId: entry.permissionId,
          expectedRevision: entry.revision,
          confirmed: true,
        });
        if (!active()) return;
        const wire = privateEnvelopeSchema.parse(result.envelope);
        if (
          wire.header.operationId !== entry.id ||
          wire.header.recipientId !== r.peerId ||
          wire.header.recipientKeyEpoch !==
            this.grants().find((g) => g.id === entry.permissionId)?.choices
              .peerKeyEpoch ||
          wire.header.expiresAt !== entry.expiresAt
        )
          throw Error("ENVELOPE_CHANGED");
        // The envelope stays in encrypted storage; no download or relay request.
        const status = await this.load();
        if (!active()) return;
        const saved = status.items.find(
          (e) => e.id === entry!.id && e.permissionId === entry!.permissionId,
        );
        if (
          !saved ||
          saved.state !== "ready" ||
          saved.localMessageId !== entry.localMessageId ||
          saved.relayAttempts !== 0
        )
          throw Error("RESULT_CHANGED");
        this.status = status;
        this.notice =
          "Encrypted copy prepared on this Mac. Review its upload separately.";
      } else {
        const result = await this.api(endpoint + "/relay-confirm", "POST", {
          reviewId: r.server!.id,
          confirmed: true,
          acknowledged: true,
        });
        if (!active()) return;
        const entry = conversationDeliveryItemSchema.parse(result.entry),
          original = r.entry!;
        if (
          entry.id !== original.id ||
          entry.permissionId !== original.permissionId ||
          entry.localMessageId !== original.localMessageId ||
          entry.peerId !== original.peerId ||
          entry.kind !== original.kind ||
          entry.direction !== original.direction ||
          entry.state !== original.state ||
          entry.locked !== original.locked ||
          entry.receiptPrepared !== original.receiptPrepared ||
          entry.expiresAt !== original.expiresAt ||
          entry.revision <= original.revision ||
          result.envelope !== null ||
          entry.recipientAccepted !== original.recipientAccepted ||
          entry.recipientAcceptedAt !== original.recipientAcceptedAt
        )
          throw Error("RESULT_CHANGED");
        if (r.action === "stop") {
          if (
            !entry.relayStopped ||
            entry.relayAttempts !== original.relayAttempts ||
            !same(entry.relayObservation, original.relayObservation)
          )
            throw Error("RESULT_CHANGED");
        } else {
          const receipt = privateRelayStorageReceiptSchema.parse(
            result.transport?.receipt,
          );
          if (
            result.transport?.transportOnly !== true ||
            entry.relayStopped ||
            entry.relayAttempts !== original.relayAttempts + 1 ||
            entry.relayObservation?.attempt !== entry.relayAttempts ||
            !same(receipt, entry.relayObservation.receipt)
          )
            throw Error("RESULT_CHANGED");
        }
        if (this.status)
          this.status = {
            ...this.status,
            items: this.status.items.map((e) =>
              e.id === entry.id && e.permissionId === entry.permissionId
                ? entry
                : e,
            ),
          };
        this.notice =
          r.action === "stop"
            ? "Further uploads stopped on this Mac. Copies already sent remain."
            : "Server storage recorded. Recipient storage, reading and task completion are separate.";
      }
    });
  }
}
