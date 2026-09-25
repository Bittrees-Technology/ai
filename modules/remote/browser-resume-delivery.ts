import { consumeBrowserIncomingReplay } from "./browser-incoming-replay.js";
import { privateReplayIdentity } from "./private-replay.js";
import { privateResumeReceiptSchema } from "./private-resume-contracts.js";
import { z } from "zod";
import { BrowserResumeConsent } from "./browser-resume-consent.js";
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
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  privateEnvelopeSuite,
  privateEnvelopeSchema,
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateHeader,
  type PrivateEnvelope,
} from "./private-envelope.js";
import {
  readBrowserResumeDeliveryRow,
  sealBrowserResumeDeliveryRow,
  openBrowserResumeDeliveryRow,
  type BrowserResumeDeliveryRow as Row,
  type BrowserResumeDeliveryEntry as Entry,
  type BrowserResumeDeliveryValue as Value,
} from "./browser-resume-delivery-state.js";
const storeName = "resume_delivery";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Handle = Awaited<ReturnType<BrowserResumeConsent["authorize"]>>;
type Guard = {
  generation: number;
  wall: number;
  mono: number;
  binding: PrivateBinding;
  deliveryCheck: () => void;
};
type Snapshot = { rows: (Row | null)[]; sequence: number };
export class BrowserResumeDeliveryError extends Error {
  constructor(
    readonly code:
      "DENIED" | "CONFLICT" | "CAPACITY" | "BUSY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
function fail(code: BrowserResumeDeliveryError["code"] = "DENIED"): never {
  throw new BrowserResumeDeliveryError(code);
}
function normalize(e: unknown): Error {
  if (e instanceof BrowserResumeDeliveryError) return e;
  if (e instanceof z.ZodError) return new BrowserResumeDeliveryError("DENIED");
  if (
    e instanceof Error &&
    ["DENIED", "CONFLICT", "CAPACITY", "BUSY", "STORAGE_UNAVAILABLE"].includes(
      e.message,
    )
  )
    return new BrowserResumeDeliveryError(
      e.message as BrowserResumeDeliveryError["code"],
    );
  return new BrowserResumeDeliveryError(
    e instanceof DOMException && e.name === "QuotaExceededError"
      ? "CAPACITY"
      : "STORAGE_UNAVAILABLE",
  );
}
function summary(e: Entry) {
  return {
    id: e.value.request.command.id,
    grantId: e.value.grant.id,
    revision: e.row.revision,
    state: e.value.state,
    stopped: e.value.stopped,
    taskId: e.value.grant.choices.taskId,
    taskRevision: e.value.grant.choices.taskRevision,
    modelDigest: e.value.grant.choices.modelDigest,
    peerId: e.value.grant.choices.peerId,
    permissionId: e.value.grant.choices.permissionId,
    expiresAt: e.value.header.expiresAt,
    receipt: e.value.receipt?.receipt ?? null,
  };
}
type Summary = ReturnType<typeof summary>;
const action = z.strictObject({
  grantId: z.uuid(),
  id: z.uuid(),
  expectedRevision: positive,
  confirmed: z.literal(true),
});
/** Internal retained outbox. No host/UI/relay exposure and no implicit send.
 * Requires the common database resume_delivery store. */
export class BrowserResumeDelivery {
  private closed = false;
  private busy = false;
  private generation = 0;
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => PrivateBinding | null,
    private consent: BrowserResumeConsent,
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
    consent: BrowserResumeConsent,
    now = Date.now,
    mono = () => performance.now(),
  ) {
    const scope = await browserKeyScope(owner);
    const db = await openBrowserPrivateDatabase();
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      fail("STORAGE_UNAVAILABLE");
    }
    return new BrowserResumeDelivery(
      db,
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
    g.deliveryCheck();
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
  private async operation<T>(
    fn: (g: Guard) => Promise<T>,
    deliveryCheck: () => void = () => {},
  ) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    try {
      const g = {
        generation: this.generation,
        wall: this.now(),
        mono: this.mono(),
        binding: privateBindingSchema.parse(this.current()),
        deliveryCheck,
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
  private async authorize(g: Guard, grantId: string) {
    const status = await this.consent.status();
    const grant = status.grants.find((v) => v.id === grantId);
    if (!grant) fail();
    const c = grant.choices;
    const h = await this.consent.authorize(grantId, {
      permissionId: c.permissionId,
      taskId: c.taskId,
      taskRevision: c.taskRevision,
      modelDigest: c.modelDigest,
    });
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
  private id(h: Handle) {
    // One retained request per Mac permission even if a caller invents another command ID.
    return browserPrivateDigest([
      "browser-resume-delivery:v1",
      this.scope,
      h.grant.local.binding.ownerId,
      h.grant.choices.peerId,
      h.grant.choices.peerKeyEpoch,
      h.grant.choices.permissionId,
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
        const row =
          raw === undefined ? null : readBrowserResumeDeliveryRow(raw);
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
      !same(e.value.grant, h.grant) ||
      (!allowExpiredEnvelope && e.value.header.expiresAt <= this.now()) ||
      e.value.header.issuedAt > this.now() + 30000
    )
      fail();
    h.check();
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
        if (count >= 256) fail("CAPACITY");
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
  prepare(raw: unknown): Promise<Summary> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          grantId: z.uuid(),
          id: z.uuid(),
          expiresAt: positive,
          confirmed: z.literal(true),
        })
        .parse(raw);
      const h = await this.authorize(g, input.grantId);
      const { identity, channel } = await this.route(g, h);
      const id = await this.id(h),
        snapshot = await this.snapshot(g, h, [id], channel, identity.scope);
      const requestHash = await browserPrivateDigest(input);
      if (snapshot.rows[0]) {
        const old = this.checked(
          await openBrowserResumeDeliveryRow(snapshot.rows[0]),
          h,
        );
        if (
          old.value.requestHash !== requestHash ||
          old.value.request.command.id !== input.id
        )
          fail("CONFLICT");
        return this.tx<Summary>(g, h, "readonly", (io) =>
          this.rows(io, [id], (rows) => {
            if (!same(rows, snapshot.rows)) fail("CONFLICT");
            io.done(summary(old));
          }),
        );
      }
      const header = this.header(
        g,
        h,
        input.id,
        snapshot.sequence,
        input.expiresAt,
      );
      const value: Value = {
        state: "preparing",
        stopped: false,
        grant: h.grant,
        header,
        requestHash,
        request: {
          version: 1,
          type: "task.resume",
          command: {
            version: 1,
            id: input.id,
            command: "resume",
            deviceId: h.grant.choices.peerId,
            permissionId: h.grant.choices.permissionId,
            taskId: h.grant.choices.taskId,
            expectedRevision: h.grant.choices.taskRevision,
            issuedAt: new Date(header.issuedAt).toISOString(),
            expiresAt: new Date(header.expiresAt).toISOString(),
          },
        },
        envelope: null,
        receipt: null,
        receiptEnvelope: null,
      };
      const row = await sealBrowserResumeDeliveryRow(
        { scope: this.scope, id, deviceHash: identity.deviceHash, revision: 1 },
        value,
      );
      return this.tx<Summary>(g, h, "readwrite", (io) =>
        this.rows(io, [id], (rows) => {
          if (!same(rows, snapshot.rows)) fail("CONFLICT");
          if (header.expiresAt <= this.now()) fail();
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
    allowExpiredEnvelope = false,
  ) {
    const h = await this.authorize(g, grantId),
      id = await this.id(h);
    const row = await this.tx<Row | null>(g, h, "readonly", (io) =>
      this.rows(io, [id], (rows) => io.done(rows[0]!)),
    );
    if (!row) fail();
    const e = this.checked(
      await openBrowserResumeDeliveryRow(row),
      h,
      allowExpiredEnvelope,
    );
    if (e.value.request.command.id !== wireId) fail();
    return { e, h, id };
  }
  /** Returns only an already-retained or newly committed original ciphertext.
   * Encryption happens outside the transaction; a changed row rejects the result. */
  envelope(raw: unknown): Promise<PrivateEnvelope> {
    return this.operation(async (g) => {
      const input = action.parse(raw),
        { e, h, id } = await this.retained(g, input.grantId, input.id);
      if (e.row.revision !== input.expectedRevision) fail("CONFLICT");
      if (e.value.stopped || e.value.state === "accepted") fail();
      if (e.value.envelope)
        return this.tx(g, h, "readonly", (io) =>
          this.rows(io, [id], (rows) => {
            this.checked(e, h);
            if (!same(rows[0], e.row)) fail("CONFLICT");
            io.done(structuredClone(e.value.envelope!));
          }),
        );
      const bytes = new TextEncoder().encode(JSON.stringify(e.value.request));
      try {
        const envelope = await sealPrivateEnvelope(
          e.value.header,
          bytes,
          { senderKey: h.localKey, recipientPublicKey: h.peerPublicKey },
          this.now,
        );
        if (e.row.revision >= Number.MAX_SAFE_INTEGER) fail("CAPACITY");
        const value: Value = { ...e.value, envelope, state: "ready" };
        const row = await sealBrowserResumeDeliveryRow(
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
  read(raw: unknown): Promise<Summary> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({ grantId: z.uuid(), id: z.uuid() })
        .parse(raw);
      const { e, h, id } = await this.retained(
        g,
        input.grantId,
        input.id,
        true,
      );
      return this.tx<Summary>(g, h, "readonly", (io) =>
        this.rows(io, [id], (rows) => {
          if (!same(rows[0], e.row)) fail("CONFLICT");
          io.done(summary(e));
        }),
      );
    });
  }
  /** Authenticate an exact Mac transition receipt and commit it with the shared
   * replay ledger. A receipt is not task completion and grants no further resume. */
  reconcile(
    raw: unknown,
    deliveryCheck: () => void = () => {},
  ): Promise<{ duplicate: boolean; entry: Summary }> {
    return this.operation(async (g) => {
      const input = z
        .strictObject({ ...action.shape, envelope: privateEnvelopeSchema })
        .parse(raw);
      const { e, h, id } = await this.retained(
        g,
        input.grantId,
        input.id,
        true,
      );
      if (e.row.revision !== input.expectedRevision) fail("CONFLICT");
      if (e.value.state === "preparing" || !e.value.envelope) fail();
      const header = input.envelope.header,
        original = e.value.header;
      if (
        header.ownerId !== original.ownerId ||
        header.senderId !== original.recipientId ||
        header.recipientId !== original.senderId ||
        header.senderKeyEpoch !== original.recipientKeyEpoch ||
        header.recipientKeyEpoch !== original.senderKeyEpoch ||
        header.operationId !== original.operationId ||
        header.expiresAt > h.grant.offer.expiresAt
      )
        fail();
      const opened = await openPrivateEnvelope(
        input.envelope,
        header,
        { recipientKey: h.localKey, senderPublicKey: h.peerPublicKey },
        this.now,
      );
      let receipt: Value["receipt"];
      try {
        receipt = privateResumeReceiptSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        );
      } finally {
        opened.plaintext.fill(0);
      }
      const value: Value = {
        ...e.value,
        state: "accepted",
        receipt,
        receiptEnvelope: input.envelope,
      };
      const duplicate = e.value.state === "accepted";
      if (
        duplicate &&
        (!same(e.value.receipt, receipt) ||
          !same(e.value.receiptEnvelope, input.envelope))
      )
        fail("CONFLICT");
      if (!duplicate && e.row.revision >= Number.MAX_SAFE_INTEGER)
        fail("CAPACITY");
      // Receipt TTL follows the Mac's offer, but current browser consent is
      // still checked on every transaction callback and can expire sooner.
      const row = duplicate
        ? e.row
        : await sealBrowserResumeDeliveryRow(
            { ...e.row, revision: e.row.revision + 1 },
            value,
            e.row.key,
          );
      const replay = await privateReplayIdentity(
          input.envelope,
          "task.resumed",
        ),
        identity = await browserPrivateIdentity(g.binding);
      return this.tx<{ duplicate: boolean; entry: Summary }>(
        g,
        h,
        "readwrite",
        (io) =>
          this.rows(io, [id], (rows) => {
            this.checked(e, h, true);
            if (header.expiresAt <= this.now() || !same(rows[0], e.row))
              fail("CONFLICT");
            consumeBrowserIncomingReplay(
              io,
              identity.scope,
              replay,
              { store: storeName, key: [this.scope, id] },
              duplicate,
              (state) => {
                if ((state === "duplicate") !== duplicate) fail("CONFLICT");
                if (!duplicate) io.store(storeName).put(row);
                io.done({ duplicate, entry: summary({ row, value }) });
              },
            );
          }),
      );
    }, deliveryCheck);
  }

  private allRows<T>(io: BrowserStorageIO<T>, done: (rows: Row[]) => void) {
    io.request(
      io.store(storeName).index("scope").getAll(this.scope, 257),
      (raw) => {
        if (raw.length > 256) fail("CAPACITY");
        const rows = raw.map(readBrowserResumeDeliveryRow);
        if (rows.some((row) => row.scope !== this.scope))
          fail("STORAGE_UNAVAILABLE");
        done(rows);
      },
    );
  }
  /** Owner-local maintenance never resolves keys, renews consent or sends data. */
  private async local<T>(work: (check: () => void) => Promise<T>) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    const generation = this.generation,
      wall = this.now(),
      mono = this.mono();
    const check = () => {
      const now = this.now(),
        elapsed = this.mono() - mono;
      if (
        this.closed ||
        generation !== this.generation ||
        !Number.isSafeInteger(now) ||
        now < wall ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= 120000
      )
        fail();
    };
    try {
      check();
      const result = await work(check);
      check();
      return result;
    } catch (e) {
      throw normalize(e);
    } finally {
      this.busy = false;
    }
  }
  private localRows(check: () => void) {
    return browserStorageTransaction<Row[]>(
      this.db,
      [storeName],
      "readonly",
      check,
      (io) => this.allRows(io, (rows) => io.done(rows)),
      normalize,
    );
  }
  /** Metadata only, available after expiry, revocation and logout. */
  history(): Promise<Summary[]> {
    return this.local(async (check) => {
      const rows = await this.localRows(check);
      const entries = await Promise.all(rows.map(openBrowserResumeDeliveryRow));
      check();
      const items = entries
        .sort(
          (a, b) =>
            a.value.header.issuedAt - b.value.header.issuedAt ||
            a.value.request.command.id.localeCompare(
              b.value.request.command.id,
            ),
        )
        .map(summary);
      return browserStorageTransaction<Summary[]>(
        this.db,
        [storeName],
        "readonly",
        check,
        (io) =>
          this.allRows(io, (current) => {
            if (!same(current, rows)) fail("CONFLICT");
            io.done(items);
          }),
        normalize,
      );
    });
  }
  /** Export is a metadata/history archive, not an authority or ciphertext backup. */
  async export(raw: unknown) {
    z.strictObject({ confirmed: z.literal(true) }).parse(raw);
    return {
      version: 1 as const,
      restoreAuthority: false as const,
      items: await this.history(),
    };
  }
  /** Stop retains originals and receipts; it cannot withdraw a previously sent request. */
  stop(raw: unknown): Promise<Summary> {
    const input = action.parse(raw);
    return this.local(async (check) => {
      const rows = await this.localRows(check);
      const entries = await Promise.all(rows.map(openBrowserResumeDeliveryRow));
      check();
      const entry = entries.find(
        (e) =>
          e.value.grant.id === input.grantId &&
          e.value.request.command.id === input.id,
      );
      if (!entry) fail();
      if (entry.row.revision !== input.expectedRevision) fail("CONFLICT");
      if (!entry.value.stopped && entry.row.revision >= Number.MAX_SAFE_INTEGER)
        fail("CAPACITY");
      const value: Value = { ...entry.value, stopped: true };
      const row = entry.value.stopped
        ? entry.row
        : await sealBrowserResumeDeliveryRow(
            { ...entry.row, revision: entry.row.revision + 1 },
            value,
            entry.row.key,
          );
      return browserStorageTransaction<Summary>(
        this.db,
        [storeName],
        "readwrite",
        check,
        (io) =>
          this.rows(io, [entry.row.id], (current) => {
            if (!same(current[0], entry.row)) fail("CONFLICT");
            if (row !== entry.row) io.store(storeName).put(row);
            io.done(summary({ row, value }));
          }),
        normalize,
      );
    });
  }
  /** Delete local copies and lock resume consent atomically. Shared replay and
   * channel sequence records remain, so deletion cannot make an old offer new. */
  clear(raw: unknown) {
    const input = z
      .strictObject({
        expectedConsentRevision: positive.or(z.literal(0)),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.local((check) =>
      browserStorageTransaction<{
        removed: number;
        consentRevision: number;
        needsFreshDevice: true;
      }>(
        this.db,
        [storeName, "resume_consents"],
        "readwrite",
        check,
        (io) => {
          io.request(io.store("resume_consents").get(this.scope), (raw) => {
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
                // A missing consent row with retained requests is corrupt, not fresh authority.
                if (!record && keys.length) fail("STORAGE_UNAVAILABLE");
                if (record)
                  io.store("resume_consents").put({
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
                  needsFreshDevice: true as const,
                });
              },
            );
          });
        },
        normalize,
      ),
    );
  }
}
