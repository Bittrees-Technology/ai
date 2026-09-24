import { privateEnvelopeSchema } from "./private-envelope.js";
import {
  privateRelayEnvelopeHash,
  privateRelayStorageReceiptSchema,
} from "./private-relay-contracts.js";
import { z } from "zod";
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import {
  browserStorageTransaction,
  type BrowserStorageIO,
} from "./browser-storage.js";
import {
  BrowserOutboxError,
  browserPrivateDigest,
  browserOutboxEntrySchema,
  browserOutboxMetaSchema,
  type BrowserOutboxEntry,
  type BrowserOutboxMeta,
} from "./browser-outbox-state.js";
import {
  openBrowserTaskPreparation,
  readBrowserTaskPreparation,
  type BrowserTaskPreparation,
} from "./browser-task-preparation.js";
const stores = ["meta", "entries", "task_preparations"];
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Guard = { generation: number; wall: number; mono: number };
type Snapshot = {
  meta: BrowserOutboxMeta | null;
  entries: BrowserOutboxEntry[];
  preparations: BrowserTaskPreparation[];
};
/** Owner-local history only. No live grant, registration or inference route is
 * obtained here. The host supplies its already established signed-in owner. */
export class BrowserTaskHistory {
  private generation = 0;
  private closed = false;
  private busy = false;
  private constructor(
    private db: IDBDatabase,
    private ownerId: string,
    private scope: string,
    private currentOwner: () => string | null,
    private now: () => number,
    private monotonic: () => number,
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
      this.invalidate();
    };
  }
  static async open(
    ownerId: string,
    currentOwner: () => string | null,
    now = Date.now,
    monotonic = () => performance.now(),
  ) {
    z.uuid().parse(ownerId);
    const scope = await browserPrivateDigest(["browser-owner:v1", ownerId]),
      db = await openBrowserPrivateDatabase();
    const self = new BrowserTaskHistory(
      db,
      ownerId,
      scope,
      currentOwner,
      now,
      monotonic,
    );
    if (currentOwner() !== ownerId) {
      self.close();
      throw new BrowserOutboxError("DENIED");
    }
    return self;
  }
  invalidate() {
    this.generation++;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private check(g: Guard) {
    const n = this.now(),
      elapsed = this.monotonic() - g.mono;
    if (
      this.closed ||
      this.currentOwner() !== this.ownerId ||
      g.generation !== this.generation ||
      !Number.isSafeInteger(n) ||
      n < g.wall ||
      n - g.wall >= 120000 ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= 120000
    )
      throw new BrowserOutboxError("DENIED");
  }
  private async operation<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const g = {
      generation: this.generation,
      wall: this.now(),
      mono: this.monotonic(),
    };
    try {
      this.check(g);
      const value = await fn(g);
      this.check(g);
      return value;
    } finally {
      this.busy = false;
    }
  }
  private tx<T>(
    g: Guard,
    mode: IDBTransactionMode,
    fn: (io: BrowserStorageIO<T>) => void,
  ) {
    return browserStorageTransaction(
      this.db,
      stores,
      mode,
      () => this.check(g),
      fn,
    );
  }
  private meta(raw: unknown) {
    if (raw === undefined) return null;
    const meta = browserOutboxMetaSchema.parse(raw);
    if (meta.scope !== this.scope) throw new BrowserOutboxError("DENIED");
    return meta;
  }
  private entry(raw: unknown) {
    const entry = browserOutboxEntrySchema.parse(raw);
    if (entry.scope !== this.scope || entry.header.ownerId !== this.ownerId)
      throw new BrowserOutboxError("DENIED");
    return entry;
  }
  private snapshot(g: Guard) {
    return this.tx<Snapshot>(g, "readonly", (io) => {
      io.request(io.store("meta").get(this.scope), (raw) => {
        const meta = this.meta(raw);
        io.request(
          io.store("entries").index("scope").getAll(this.scope, 257),
          (rawEntries) => {
            if (rawEntries.length > 256)
              throw new BrowserOutboxError("CAPACITY");
            const entries = rawEntries.map((v) => this.entry(v));
            io.request(
              io
                .store("task_preparations")
                .index("scope")
                .getAll(this.scope, 257),
              (rawPreparations) => {
                if (rawPreparations.length > 256)
                  throw new BrowserOutboxError("CAPACITY");
                const preparations = rawPreparations.map((raw) => {
                  const entry = entries.find(
                    (e) => e.id === raw.id && e.composed,
                  );
                  if (!entry)
                    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
                  return readBrowserTaskPreparation(raw, entry);
                });
                if (
                  (!meta && (entries.length || preparations.length)) ||
                  entries.some(
                    (e) =>
                      e.composed && !preparations.some((p) => p.id === e.id),
                  )
                )
                  throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
                io.done({ meta, entries, preparations });
              },
            );
          },
        );
      });
    });
  }
  status() {
    return this.operation(async (g) => {
      const value = await this.snapshot(g);
      return {
        meta: value.meta,
        entries: value.entries.map((e) => ({
          id: e.id,
          revision: e.revision,
          state: e.state,
          header: e.header,
          context: e.context,
          attempts: e.attempts,
          relayDelivery: e.relayDelivery
            ? {
                state: e.relayDelivery.receipt.state,
                observedAt: e.relayDelivery.observedAt,
                attempt: e.relayDelivery.attempt,
              }
            : null,
          composed: !!e.composed,
          hasEnvelope: !!e.envelope,
          hasReceipt: !!e.receiptHash,
          hasResult: !!e.resultHash,
        })),
      };
    });
  }
  /** Internal host callback after authenticated relay submission. No public API
   * accepts supplied receipts. History grants no task or device authority. */
  recordRelayDelivery(raw: unknown, transportCheck: () => void) {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          id: z.uuid(),
          expectedRevision: revision.refine((v) => v > 0),
          envelope: privateEnvelopeSchema,
          receipt: privateRelayStorageReceiptSchema,
        })
        .parse(raw);
      const check = () => {
        this.check(g);
        transportCheck();
      };
      check();
      const hash = await privateRelayEnvelopeHash(input.envelope);
      check();
      if (
        input.receipt.envelopeHash !== hash ||
        input.receipt.messageId !== input.envelope.header.messageId ||
        input.receipt.storedAt < input.envelope.header.issuedAt - 30000 ||
        input.receipt.storedAt > this.now() + 30000
      )
        throw new BrowserOutboxError("DENIED");
      return browserStorageTransaction(
        this.db,
        stores,
        "readwrite",
        check,
        (io) => {
          io.request(io.store("meta").get(this.scope), (raw) => {
            const meta = this.meta(raw);
            if (!meta || meta.locked) throw new BrowserOutboxError("DENIED");
            io.request(io.store("entries").get(input.id), (raw) => {
              const entry = this.entry(raw);
              if (
                entry.revision !== input.expectedRevision ||
                entry.state !== "pending" ||
                entry.attempts < 1 ||
                !same(entry.envelope, input.envelope)
              )
                throw new BrowserOutboxError("CONFLICT");
              const previous = entry.relayDelivery?.receipt,
                rank = { stored: 0, received: 1, deleted: 2 };
              if (
                previous &&
                (input.receipt.storedAt !== previous.storedAt ||
                  input.receipt.envelopeHash !== previous.envelopeHash ||
                  input.receipt.revision < previous.revision ||
                  rank[input.receipt.state] < rank[previous.state] ||
                  (input.receipt.revision === previous.revision &&
                    !same(input.receipt, previous)))
              )
                throw new BrowserOutboxError("CONFLICT");
              if (
                entry.revision >= Number.MAX_SAFE_INTEGER ||
                meta.revision >= Number.MAX_SAFE_INTEGER
              )
                throw new BrowserOutboxError("CAPACITY");
              entry.relayDelivery = {
                receipt: input.receipt,
                observedAt: this.now(),
                attempt: entry.attempts,
              };
              entry.revision++;
              meta.revision++;
              io.store("entries").put(browserOutboxEntrySchema.parse(entry));
              io.store("meta").put(meta);
              io.done(undefined);
            });
          });
        },
      );
    });
  }
  /** Explicit export of this browser's own reviewed input and encrypted wire
   * history. Mac results stay encrypted and no key handles are exported. */
  export(raw: unknown) {
    return this.operation(async (g) => {
      const input = z
          .strictObject({
            expectedRevision: revision,
            confirmed: z.literal(true),
          })
          .parse(raw),
        before = await this.snapshot(g);
      if ((before.meta?.revision ?? 0) !== input.expectedRevision)
        throw new BrowserOutboxError("CONFLICT");
      const inputs = new Map<
        string,
        Awaited<ReturnType<typeof openBrowserTaskPreparation>>
      >();
      for (const preparation of before.preparations) {
        inputs.set(
          preparation.id,
          await openBrowserTaskPreparation(preparation),
        );
        this.check(g);
      }
      const after = await this.snapshot(g);
      if (!same(before, after)) throw new BrowserOutboxError("CONFLICT");
      return {
        format: "bittrees-browser-task-history-v1",
        exportedAt: this.now(),
        meta: after.meta,
        entries: after.entries.map((e) => ({
          ...e,
          input: inputs.get(e.id) ?? null,
        })),
        restoreAuthority: false,
      };
    });
  }
  stop(raw: unknown) {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          id: z.uuid(),
          expectedRevision: revision.refine((v) => v > 0),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return this.tx<{ id: string; revision: number; state: "stopped" }>(
        g,
        "readwrite",
        (io) => {
          io.request(io.store("meta").get(this.scope), (raw) => {
            const meta = this.meta(raw);
            if (!meta) throw new BrowserOutboxError("SETUP_REQUIRED");
            io.request(io.store("entries").get(input.id), (raw) => {
              const entry = this.entry(raw);
              if (
                entry.revision !== input.expectedRevision ||
                entry.state === "accepted"
              )
                throw new BrowserOutboxError("CONFLICT");
              if (
                entry.revision >= Number.MAX_SAFE_INTEGER ||
                meta.revision >= Number.MAX_SAFE_INTEGER
              )
                throw new BrowserOutboxError("CAPACITY");
              entry.state = "stopped";
              entry.revision++;
              meta.revision++;
              io.store("entries").put(entry);
              io.store("meta").put(meta);
              io.done({
                id: entry.id,
                revision: entry.revision,
                state: entry.state,
              });
            });
          });
        },
      );
    });
  }
  clear(raw: unknown) {
    return this.operation(async (g) => {
      const input = z
        .strictObject({
          expectedRevision: revision.refine((v) => v > 0),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return this.tx<BrowserOutboxMeta>(g, "readwrite", (io) => {
        io.request(io.store("meta").get(this.scope), (raw) => {
          const meta = this.meta(raw);
          if (!meta) throw new BrowserOutboxError("SETUP_REQUIRED");
          if (meta.revision !== input.expectedRevision)
            throw new BrowserOutboxError("CONFLICT");
          if (meta.revision >= Number.MAX_SAFE_INTEGER)
            throw new BrowserOutboxError("CAPACITY");
          const remove = (store: string, next: () => void) =>
            io.request(
              io
                .store(store)
                .index("scope")
                .openCursor(IDBKeyRange.only(this.scope)),
              (cursor) => {
                if (cursor) {
                  cursor.delete();
                  cursor.continue();
                } else next();
              },
            );
          remove("entries", () =>
            remove("task_preparations", () => {
              meta.revision++;
              meta.locked = true;
              io.store("meta").put(meta);
              // Shared channel counters deliberately survive content deletion.
              io.done(meta);
            }),
          );
        });
      });
    });
  }
}
