import { z } from "zod";
import { BrowserConversationConsent } from "./browser-conversation-consent.js";
import { browserKeyScope } from "./browser-key-state.js";
import { browserReplayCoverageMatches } from "./browser-key-lifecycle.js";
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import {
  browserStorageTransaction,
  type BrowserStorageIO,
} from "./browser-storage.js";
import {
  browserPrivateDigest,
  browserPrivateIdentity,
  browserPrivateChannel,
  browserOutboxChannelSchema,
  reserveBrowserSequence,
} from "./browser-outbox-state.js";
import { consumeBrowserIncomingReplay } from "./browser-incoming-replay.js";
import { privateReplayIdentity } from "./private-replay.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  conversationContentSchema,
  conversationReceiptSchema,
  type ConversationContent,
} from "./private-conversation-contracts.js";
import {
  privateEnvelopeSchema,
  privateEnvelopeSuite,
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateHeader,
  type PrivateEnvelope,
} from "./private-envelope.js";
import {
  readBrowserConversationRow,
  sealBrowserConversationRow,
  openBrowserConversationRow,
  type BrowserConversationRow as Row,
  type BrowserConversationEntry as Entry,
  type BrowserConversationValue as Value,
} from "./browser-conversation-content-state.js";

const storeName = "conversation_content";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Handle = Awaited<ReturnType<BrowserConversationConsent["authorize"]>>;
type Summary = ReturnType<typeof summary>;
const authority = (grant: Handle["grant"]) => {
  const { revision: _revision, relayAcknowledgement: _relay, ...proof } = grant;
  return proof;
};
type Guard = {
  generation: number;
  wall: number;
  mono: number;
  binding: PrivateBinding;
};
type Snapshot = { rows: (Row | null)[]; sequence: number };
export class BrowserConversationContentError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "PARENT_PENDING"
      | "CAPACITY"
      | "BUSY"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
function fail(code: BrowserConversationContentError["code"] = "DENIED"): never {
  throw new BrowserConversationContentError(code);
}
function normalize(e: unknown): Error {
  if (e instanceof BrowserConversationContentError) return e;
  if (e instanceof z.ZodError)
    return new BrowserConversationContentError("DENIED");
  if (
    e instanceof Error &&
    [
      "DENIED",
      "CONFLICT",
      "PARENT_PENDING",
      "CAPACITY",
      "BUSY",
      "STORAGE_UNAVAILABLE",
    ].includes(e.message)
  )
    return new BrowserConversationContentError(
      e.message as BrowserConversationContentError["code"],
    );
  return new BrowserConversationContentError(
    e instanceof DOMException && e.name === "QuotaExceededError"
      ? "CAPACITY"
      : "STORAGE_UNAVAILABLE",
  );
}
function direction(
  v: Value,
): Parameters<BrowserConversationConsent["authorize"]>[2] {
  return v.direction === "incoming"
    ? v.content.type === "conversation.question"
      ? "questionsToBrowser"
      : "messagesToBrowser"
    : v.content.type === "conversation.answer"
      ? "answersToMac"
      : "messagesToMac";
}
function summary(e: Entry) {
  return {
    id: e.value.content.id,
    grantId: e.value.grant.id,
    revision: e.row.revision,
    direction: e.value.direction,
    kind: e.value.content.type,
    state: e.value.state,
    expiresAt: e.value.header.expiresAt,
    recipientAccepted:
      e.value.direction === "outgoing" && !!e.value.receiptEnvelope,
    recipientAcceptedAt:
      e.value.direction === "outgoing"
        ? (e.value.receipt?.acceptedAt ?? null)
        : null,
  };
}
/** Internal browser engine. All content, sequence and replay effects use the
 * common private database. No network, automatic send or runtime authority import. */
