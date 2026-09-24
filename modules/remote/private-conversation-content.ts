import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  PrivateConversationConsent,
  privateConversationGrantSchema,
} from "./private-conversation-consent.js";
import type { PrivateKeyLifecycle } from "./private-key-lifecycle.js";
import {
  conversationContentSchema,
  conversationReceiptSchema,
  type ConversationContent,
} from "./private-conversation-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateHeader,
} from "./private-envelope.js";
import { privateReplayIdentity } from "./private-replay.js";
import { consumePrivateIncomingReplay } from "./private-incoming-replay.js";
import { reservePrivateSequence } from "./private-send-sequence.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const conversationPrepareInputSchema = z.strictObject({
  id: z.uuid(),
  permissionId: z.uuid(),
  expectedConsentRevision: positive,
  localMessageId: z.uuid(),
  parentId: z.uuid().nullable(),
  kind: z.enum(["message", "question"]),
  expiresAt: positive,
  confirmed: z.literal(true),
});
export const conversationSealInputSchema = z.strictObject({
  permissionId: z.uuid(),
  id: z.uuid(),
  expectedRevision: positive,
  confirmed: z.literal(true),
});
export const conversationReceiveInputSchema = z.strictObject({
  permissionId: z.uuid(),
  envelope: privateEnvelopeSchema,
  confirmed: z.literal(true),
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const valueSchema = z
  .strictObject({
    direction: z.enum(["incoming", "outgoing"]),
    state: z.enum(["preparing", "ready", "accepted"]),
    grant: privateConversationGrantSchema,
    content: conversationContentSchema,
    localMessageId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    header: privateHeaderSchema,
    envelope: privateEnvelopeSchema.nullable(),
    receipt: conversationReceiptSchema.nullable(),
    receiptHeader: privateHeaderSchema.nullable(),
    receiptEnvelope: privateEnvelopeSchema.nullable(),
  })
  .refine(
    (v) =>
      v.content.id === v.header.operationId &&
      v.content.scope.permissionId === v.grant.id &&
      v.content.scope.conversationRef === v.grant.conversationRef &&
      v.header.ownerId === v.grant.local.binding.ownerId &&
      (!v.envelope || same(v.envelope.header, v.header)) &&
      (v.direction === "incoming"
        ? v.state === "accepted" &&
          !!v.envelope &&
          !!v.receipt &&
          !!v.receiptHeader &&
          v.receipt.acceptedId === v.content.id &&
          v.receipt.acceptedType === v.content.type &&
          v.receipt.operationId === v.content.id &&
          same(v.receipt.scope, v.content.scope) &&
          v.receiptHeader.operationId === v.content.id &&
          v.header.senderId === v.grant.choices.peerId &&
          v.header.senderKeyEpoch === v.grant.choices.peerKeyEpoch &&
          v.header.recipientId === v.grant.local.binding.deviceId &&
          v.header.recipientKeyEpoch === v.grant.local.keyEpoch &&
          v.receiptHeader.senderId === v.header.recipientId &&
          v.receiptHeader.recipientId === v.header.senderId &&
          v.receiptHeader.senderKeyEpoch === v.header.recipientKeyEpoch &&
          v.receiptHeader.recipientKeyEpoch === v.header.senderKeyEpoch &&
          v.receiptHeader.ownerId === v.header.ownerId &&
          (!v.receiptEnvelope ||
            same(v.receiptEnvelope.header, v.receiptHeader))
        : v.state !== "accepted" &&
          !v.receipt &&
          !v.receiptHeader &&
          !v.receiptEnvelope &&
          (v.state === "ready" ? !!v.envelope : !v.envelope) &&
          v.header.senderId === v.grant.local.binding.deviceId &&
          v.header.senderKeyEpoch === v.grant.local.keyEpoch &&
          v.header.recipientId === v.grant.choices.peerId &&
          v.header.recipientKeyEpoch === v.grant.choices.peerKeyEpoch),
  );
type Value = z.infer<typeof valueSchema>;
type Entry = { id: string; revision: number; locked: boolean; value: Value };
type Handle = Awaited<ReturnType<PrivateConversationConsent["resolve"]>>;
type Grant = z.infer<typeof privateConversationGrantSchema>;
/** Host-owned source and dependency checks. Never accept this from a request.
 * Resolve asynchronous source access before the write; returned check must
 * synchronously revalidate captured source/dependency authority under the lock.
 * Task revision is separately checked here and by Store.answerInput. */
export type ConversationTaskAccess = (taskId: string) => Promise<() => void>;
export class ConversationContentError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "PARENT_PENDING"
      | "CAPACITY"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
const fail = (
  code: ConstructorParameters<typeof ConversationContentError>[0] = "DENIED",
): never => {
  throw new ConversationContentError(code);
};
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-conversation-content:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
const index = (
  vault: Vault,
  owner: Owner,
  account: string,
  ref: string,
  id: string,
) =>
  vault.fingerprint([
    "private-conversation-content:v1",
    owner,
    account,
    ref,
    id,
  ]);
const limit = 128;
function read(
  store: Store,
  vault: Vault,
  owner: Owner,
  id: string,
): Entry | null {
  const row = store.db
    .prepare(
      "SELECT revision,locked,payload FROM private_conversation_content WHERE user_id=? AND tenant_id=? AND id_hash=?",
    )
    .get(owner.userId, owner.tenantId, id) as
    { revision: number; locked: number; payload: Buffer } | undefined;
  if (!row) return null;
  try {
    if (
      !positive.safeParse(row.revision).success ||
      ![0, 1].includes(row.locked) ||
      !Buffer.isBuffer(row.payload) ||
      row.payload.length > 200000
    )
      fail();
    const value = valueSchema.parse(
      vault.open(row.payload, purpose(owner, id)),
    );
    if (
      index(
        vault,
        owner,
        value.header.ownerId,
        value.content.scope.conversationRef,
        value.content.id,
      ) !== id
    )
      fail();
    return { id, revision: row.revision, locked: row.locked === 1, value };
  } catch {
    return fail("STORAGE_UNAVAILABLE");
  }
}
export function exportPrivateConversationContent(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id_hash FROM private_conversation_content WHERE user_id=? AND tenant_id=? ORDER BY id_hash LIMIT ?",
    )
    .all(owner.userId, owner.tenantId, limit + 1) as { id_hash: string }[];
  if (rows.length > limit) fail("CAPACITY");
  return rows.map((r) => read(store, vault, owner, r.id_hash)!);
}
/** Internal content engine, not a route or scheduler. All incoming Inbox,
 * answer/wait, sequence, journal and common replay effects share one transaction.
 * No source authority is inferred from conversation permission. */
export class PrivateConversationContent {
  private inflight = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private consent: PrivateConversationConsent,
    private keys: PrivateKeyLifecycle,
    private taskAccess: ConversationTaskAccess = async () => fail(),
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  private async bounded<T>(fn: () => Promise<T>) {
    if (this.inflight >= 4) fail("CAPACITY");
    this.inflight++;
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await fn();
    } finally {
      this.inflight--;
      release();
    }
  }
  private id(g: Grant, id: string) {
    return index(
      this.vault,
      this.owner,
      g.local.binding.ownerId,
      g.conversationRef,
      id,
    );
  }
  private get(g: Grant, id: string) {
    return read(this.store, this.vault, this.owner, this.id(g, id));
  }
  private access(
    handle: Handle,
    scope: ConversationContent["scope"],
    direction:
      | "messagesToMac"
      | "messagesToBrowser"
      | "questionsToBrowser"
      | "answersToMac",
  ) {
    const p = handle.access(scope, direction);
    if (!p || !this.keys.validateReplayCoverage(p.grant.local)) return fail();
    return p;
  }
  private checked(e: Entry, handle: Handle) {
    const c = e.value.content,
      direction =
        e.value.direction === "incoming"
          ? c.type === "conversation.answer"
            ? "answersToMac"
            : "messagesToMac"
          : c.type === "conversation.question"
            ? "questionsToBrowser"
            : "messagesToBrowser";
    const p = this.access(handle, c.scope, direction);
    if (
      e.locked ||
      !same(e.value.grant, p.grant) ||
      e.value.header.expiresAt <= this.now() ||
      e.value.header.issuedAt > this.now() + 30000
    )
      return fail();
    return p;
  }
  private message(g: Grant, id: string) {
    const m = this.store.message(this.owner, id);
    if (
      m.input.conversationId !== g.choices.conversationId ||
      m.input.recipientInboxId !== g.choices.inboxId
    )
      return fail();
    return m;
  }
  private parent(g: Grant, wireId: string) {
    const e = this.get(g, wireId);
    if (!e) return fail("PARENT_PENDING");
    if (
      e.value.grant.choices.peerId !== g.choices.peerId ||
      e.value.grant.choices.conversationId !== g.choices.conversationId ||
      e.value.grant.choices.inboxId !== g.choices.inboxId ||
      e.value.state === "preparing"
    )
      return fail();
    return { entry: e, message: this.message(g, e.value.localMessageId) };
  }
  private async taskGuard(taskId: string | undefined) {
    if (!taskId) return { check: () => {}, revision: null };
    const before = this.store.get(this.owner, taskId),
      check = await this.taskAccess(taskId);
    if (typeof check !== "function") return fail();
    const inputHash = this.vault.fingerprint(before.input);
    return {
      revision: before.revision,
      check: () => {
        const current = this.store.get(this.owner, taskId);
        if (this.vault.fingerprint(current.input) !== inputHash) fail();
        check();
      },
    };
  }
  private capacity() {
    const row = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM private_conversation_content WHERE user_id=? AND tenant_id=?",
      )
      .get(this.owner.userId, this.owner.tenantId) as { count: number };
    if (row.count >= limit) fail("CAPACITY");
  }
  private write(e: Entry, fresh = false) {
    const payload = this.vault.seal(
      valueSchema.parse(e.value),
      purpose(this.owner, e.id),
    );
    if (payload.length > 200000 || e.revision >= Number.MAX_SAFE_INTEGER)
      fail("CAPACITY");
    if (fresh) {
      this.capacity();
      this.store.db
        .prepare("INSERT INTO private_conversation_content VALUES(?,?,?,?,?,?)")
        .run(
          this.owner.userId,
          this.owner.tenantId,
          e.id,
          e.revision,
          e.locked ? 1 : 0,
          payload,
        );
    } else {
      const r = this.store.db
        .prepare(
          "UPDATE private_conversation_content SET payload=?,revision=revision+1 WHERE user_id=? AND tenant_id=? AND id_hash=? AND revision=?",
        )
        .run(payload, this.owner.userId, this.owner.tenantId, e.id, e.revision);
      if (r.changes !== 1) fail("CONFLICT");
      e.revision++;
    }
  }
  private header(
    g: Grant,
    operationId: string,
    expiresAt: number,
  ): PrivateHeader {
    const route = {
      ownerId: g.local.binding.ownerId,
      senderId: g.local.binding.deviceId,
      recipientId: g.choices.peerId,
      senderKeyEpoch: g.local.keyEpoch,
      recipientKeyEpoch: g.choices.peerKeyEpoch,
    };
    if (
      expiresAt <= this.now() ||
      expiresAt > g.choices.expiresAt ||
      expiresAt > this.now() + 86400000
    )
      return fail();
    return privateHeaderSchema.parse({
      version: 1,
      suite: privateEnvelopeSuite,
      ...route,
      messageId: randomUUID(),
      operationId,
      sequence: reservePrivateSequence(
        this.store,
        this.vault,
        this.owner,
        route,
      ),
      issuedAt: this.now(),
      expiresAt,
    });
  }
  /** Share one existing local message; a question captures its exact live wait.
   * Client IDs are stable wire IDs, never arbitrary local Inbox selectors. */
  prepare(raw: unknown) {
    return this.bounded(async () => {
      const input = conversationPrepareInputSchema.parse(raw);
      const handle = await this.consent.resolve(input.permissionId),
        offered = handle.offerAccess();
      if (!offered) return fail();
      const g = offered.grant,
        m = this.message(g, input.localMessageId),
        guard = await this.taskGuard(m.input.requestId),
        requestHash = this.vault.fingerprint(input);
      return this.store.db
        .transaction(() => {
          const scope = {
            permissionId: g.id,
            conversationRef: g.conversationRef,
          };
          const check = () => {
            this.access(
              handle,
              scope,
              input.kind === "question"
                ? "questionsToBrowser"
                : "messagesToBrowser",
            );
            guard.check();
            if (
              !same(this.message(g, m.id).input, m.input) ||
              (m.input.requestId &&
                this.store.get(this.owner, m.input.requestId).revision !==
                  guard.revision)
            )
              fail("CONFLICT");
          };
          check();
          const old = this.get(g, input.id);
          if (old) {
            this.checked(old, handle);
            if (
              old.value.direction !== "outgoing" ||
              old.value.requestHash !== requestHash
            )
              fail("CONFLICT");
            return structuredClone(old);
          }
          if (this.consent.list().revision !== input.expectedConsentRevision)
            fail("CONFLICT");
          if (
            m.input.requestId &&
            this.store.get(this.owner, m.input.requestId).revision !==
              guard.revision
          )
            fail("CONFLICT");
          let content: ConversationContent;
          if (input.kind === "question") {
            if (input.parentId !== null || !m.input.requestId) return fail();
            const task = this.store.get(this.owner, m.input.requestId),
              wait = this.store
                .inputWaitHistory(this.owner, task.id)
                .find((w) => w.questionId === m.id);
            if (
              !wait ||
              wait.replyId ||
              !["paused", "awaiting_input"].includes(task.status) ||
              wait.deadline <= this.now() ||
              input.expiresAt > wait.deadline
            )
              return fail();
            content = conversationContentSchema.parse({
              version: 1,
              type: "conversation.question",
              scope,
              id: input.id,
              taskId: task.id,
              taskRevision: task.revision,
              content: m.input.content,
              deadline: wait.deadline,
            });
          } else {
            if (m.input.type === "clarification") return fail();
            const parent = input.parentId
              ? this.parent(g, input.parentId)
              : null;
            if (
              (m.input.replyToId ?? null) !== (parent?.message.id ?? null) ||
              (parent &&
                (m.input.requestId ?? null) !==
                  (parent.message.input.requestId ?? null))
            )
              return fail();
            content = conversationContentSchema.parse({
              version: 1,
              type: "conversation.message",
              scope,
              id: input.id,
              parentId: input.parentId,
              content: m.input.content,
            });
          }
          const e: Entry = {
            id: this.id(g, input.id),
            revision: 1,
            locked: false,
            value: {
              direction: "outgoing",
              state: "preparing",
              grant: g,
              content,
              localMessageId: m.id,
              requestHash,
              header: this.header(g, input.id, input.expiresAt),
              envelope: null,
              receipt: null,
              receiptHeader: null,
              receiptEnvelope: null,
            },
          };
          this.write(e, true);
          check();
          return structuredClone(e);
        })
        .immediate();
    });
  }
  /** Encrypt once after durable reservation. Concurrent finishers return only
   * the winning ciphertext; a retry never allocates another sequence. */
  seal(raw: unknown) {
    return this.bounded(async () => {
      const input = conversationSealInputSchema.parse(raw),
        handle = await this.consent.resolve(input.permissionId),
        p = handle.offerAccess();
      if (!p) return fail();
      const e = this.get(p.grant, input.id);
      if (!e) return fail();
      this.checked(e, handle);
      if (e.revision !== input.expectedRevision) fail("CONFLICT");
      const m = this.message(p.grant, e.value.localMessageId),
        guard = await this.taskGuard(m.input.requestId);
      const check = () => {
        const p = this.checked(e, handle);
        guard.check();
        const live = this.message(p.grant, e.value.localMessageId);
        if (live.input.content !== e.value.content.content) fail("CONFLICT");
        if (
          e.value.direction === "outgoing" &&
          m.input.requestId &&
          this.store.get(this.owner, m.input.requestId).revision !==
            guard.revision
        )
          fail("CONFLICT");
        if (
          e.value.direction === "outgoing" &&
          e.value.content.type === "conversation.question"
        ) {
          const c = e.value.content,
            task = this.store.get(this.owner, c.taskId),
            w = this.store
              .inputWaitHistory(this.owner, c.taskId)
              .find((w) => w.questionId === m.id);
          if (
            task.revision !== c.taskRevision ||
            !w ||
            w.replyId ||
            w.deadline !== c.deadline ||
            c.deadline <= this.now()
          )
            fail("CONFLICT");
        }
        return p;
      };
      const key = check(),
        incoming = e.value.direction === "incoming",
        old = incoming ? e.value.receiptEnvelope : e.value.envelope;
      if (old) return structuredClone(old);
      const header = incoming ? e.value.receiptHeader! : e.value.header,
        payload = incoming ? e.value.receipt! : e.value.content,
        bytes = new TextEncoder().encode(JSON.stringify(payload));
      try {
        const envelope = await sealPrivateEnvelope(
          header,
          bytes,
          { senderKey: key.localKey, recipientPublicKey: key.peerPublicKey },
          this.now,
        );
        return this.store.db
          .transaction(() => {
            const current = this.get(p.grant, input.id);
            if (!current) return fail();
            check();
            this.checked(current, handle);
            if (
              !same(current.value.content, e.value.content) ||
              !same(current.value.header, e.value.header)
            )
              fail("CONFLICT");
            const saved = incoming
              ? current.value.receiptEnvelope
              : current.value.envelope;
            if (saved) return structuredClone(saved);
            if (current.revision !== e.revision) fail("CONFLICT");
            if (incoming) current.value.receiptEnvelope = envelope;
            else {
              current.value.envelope = envelope;
              current.value.state = "ready";
            }
            this.write(current);
            check();
            return structuredClone(envelope);
          })
          .immediate();
      } finally {
        bytes.fill(0);
      }
    });
  }
  /** Authenticated messages and exact answers enter the existing Inbox only.
   * Missing parents consume no replay record or receipt. */
  accept(raw: unknown) {
    return this.bounded(async () => {
      const input = conversationReceiveInputSchema.parse(raw),
        handle = await this.consent.resolve(input.permissionId),
        p = handle.offerAccess();
      if (!p || !this.keys.validateReplayCoverage(p.grant.local)) return fail();
      const g = p.grant,
        h = input.envelope.header;
      if (
        h.ownerId !== g.local.binding.ownerId ||
        h.senderId !== g.choices.peerId ||
        h.senderKeyEpoch !== g.choices.peerKeyEpoch ||
        h.recipientId !== g.local.binding.deviceId ||
        h.recipientKeyEpoch !== g.local.keyEpoch ||
        h.expiresAt > g.choices.expiresAt
      )
        return fail();
      const opened = await openPrivateEnvelope(
        input.envelope,
        h,
        { recipientKey: p.localKey, senderPublicKey: p.peerPublicKey },
        this.now,
      );
      let content: ConversationContent;
      try {
        content = conversationContentSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        );
      } finally {
        opened.plaintext.fill(0);
      }
      if (
        content.type === "conversation.question" ||
        content.id !== h.operationId
      )
        return fail();
      const direction =
        content.type === "conversation.answer"
          ? "answersToMac"
          : "messagesToMac";
      this.access(handle, content.scope, direction);
      const replay = await privateReplayIdentity(input.envelope, content.type),
        parentId =
          content.type === "conversation.answer"
            ? content.questionId
            : content.parentId;
      const prior = this.get(g, content.id),
        parent = parentId ? this.parent(g, parentId) : null;
      const taskId = parent?.message.input.requestId,
        guard = await this.taskGuard(taskId);
      const check = () => {
        this.access(handle, content.scope, direction);
        guard.check();
        if (
          parentId &&
          !same(this.parent(g, parentId).message.input, parent?.message.input)
        )
          fail("CONFLICT");
        if (h.expiresAt <= this.now()) fail();
      };
      return this.store.db
        .transaction(() => {
          check();
          const current = this.get(g, content.id);
          if (current) {
            this.checked(current, handle);
            if (
              current.value.direction !== "incoming" ||
              !same(current.value.envelope, input.envelope) ||
              !same(current.value.content, content)
            )
              fail("CONFLICT");
            if (
              this.message(g, current.value.localMessageId).input.content !==
              content.content
            )
              fail("CONFLICT");
            if (
              consumePrivateIncomingReplay(
                this.store,
                this.vault,
                this.owner,
                replay,
                { collection: "messages", id: current.value.localMessageId },
              ) !== "duplicate"
            )
              fail("CONFLICT");
            check();
            return { entry: structuredClone(current), duplicate: true };
          }
          if (prior) fail("CONFLICT");
          const liveParent = parentId ? this.parent(g, parentId) : null;
          if (!same(liveParent?.message.input, parent?.message.input))
            fail("CONFLICT");
          if (
            taskId &&
            this.store.get(this.owner, taskId).revision !== guard.revision
          )
            fail("CONFLICT");
          this.capacity();
          let local;
          const key = "private-conversation:" + this.id(g, content.id);
          if (content.type === "conversation.answer") {
            const q = liveParent?.entry.value.content;
            if (
              !q ||
              q.type !== "conversation.question" ||
              liveParent!.entry.value.direction !== "outgoing" ||
              q.taskId !== content.taskId ||
              q.taskRevision !== content.expectedRevision ||
              taskId !== content.taskId ||
              q.deadline <= this.now()
            )
              return fail();
            local = this.store.answerInput(
              this.owner,
              content.taskId,
              {
                questionId: liveParent!.message.id,
                expectedRevision: content.expectedRevision,
                content: content.content,
              },
              key,
              check,
            ).reply;
          } else {
            local = this.store.appendMessage(
              this.owner,
              {
                conversationId: g.choices.conversationId,
                recipientInboxId: g.choices.inboxId,
                ...(liveParent ? { replyToId: liveParent.message.id } : {}),
                ...(taskId ? { requestId: taskId } : {}),
                type: liveParent ? "reply" : "notification",
                content: content.content,
              },
              key,
            );
          }
          const receipt = conversationReceiptSchema.parse({
            version: 1,
            type: "conversation.received",
            scope: content.scope,
            acceptedId: content.id,
            acceptedType: content.type,
            operationId: content.id,
            acceptedAt: this.now(),
          });
          const entry: Entry = {
            id: this.id(g, content.id),
            revision: 1,
            locked: false,
            value: {
              direction: "incoming",
              state: "accepted",
              grant: g,
              content,
              localMessageId: local.id,
              requestHash: this.vault.fingerprint(input.envelope),
              header: h,
              envelope: input.envelope,
              receipt,
              receiptHeader: this.header(g, content.id, h.expiresAt),
              receiptEnvelope: null,
            },
          };
          this.write(entry, true);
          if (
            consumePrivateIncomingReplay(
              this.store,
              this.vault,
              this.owner,
              replay,
              { collection: "messages", id: local.id },
            ) !== "new"
          )
            fail("CONFLICT");
          check();
          return { entry: structuredClone(entry), duplicate: false };
        })
        .immediate();
    });
  }
}