export class BrowserConversationContent {
  private closed = false;
  private busy = false;
  private generation = 0;
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => PrivateBinding | null,
    private consent: BrowserConversationConsent,
    private now: () => number,
    private mono: () => number,
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
      this.invalidate();
    };
  }
  static async open(
    owner: string,
    current: () => PrivateBinding | null,
    consent: BrowserConversationConsent,
    now = Date.now,
    mono = () => performance.now(),
  ) {
    const scope = await browserKeyScope(owner);
    return new BrowserConversationContent(
      await openBrowserPrivateDatabase(),
      owner,
      scope,
      current,
      consent,
      now,
      mono,
    );
  }
  invalidate() {
    this.generation++;
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private check(g: Guard) {
    const n = this.now(),
      elapsed = this.mono() - g.mono;
    if (this.closed) fail("STORAGE_UNAVAILABLE");
    if (
      this.generation !== g.generation ||
      !same(this.current(), g.binding) ||
      !Number.isSafeInteger(n) ||
      n < g.wall ||
      n >= g.binding.expiresAt ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= Math.min(120000, g.binding.expiresAt - g.wall)
    )
      fail();
  }
  private async operation<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    try {
      const g = {
        generation: this.generation,
        wall: this.now(),
        mono: this.mono(),
        binding: privateBindingSchema.parse(this.current()),
      };
      this.check(g);
      const result = await fn(g);
      this.check(g);
      return result;
    } catch (e) {
      throw normalize(e);
    } finally {
      this.busy = false;
    }
  }
  private async authorize(
    g: Guard,
    grantId: string,
    desired: Parameters<BrowserConversationConsent["authorize"]>[2],
  ) {
    const status = await this.consent.status(),
      grant = status.grants.find((v) => v.id === grantId);
    if (!grant) fail();
    const h = await this.consent.authorize(
      grantId,
      grant.choices.scope,
      desired,
    );
    this.check(g);
    if (!same(h.grant.local.binding, g.binding)) fail();
    return h;
  }
  private tx<T>(
    g: Guard,
    h: Handle,
    mode: IDBTransactionMode,
    work: (io: BrowserStorageIO<T>) => void,
  ) {
    return browserStorageTransaction<T>(
      this.db,
      [...new Set([...h.stores, storeName, "channels"])],
      mode,
      () => {
        this.check(g);
        h.check();
      },
      (io) =>
        h.validate(io, () => {
          io.request(io.store("lifecycle").get(this.scope), (state) =>
            io.request(
              io.store("slots").get([this.scope, h.grant.local.keyId]),
              (record) => {
                if (
                  !browserReplayCoverageMatches(state, record, h.grant.local, {
                    localOwner: this.owner,
                    scope: this.scope,
                    binding: g.binding,
                    now: this.now(),
                  })
                )
                  fail();
                work(io);
              },
            ),
          );
        }),
      normalize,
    );
  }
  private id(h: Handle, id: string) {
    return browserPrivateDigest([
      "browser-conversation-content:v1",
      this.scope,
      h.grant.local.binding.ownerId,
      h.grant.choices.scope.conversationRef,
      id,
    ]);
  }
  private async route(g: Guard, h: Handle) {
    const identity = await browserPrivateIdentity(g.binding);
    const channel = await browserPrivateChannel(identity, {
      senderKeyEpoch: h.grant.local.keyEpoch,
      peerId: h.grant.choices.peerId,
      peerKeyEpoch: h.grant.choices.peerKeyEpoch,
    });
    this.check(g);
    h.check();
    return { identity, channel };
  }
  private rows<T>(
    io: BrowserStorageIO<T>,
    ids: (string | null)[],
    done: (rows: (Row | null)[]) => void,
  ) {
    const rows: (Row | null)[] = [];
    const next = (i: number) => {
      if (i === ids.length) {
        done(rows);
        return;
      }
      const id = ids[i];
      if (!id) {
        rows.push(null);
        next(i + 1);
        return;
      }
      io.request(io.store(storeName).get([this.scope, id]), (raw) => {
        const row = raw === undefined ? null : readBrowserConversationRow(raw);
        if (row && (row.scope !== this.scope || row.id !== id))
          fail("STORAGE_UNAVAILABLE");
        rows.push(row);
        next(i + 1);
      });
    };
    next(0);
  }
  private snapshot(
    g: Guard,
    h: Handle,
    ids: (string | null)[],
    channel: string,
    replayScope: string,
  ): Promise<Snapshot> {
    return this.tx<Snapshot>(g, h, "readonly", (io) =>
      this.rows(io, ids, (rows) =>
        io.request(io.store("channels").get([replayScope, channel]), (raw) => {
          const record =
            raw === undefined
              ? { scope: replayScope, channel, next: 1 }
              : browserOutboxChannelSchema.parse(raw);
          if (record.scope !== replayScope || record.channel !== channel)
            fail("STORAGE_UNAVAILABLE");
          io.done({ rows, sequence: record.next });
        }),
      ),
    );
  }
  private checked(e: Entry, h: Handle, allowExpiredEnvelope = false) {
    if (
      !same(authority(e.value.grant), authority(h.grant)) ||
      (!allowExpiredEnvelope && e.value.header.expiresAt <= this.now()) ||
      e.value.header.issuedAt > this.now() + 30000
    )
      fail();
    h.check();
    return e;
  }
  private parent(e: Entry | null, h: Handle) {
    if (!e) fail("PARENT_PENDING");
    if (
      e.value.state === "preparing" ||
      e.value.grant.choices.peerId !== h.grant.choices.peerId ||
      e.value.header.ownerId !== h.grant.local.binding.ownerId ||
      e.value.content.scope.conversationRef !==
        h.grant.choices.scope.conversationRef
    )
      fail();
    return e;
  }
  private header(
    g: Guard,
    h: Handle,
    id: string,
    sequence: number,
    expiresAt: number,
  ): PrivateHeader {
    if (
      expiresAt <= this.now() ||
      expiresAt >
        Math.min(
          h.grant.choices.expiresAt,
          g.binding.expiresAt,
          this.now() + 86400000,
        )
    )
      fail();
    return {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: g.binding.ownerId,
      senderId: g.binding.deviceId,
      recipientId: h.grant.choices.peerId,
      senderKeyEpoch: h.grant.local.keyEpoch,
      recipientKeyEpoch: h.grant.choices.peerKeyEpoch,
      operationId: id,
      messageId: crypto.randomUUID(),
      sequence,
      issuedAt: this.now(),
      expiresAt,
    };
  }
  private fresh<T>(
    io: BrowserStorageIO<T>,
    row: Row,
    replayScope: string,
    channel: string,
    sequence: number,
    after: () => void,
  ) {
    io.request(
      io.store(storeName).index("scope").count(this.scope),
      (count) => {
        if (count >= 128) fail("CAPACITY");
        io.request(io.store(storeName).count(), (total) => {
          if (total >= 4096) fail("CAPACITY");
          reserveBrowserSequence(io, replayScope, channel, (actual) => {
            if (actual !== sequence) fail("CONFLICT");
            io.store(storeName).add(row);
            after();
          });
        });
      },
    );
  }
  /** Metadata only, under the selected current permission. Local decryption does
   * not publish plaintext; a separate explicit read revalidates the exact entry. */
  list(raw: unknown): Promise<Summary[]> {
    return this.operation(async (g) => {
      const input = z.strictObject({ grantId: z.uuid() }).parse(raw);
      const status = await this.consent.status();
      const grant = status.grants.find((value) => value.id === input.grantId);
      if (!grant) fail();
      const desired = (
        [
          "messagesToMac",
          "messagesToBrowser",
          "questionsToBrowser",
          "answersToMac",
        ] as const
      ).find((name) => grant.choices.permissions[name]);
      if (!desired) fail();
      const handle = await this.authorize(g, input.grantId, desired);
      const rows = await this.tx<Row[]>(g, handle, "readonly", (io) =>
        this.allRows(io, (values) => io.done(values)),
      );
      const entries = await Promise.all(rows.map(openBrowserConversationRow));
      const items = entries
        .filter((entry) =>
          same(authority(entry.value.grant), authority(handle.grant)),
        )
        .sort(
          (a, b) =>
            a.value.header.issuedAt - b.value.header.issuedAt ||
            a.value.content.id.localeCompare(b.value.content.id),
        )
        .map(summary);
      return this.tx<Summary[]>(g, handle, "readonly", (io) =>
        this.allRows(io, (current) => {
          if (!same(current, rows)) fail("CONFLICT");
          io.done(items);
        }),
      );
    });
  }
  prepare(raw: unknown): Promise<Summary> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          grantId: z.uuid(),
          id: z.uuid(),
          kind: z.enum(["message", "answer"]),
          parentId: z.uuid().nullable(),
          content: z.string().min(1).max(32000),
          expiresAt: positive,
          confirmed: z.literal(true),
        })
        .parse(raw);
      const h = await this.authorize(
        g,
        input.grantId,
        input.kind === "answer" ? "answersToMac" : "messagesToMac",
      );
      const { identity, channel } = await this.route(g, h),
        id = await this.id(h, input.id),
        parentId = input.parentId ? await this.id(h, input.parentId) : null;
      const snapshot = await this.snapshot(
        g,
        h,
        [id, parentId],
        channel,
        identity.scope,
      );
      const old = snapshot.rows[0]
        ? await openBrowserConversationRow(snapshot.rows[0])
        : null;
      const parent = input.parentId
        ? this.parent(
            snapshot.rows[1]
              ? await openBrowserConversationRow(snapshot.rows[1])
              : null,
            h,
          )
        : null;
      const requestHash = await browserPrivateDigest(input);
      if (old) {
        this.checked(old, h);
        if (
          old.value.direction !== "outgoing" ||
          old.value.requestHash !== requestHash
        )
          fail("CONFLICT");
        return this.tx(g, h, "readonly", (io) =>
          this.rows(io, [id, parentId], (rows) => {
            if (!same(rows, snapshot.rows)) fail("CONFLICT");
            io.done(summary(old));
          }),
        );
      }
      let content: ConversationContent;
      if (input.kind === "answer") {
        const q = parent?.value.content;
        if (
          !q ||
          q.type !== "conversation.question" ||
          parent!.value.direction !== "incoming" ||
          q.deadline <= this.now() ||
          input.expiresAt > q.deadline
        )
          fail();
        content = conversationContentSchema.parse({
          version: 1,
          type: "conversation.answer",
          scope: h.grant.choices.scope,
          id: input.id,
          taskId: q.taskId,
          questionId: q.id,
          expectedRevision: q.taskRevision,
          content: input.content,
          confirmed: true,
        });
      } else
        content = conversationContentSchema.parse({
          version: 1,
          type: "conversation.message",
          scope: h.grant.choices.scope,
          id: input.id,
          parentId: input.parentId,
          content: input.content,
        });
      const value: Value = {
        direction: "outgoing",
        state: "preparing",
        grant: h.grant,
        content,
        header: this.header(g, h, input.id, snapshot.sequence, input.expiresAt),
        envelope: null,
        receipt: null,
        receiptHeader: null,
        receiptEnvelope: null,
        requestHash,
      };
      const row = await sealBrowserConversationRow(
        { scope: this.scope, id, deviceHash: identity.deviceHash, revision: 1 },
        value,
      );
      return this.tx(g, h, "readwrite", (io) =>
        this.rows(io, [id, parentId], (rows) => {
          if (!same(rows, snapshot.rows)) fail("CONFLICT");
          if (value.header.expiresAt <= this.now()) fail();
          this.fresh(io, row, identity.scope, channel, snapshot.sequence, () =>
            io.done(summary({ row, value })),
          );
        }),
      );
    });
  }
  private async retained(
    g: Guard,
    grantId: string,
    wireId: string,
    desired?: Parameters<BrowserConversationConsent["authorize"]>[2],
    allowExpiredEnvelope = false,
  ) {
    const status = await this.consent.status(),
      grant = status.grants.find((v) => v.id === grantId);
    if (!grant) fail();
    const id = await browserPrivateDigest([
      "browser-conversation-content:v1",
      this.scope,
      grant.local.binding.ownerId,
      grant.choices.scope.conversationRef,
      wireId,
    ]);
    const raw = await browserStorageTransaction<Row | null>(
      this.db,
      [storeName],
      "readonly",
      () => this.check(g),
      (io) => this.rows(io, [id], (rows) => io.done(rows[0]!)),
      normalize,
    );
    if (!raw) fail();
    const e = await openBrowserConversationRow(raw),
      h = await this.authorize(g, grantId, desired ?? direction(e.value));
    this.checked(e, h, allowExpiredEnvelope);
    return { e, h, id };
  }
  envelope(raw: unknown): Promise<PrivateEnvelope> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          grantId: z.uuid(),
          id: z.uuid(),
          expectedRevision: positive,
          confirmed: z.literal(true),
        })
        .parse(raw);
      const { e, h, id } = await this.retained(g, input.grantId, input.id);
      if (e.row.revision !== input.expectedRevision) fail("CONFLICT");
      const incoming = e.value.direction === "incoming",
        existing = incoming ? e.value.receiptEnvelope : e.value.envelope;
      if (existing)
        return this.tx(g, h, "readonly", (io) =>
          this.rows(io, [id], (rows) => {
            if (!same(rows[0], e.row)) fail("CONFLICT");
            io.done(structuredClone(existing));
          }),
        );
      const header = incoming ? e.value.receiptHeader! : e.value.header;
      const bytes = new TextEncoder().encode(
        JSON.stringify(incoming ? e.value.receipt : e.value.content),
      );
      try {
        const envelope = await sealPrivateEnvelope(
          header,
          bytes,
          { senderKey: h.localKey, recipientPublicKey: h.peerPublicKey },
          this.now,
        );
        const value = structuredClone(e.value);
        if (incoming) value.receiptEnvelope = envelope;
        else {
          value.envelope = envelope;
          value.state = "ready";
        }
        if (e.row.revision >= Number.MAX_SAFE_INTEGER) fail("CAPACITY");
        const row = await sealBrowserConversationRow(
          { ...e.row, revision: e.row.revision + 1 },
          value,
          e.row.key,
        );
        return this.tx(g, h, "readwrite", (io) =>
          this.rows(io, [id], (rows) => {
            this.checked(e, h);
            if (!same(rows[0], e.row)) fail("CONFLICT");
            io.store(storeName).put(row);
            io.done(envelope);
          }),
        );
      } finally {
        bytes.fill(0);
      }
    });
  }
  /** Authenticate recipient storage only. The original outgoing content and
   * ciphertext remain intact; no task, parent, queue or outgoing sequence effect. */
  reconcile(
    raw: unknown,
  ): Promise<{
    status: "recipient-storage-confirmed";
    duplicate: boolean;
    entry: Summary;
  }> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          grantId: z.uuid(),
          id: z.uuid(),
          expectedRevision: positive,
          envelope: privateEnvelopeSchema,
          confirmed: z.literal(true),
        })
        .parse(raw);
      const { e, h, id } = await this.retained(g, input.grantId, input.id);
      if (e.row.revision !== input.expectedRevision) fail("CONFLICT");
      const v = e.value,
        header = input.envelope.header;
      if (
        v.direction !== "outgoing" ||
        v.state !== "ready" ||
        !v.envelope ||
        header.operationId !== v.content.id ||
        header.ownerId !== v.header.ownerId ||
        header.senderId !== v.header.recipientId ||
        header.recipientId !== v.header.senderId ||
        header.senderKeyEpoch !== v.header.recipientKeyEpoch ||
        header.recipientKeyEpoch !== v.header.senderKeyEpoch ||
        header.issuedAt < v.header.issuedAt - 30000 ||
        header.expiresAt > v.header.expiresAt
      )
        fail();
      const opened = await openPrivateEnvelope(
        input.envelope,
        header,
        { recipientKey: h.localKey, senderPublicKey: h.peerPublicKey },
        this.now,
      );
      let receipt: z.infer<typeof conversationReceiptSchema>;
      try {
        receipt = conversationReceiptSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        );
      } finally {
        opened.plaintext.fill(0);
      }
      if (
        receipt.acceptedId !== v.content.id ||
        receipt.operationId !== v.content.id ||
        receipt.acceptedType !== v.content.type ||
        !same(receipt.scope, v.content.scope) ||
        receipt.acceptedAt < v.header.issuedAt - 30000 ||
        receipt.acceptedAt >= v.header.expiresAt ||
        receipt.acceptedAt > header.issuedAt + 30000 ||
        receipt.acceptedAt > this.now() + 30000
      )
        fail();
      const { identity } = await this.route(g, h);
      const replay = await privateReplayIdentity(input.envelope, receipt.type);
      const duplicate = !!v.receiptEnvelope;
      if (
        duplicate &&
        (!same(v.receiptEnvelope, input.envelope) || !same(v.receipt, receipt))
      )
        fail("CONFLICT");
      if (!duplicate && e.row.revision >= Number.MAX_SAFE_INTEGER)
        fail("CAPACITY");
      const value: Value = duplicate
        ? v
        : {
            ...v,
            receipt,
            receiptHeader: header,
            receiptEnvelope: input.envelope,
          };
      const row = duplicate
        ? e.row
        : await sealBrowserConversationRow(
            { ...e.row, revision: e.row.revision + 1 },
            value,
            e.row.key,
          );
      return this.tx(g, h, "readwrite", (io) =>
        this.rows(io, [id], (rows) => {
          const check = () => {
            this.check(g);
            this.checked(e, h);
            if (header.expiresAt <= this.now()) fail();
          };
          check();
          if (!same(rows[0], e.row)) fail("CONFLICT");
          consumeBrowserIncomingReplay(
            io,
            identity.scope,
            replay,
            { store: storeName, key: [this.scope, id] },
            duplicate,
            (state) => {
              if (state !== (duplicate ? "duplicate" : "new")) fail("CONFLICT");
              check();
              const done = () => {
                check();
                io.done({
                  status: "recipient-storage-confirmed" as const,
                  duplicate,
                  entry: summary({ row, value }),
                });
              };
              if (duplicate) done();
              else io.request(io.store(storeName).put(row), done);
            },
          );
        }),
      );
    });
  }
  read(raw: unknown): Promise<Summary & { content: ConversationContent }> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({ grantId: z.uuid(), id: z.uuid() })
        .parse(raw);
      const { e, h, id } = await this.retained(
        g,
        input.grantId,
        input.id,
        undefined,
        true,
      );
      return this.tx(g, h, "readonly", (io) =>
        this.rows(io, [id], (rows) => {
          if (!same(rows[0], e.row)) fail("CONFLICT");
          io.done({ ...summary(e), content: structuredClone(e.value.content) });
        }),
      );
    });
  }
  accept(raw: unknown): Promise<{ duplicate: boolean; entry: Summary }> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          grantId: z.uuid(),
          envelope: privateEnvelopeSchema,
          confirmed: z.literal(true),
        })
        .parse(raw);
      const status = await this.consent.status(),
        grant = status.grants.find((v) => v.id === input.grantId);
      if (!grant) fail();
      let h = await this.authorize(
        g,
        input.grantId,
        grant.choices.permissions.messagesToBrowser
          ? "messagesToBrowser"
          : "questionsToBrowser",
      );
      const openedAuthority = authority(h.grant);
      const header = input.envelope.header;
      if (
        header.ownerId !== g.binding.ownerId ||
        header.senderId !== h.grant.choices.peerId ||
        header.recipientId !== g.binding.deviceId ||
        header.senderKeyEpoch !== h.grant.choices.peerKeyEpoch ||
        header.recipientKeyEpoch !== h.grant.local.keyEpoch ||
        header.expiresAt > h.grant.choices.expiresAt
      )
        fail();
      const opened = await openPrivateEnvelope(
        input.envelope,
        header,
        { recipientKey: h.localKey, senderPublicKey: h.peerPublicKey },
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
        content.type === "conversation.answer" ||
        content.id !== header.operationId ||
        !same(content.scope, h.grant.choices.scope)
      )
        fail();
      h = await this.authorize(
        g,
        input.grantId,
        content.type === "conversation.question"
          ? "questionsToBrowser"
          : "messagesToBrowser",
      );
      if (!same(openedAuthority, authority(h.grant))) fail();
      if (
        content.type === "conversation.question" &&
        (content.deadline <= this.now() || header.expiresAt > content.deadline)
      )
        fail();
      const { identity, channel } = await this.route(g, h),
        id = await this.id(h, content.id);
      const parentId =
        content.type === "conversation.message" && content.parentId
          ? await this.id(h, content.parentId)
          : null;
      const snapshot = await this.snapshot(
        g,
        h,
        [id, parentId],
        channel,
        identity.scope,
      );
      if (parentId)
        this.parent(
          snapshot.rows[1]
            ? await openBrowserConversationRow(snapshot.rows[1])
            : null,
          h,
        );
      const replay = await privateReplayIdentity(input.envelope, content.type);
      if (snapshot.rows[0]) {
        const e = this.checked(
          await openBrowserConversationRow(snapshot.rows[0]),
          h,
        );
        if (
          e.value.direction !== "incoming" ||
          !same(e.value.envelope, input.envelope) ||
          !same(e.value.content, content)
        )
          fail("CONFLICT");
        return this.tx(g, h, "readwrite", (io) =>
          this.rows(io, [id, parentId], (rows) => {
            if (!same(rows, snapshot.rows)) fail("CONFLICT");
            consumeBrowserIncomingReplay(
              io,
              identity.scope,
              replay,
              { store: storeName, key: [this.scope, id] },
              true,
              (state) => {
                if (state !== "duplicate") fail("CONFLICT");
                io.done({ duplicate: true, entry: summary(e) });
              },
            );
          }),
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
      const value: Value = {
        direction: "incoming",
        state: "accepted",
        grant: h.grant,
        content,
        header,
        envelope: input.envelope,
        receipt,
        receiptHeader: this.header(
          g,
          h,
          content.id,
          snapshot.sequence,
          header.expiresAt,
        ),
        receiptEnvelope: null,
        requestHash: await browserPrivateDigest(input.envelope),
      };
      const row = await sealBrowserConversationRow(
        { scope: this.scope, id, deviceHash: identity.deviceHash, revision: 1 },
        value,
      );
      return this.tx(g, h, "readwrite", (io) =>
        this.rows(io, [id, parentId], (rows) => {
          if (!same(rows, snapshot.rows)) fail("CONFLICT");
          if (header.expiresAt <= this.now()) fail();
          consumeBrowserIncomingReplay(
            io,
            identity.scope,
            replay,
            { store: storeName, key: [this.scope, id] },
            false,
            (state) => {
              if (state !== "new") fail("CONFLICT");
              this.fresh(
                io,
                row,
                identity.scope,
                channel,
                snapshot.sequence,
                () =>
                  io.done({ duplicate: false, entry: summary({ row, value }) }),
              );
            },
          );
        }),
      );
    });
  }

  private allRows<T>(io: BrowserStorageIO<T>, done: (rows: Row[]) => void) {
    io.request(
      io.store(storeName).index("scope").getAll(this.scope, 129),
      (raw) => {
        if (raw.length > 128) fail("CAPACITY");
        const rows = raw.map(readBrowserConversationRow);
        if (rows.some((r) => r.scope !== this.scope))
          fail("STORAGE_UNAVAILABLE");
        done(rows);
      },
    );
  }
  /** Owner archive only, never an authority import or a retained CryptoKey export.
   * Delivery TTL does not delete retained content. A currently verified matching
   * account and explicit export confirmation are required for plaintext export. */
  export(raw: unknown): Promise<{
    version: 1;
    restoreAuthority: false;
    items: (Summary & {
      content: ConversationContent;
      envelope: PrivateEnvelope | null;
      receiptEnvelope: PrivateEnvelope | null;
    })[];
  }> {
    return this.operation(async (g) => {
      z.strictObject({ confirmed: z.literal(true) }).parse(raw);
      const rows = await browserStorageTransaction<Row[]>(
        this.db,
        [storeName],
        "readonly",
        () => this.check(g),
        (io) => this.allRows(io, (rows) => io.done(rows)),
        normalize,
      );
      const entries = await Promise.all(rows.map(openBrowserConversationRow));
      const items = entries
        .filter((e) => e.value.header.ownerId === g.binding.ownerId)
        .map((e) => ({
          ...summary(e),
          content: structuredClone(e.value.content),
          envelope: e.value.envelope,
          receiptEnvelope: e.value.receiptEnvelope,
        }));
      return browserStorageTransaction<{
        version: 1;
        restoreAuthority: false;
        items: typeof items;
      }>(
        this.db,
        [storeName],
        "readonly",
        () => this.check(g),
        (io) =>
          this.allRows(io, (current) => {
            if (!same(current, rows)) fail("CONFLICT");
            io.done({
              version: 1 as const,
              restoreAuthority: false as const,
              items,
            });
          }),
        normalize,
      );
    });
  }
  /** Explicit local deletion locks independent conversation consent in the same
   * transaction. Hash-only shared replay fences remain; deleted outcomes cannot
   * be recreated by replay. No active key/permission is restored or broadened. */
  async clear(raw: unknown) {
    const input = z
      .strictObject({
        expectedConsentRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        confirmed: z.literal(true),
      })
      .parse(raw);
    if (this.busy) fail("BUSY");
    this.invalidate();
    this.busy = true;
    const generation = this.generation,
      wall = this.now(),
      mono = this.mono();
    const check = () => {
      const n = this.now(),
        elapsed = this.mono() - mono;
      if (
        this.closed ||
        generation !== this.generation ||
        !Number.isSafeInteger(n) ||
        n < wall ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= 120000
      )
        fail();
    };
    try {
      return await browserStorageTransaction<{
        removed: number;
        consentRevision: number;
      }>(
        this.db,
        [storeName, "conversation_consents"],
        "readwrite",
        check,
        (io) => {
          io.request(
            io.store("conversation_consents").get(this.scope),
            (raw) => {
              const record =
                raw === undefined
                  ? null
                  : z
                      .object({
                        scope: z.string().regex(/^[a-f0-9]{64}$/),
                        deviceHash: z.string().regex(/^[a-f0-9]{64}$/),
                        revision: positive,
                      })
                      .parse(raw);
              if (record && record.scope !== this.scope)
                fail("STORAGE_UNAVAILABLE");
              if ((record?.revision ?? 0) !== input.expectedConsentRevision)
                fail("CONFLICT");
              if (record && record.revision >= Number.MAX_SAFE_INTEGER)
                fail("CAPACITY");
              io.request(
                io.store(storeName).index("scope").getAllKeys(this.scope),
                (keys) => {
                  if (record)
                    io.store("conversation_consents").put({
                      ...record,
                      revision: record.revision + 1,
                      locked: true,
                      iv: null,
                      ciphertext: null,
                      key: null,
                    });
                  for (const key of keys) io.store(storeName).delete(key);
                  io.done({
                    removed: keys.length,
                    consentRevision: record ? record.revision + 1 : 0,
                  });
                },
              );
            },
          );
        },
        normalize,
      );
    } catch (e) {
      throw normalize(e);
    } finally {
      this.busy = false;
    }
  }
}
