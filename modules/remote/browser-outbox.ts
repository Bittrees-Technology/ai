import {
  prepareBrowserTask,
  readBrowserTaskPreparation,
  openBrowserTaskPreparation,
  type BrowserTaskPreparation,
} from "./browser-task-preparation.js";
import type { BrowserStorageIO } from "./browser-storage.js";
/** Internal retained provider: checked inside the outbox's own transaction. */
export type BrowserOutboxAuthorization = {
  stores: string[];
  check(): void;
  validate(io: BrowserStorageIO<unknown>, next: () => void): void;
};
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import { z } from "zod";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  openPrivateEnvelope,
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  type PrivateEnvelope,
} from "./private-envelope.js";
import {
  privateAcceptedPayloadSchema,
  privateResultPayloadSchema,
} from "./private-task-contracts.js";

import {
  browserDeliveryContextSchema,
  browserOutboxMetaSchema as metaSchema,
  browserOutboxEntrySchema as entrySchema,
  type BrowserDeliveryContext,
  type BrowserOutboxEntry as Entry,
  type BrowserOutboxMeta as Meta,
  BrowserOutboxError,
  browserPrivateIdentity,
  browserPrivateDigest as digest,
  browserPrivateChannel,
  reserveBrowserSequence,
} from "./browser-outbox-state.js";
export {
  browserDeliveryContextSchema,
  BrowserOutboxError,
} from "./browser-outbox-state.js";
export type { BrowserDeliveryContext } from "./browser-outbox-state.js";
/** Supplied by verified client key/peer state, never by a response or stored row. */
export type BrowserReceiptAuthority = {
  context: BrowserDeliveryContext;
  recipientKey: CryptoKeyPair;
  senderPublicKey: CryptoKey;
  resultsEnabled?: boolean;
};
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
type Identity = { binding: PrivateBinding; scope: string; deviceHash: string };
const stores = ["meta", "entries", "channels", "task_preparations"];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function wire(raw: unknown): PrivateEnvelope {
  const e = privateEnvelopeSchema.parse(raw);
  for (const [s, min, max] of [
    [e.enc, 65, 65],
    [e.ciphertext, 17, 65552],
  ] as const) {
    const bytes = Uint8Array.from(
      atob(s.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const canonical = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    if (
      s !== canonical ||
      bytes.length < min ||
      bytes.length > max ||
      (min === 65 && bytes[0] !== 4)
    )
      throw new BrowserOutboxError("DENIED");
  }
  return e;
}
type IO<T> = {
  store: (name: string) => IDBObjectStore;
  request: <R>(req: IDBRequest<R>, cb: (value: R) => void) => void;
  gate: (check: () => void) => void;
  done: (value: T) => void;
};

/** Ciphertext-only browser persistence, not a pairing/permission/key store or transport.
 * current/permission/freshRegistration must be supplied by verified trusted client state.
 * Never derive them from stored rows, request bodies, invitations or a model.
 */
export class BrowserPrivateOutbox {
  private closed = false;
  private inflight = 0;
  private constructor(
    private db: IDBDatabase,
    private current: () => PrivateBinding | null,
    private permission: (peerId: string) => BrowserDeliveryContext | null,
    private freshRegistration: () => PrivateBinding | null,
    private now: () => number,
    private receiptAuthority: (
      peerId: string,
    ) => BrowserReceiptAuthority | null,
    private retained?: BrowserOutboxAuthorization,
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
    };
  }
  static async open(
    current: () => PrivateBinding | null,
    permission: (peerId: string) => BrowserDeliveryContext | null,
    freshRegistration: () => PrivateBinding | null = () => null,
    now = Date.now,
    receiptAuthority: (peerId: string) => BrowserReceiptAuthority | null = () =>
      null,
  ): Promise<BrowserPrivateOutbox> {
    return new BrowserPrivateOutbox(
      await openBrowserPrivateDatabase(),
      current,
      permission,
      freshRegistration,
      now,
      receiptAuthority,
    );
  }

  /** Production retained permissions supply this guard. The unguarded open()
   * remains only for isolated protocol fixtures and legacy compatibility. */
  static async openVerified(
    current: () => PrivateBinding | null,
    permission: (peerId: string) => BrowserDeliveryContext | null,
    freshRegistration: () => PrivateBinding | null,
    now: () => number,
    receiptAuthority: (peerId: string) => BrowserReceiptAuthority | null,
    retained: BrowserOutboxAuthorization,
  ) {
    retained.check();
    const db = await openBrowserPrivateDatabase();
    try {
      retained.check();
      return new BrowserPrivateOutbox(
        db,
        current,
        permission,
        freshRegistration,
        now,
        receiptAuthority,
        retained,
      );
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close() {
    this.closed = true;
    this.db.close();
  }
  private binding() {
    const b = privateBindingSchema.safeParse(this.current());
    if (!b.success || b.data.expiresAt <= this.now())
      throw new BrowserOutboxError("DENIED");
    return b.data;
  }
  private async identity() {
    const binding = this.binding();
    const { scope, deviceHash } = await browserPrivateIdentity(binding);
    if (!same(binding, this.binding())) throw new BrowserOutboxError("DENIED");
    return { binding, scope, deviceHash };
  }
  private authority(peerId: string) {
    const c = browserDeliveryContextSchema.safeParse(this.permission(peerId));
    if (
      !c.success ||
      c.data.peerId !== peerId ||
      !same(c.data.binding, this.binding())
    )
      throw new BrowserOutboxError("DENIED");
    return c.data;
  }
  private async safe<T>(fn: () => Promise<T>) {
    if (this.inflight >= 8) throw new BrowserOutboxError("CAPACITY");
    this.inflight++;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BrowserOutboxError) throw e;
      throw new BrowserOutboxError("DENIED");
    } finally {
      this.inflight--;
    }
  }
  private tx<T>(
    identity: Identity,
    mode: IDBTransactionMode,
    work: (io: IO<T>) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let result: T,
        error: BrowserOutboxError | undefined,
        extra = () => {};
      const check = () => {
        if (this.closed) throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
        if (!same(this.binding(), identity.binding))
          throw new BrowserOutboxError("DENIED");
        this.retained?.check();
        extra();
      };
      let tx: IDBTransaction;
      try {
        check();
        tx = this.db.transaction(
          [...new Set([...stores, ...(this.retained?.stores ?? [])])],
          mode,
          { durability: "strict" },
        );
      } catch (e) {
        reject(
          e instanceof BrowserOutboxError
            ? e
            : new BrowserOutboxError("STORAGE_UNAVAILABLE"),
        );
        return;
      }
      const fail = (e: unknown) => {
        error =
          e instanceof BrowserOutboxError
            ? e
            : new BrowserOutboxError(
                e instanceof DOMException && e.name === "QuotaExceededError"
                  ? "CAPACITY"
                  : "STORAGE_UNAVAILABLE",
              );
        try {
          tx.abort();
        } catch {
          clearTimeout(timer);
          reject(error);
        }
      };
      const guard = (fn: () => void) => {
        try {
          check();
          fn();
        } catch (e) {
          fail(e);
        }
      };
      const timer = setTimeout(
        () => fail(new BrowserOutboxError("STORAGE_UNAVAILABLE")),
        15000,
      );
      tx.onabort = () => {
        clearTimeout(timer);
        reject(
          error ??
            new BrowserOutboxError(
              tx.error?.name === "QuotaExceededError"
                ? "CAPACITY"
                : "STORAGE_UNAVAILABLE",
            ),
        );
      };
      tx.oncomplete = () => {
        clearTimeout(timer);
        try {
          check();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      };
      guard(() => {
        const io: IO<T> = {
          store: (name) => tx.objectStore(name),
          request: (req, cb) => {
            req.onsuccess = () => guard(() => cb(req.result));
          },
          gate: (fn) => {
            extra = fn;
            check();
          },
          done: (value) => {
            check();
            result = value;
          },
        };
        if (this.retained) this.retained.validate(io, () => work(io));
        else work(io);
      });
    });
  }
  private meta(raw: unknown, identity: Identity, active = true) {
    const parsed = metaSchema.safeParse(raw);
    if (!parsed.success)
      throw new BrowserOutboxError(
        raw === undefined ? "SETUP_REQUIRED" : "STORAGE_UNAVAILABLE",
      );
    if (parsed.data.scope !== identity.scope)
      throw new BrowserOutboxError("DENIED");
    if (
      active &&
      (parsed.data.locked || parsed.data.deviceHash !== identity.deviceHash)
    )
      throw new BrowserOutboxError("SETUP_REQUIRED");
    return parsed.data;
  }
  private bump(meta: Meta) {
    if (meta.revision >= Number.MAX_SAFE_INTEGER)
      throw new BrowserOutboxError("CAPACITY");
    meta.revision++;
  }
  private entry(raw: unknown, scope: string) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success)
      throw new BrowserOutboxError(
        raw === undefined ? "DENIED" : "STORAGE_UNAVAILABLE",
      );
    if (parsed.data.scope !== scope) throw new BrowserOutboxError("DENIED");
    return parsed.data;
  }
  /** Called only after a fresh verified endpoint registration, never automatically on missing storage. */
  initialize(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            confirmed: z.literal(true),
            expectedRevision: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .parse(raw),
        identity = await this.identity();
      const fresh = () => {
        if (
          !same(
            privateBindingSchema.parse(this.freshRegistration()),
            identity.binding,
          )
        )
          throw new BrowserOutboxError("DENIED");
      };
      fresh();
      return this.tx<Meta>(identity, "readwrite", (io) => {
        io.gate(fresh);
        io.request(io.store("meta").get(identity.scope), (raw) => {
          if (raw) {
            const old = this.meta(raw, identity, false);
            if (old.revision !== input.expectedRevision)
              throw new BrowserOutboxError("CONFLICT");
            if (old.deviceHash === identity.deviceHash)
              throw new BrowserOutboxError("SETUP_REQUIRED");
            this.bump(old);
            old.deviceHash = identity.deviceHash;
            old.locked = false;
            io.store("meta").put(old);
            io.done(old);
          } else {
            if (input.expectedRevision !== 0)
              throw new BrowserOutboxError("CONFLICT");
            io.request(io.store("meta").count(), (count) => {
              if (count >= 32) throw new BrowserOutboxError("CAPACITY");
              const meta = {
                scope: identity.scope,
                deviceHash: identity.deviceHash,
                revision: 1,
                locked: false,
              };
              io.store("meta").add(meta);
              io.done(meta);
            });
          }
        });
      });
    });
  }
  reserve(raw: unknown) {
    return this.safe(async () => {
      const input = z
        .strictObject({ peerId: z.uuid(), confirmed: z.literal(true) })
        .parse(raw);
      return this.reserveEntry(input.peerId);
    });
  }
  /** Trusted composition caller supplies the one-use review's operation ID and
   * original deadline. Crypto finishes before the atomic sequence/preparation write. */
  reserveTask(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            id: z.uuid(),
            peerId: z.uuid(),
            expiresAt: positive,
            payload: z.unknown(),
          })
          .parse(raw),
        identity = await this.identity(),
        context = this.authority(input.peerId),
        issuedAt = this.now();
      if (
        input.expiresAt <= issuedAt ||
        input.expiresAt >
          Math.min(issuedAt + 86400000, identity.binding.expiresAt)
      )
        throw new BrowserOutboxError("DENIED");
      const prepared = await prepareBrowserTask(
        input.id,
        identity.scope,
        context,
        input.payload,
        issuedAt,
        input.expiresAt,
      );
      return this.reserveEntry(input.peerId, prepared);
    });
  }
  private async reserveEntry(
    peerId: string,
    prepared?: BrowserTaskPreparation,
  ) {
    const identity = await this.identity(),
      context = this.authority(peerId),
      channel = await browserPrivateChannel(identity, context);
    const current = () => {
      if (
        !same(context, this.authority(peerId)) ||
        (prepared &&
          (prepared.scope !== identity.scope ||
            !same(prepared.context, context) ||
            prepared.issuedAt > this.now() ||
            prepared.expiresAt <= this.now()))
      )
        throw new BrowserOutboxError("DENIED");
    };
    current();
    return this.tx<Entry>(identity, "readwrite", (io) => {
      io.gate(current);
      io.request(io.store("meta").get(identity.scope), (raw) => {
        const meta = this.meta(raw, identity);
        io.request(
          io.store("entries").index("scope").count(identity.scope),
          (count) => {
            if (count >= 256) throw new BrowserOutboxError("CAPACITY");
            const reserve = () =>
              reserveBrowserSequence(
                io,
                identity.scope,
                channel,
                (sequence) => {
                  const issuedAt = prepared?.issuedAt ?? this.now(),
                    header = privateHeaderSchema.parse({
                      version: 1,
                      suite: privateEnvelopeSuite,
                      ownerId: identity.binding.ownerId,
                      senderId: identity.binding.deviceId,
                      recipientId: context.peerId,
                      senderKeyEpoch: context.senderKeyEpoch,
                      recipientKeyEpoch: context.peerKeyEpoch,
                      messageId: crypto.randomUUID(),
                      operationId: prepared?.id ?? crypto.randomUUID(),
                      sequence,
                      issuedAt,
                      expiresAt:
                        prepared?.expiresAt ??
                        Math.min(
                          issuedAt + 86400000,
                          identity.binding.expiresAt,
                        ),
                    });
                  if (header.expiresAt <= this.now())
                    throw new BrowserOutboxError("DENIED");
                  const entry = entrySchema.parse({
                    id: header.operationId,
                    scope: identity.scope,
                    revision: 1,
                    context,
                    header,
                    state: "reserved",
                    envelope: null,
                    attempts: 0,
                    ...(prepared ? { composed: true } : {}),
                  });
                  this.bump(meta);
                  io.store("entries").add(entry);
                  if (prepared)
                    io.store("task_preparations").add(
                      readBrowserTaskPreparation(prepared, entry),
                    );
                  io.store("meta").put(meta);
                  io.done(entry);
                },
              );
            if (prepared)
              io.request(
                io
                  .store("task_preparations")
                  .index("scope")
                  .count(identity.scope),
                (count) => {
                  if (count >= 256) throw new BrowserOutboxError("CAPACITY");
                  reserve();
                },
              );
            else reserve();
          },
        );
      });
    });
  }
  private async taskSnapshot(id: string) {
    z.uuid().parse(id);
    const identity = await this.identity();
    return this.tx<{
      entry: Entry;
      preparation: BrowserTaskPreparation | null;
    }>(identity, "readonly", (io) => {
      io.request(io.store("meta").get(identity.scope), (raw) => {
        this.meta(raw, identity);
        io.request(io.store("entries").get(id), (raw) => {
          const entry = this.entry(raw, identity.scope);
          io.gate(() => {
            if (
              !same(entry.context, this.authority(entry.context.peerId)) ||
              entry.state === "stopped" ||
              entry.header.issuedAt > this.now() ||
              entry.header.expiresAt <= this.now()
            )
              throw new BrowserOutboxError("DENIED");
          });
          io.request(io.store("task_preparations").get(id), (raw) => {
            if (entry.composed && raw === undefined)
              throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
            if (!entry.composed && raw !== undefined)
              throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
            io.done({
              entry,
              preparation:
                raw === undefined
                  ? null
                  : readBrowserTaskPreparation(raw, entry),
            });
          });
        });
      });
    });
  }
  /** Canonical committed state for explicit reconciliation, never a new reservation. */
  taskState(id: string) {
    return this.safe(async () => (await this.taskSnapshot(id)).entry);
  }
  /** Internal only. The host never exposes preparation keys or plaintext callbacks. */
  preparedTask(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({ id: z.uuid(), expectedRevision: positive })
          .parse(raw),
        before = await this.taskSnapshot(input.id);
      if (
        before.entry.revision !== input.expectedRevision ||
        before.entry.state !== "reserved"
      )
        throw new BrowserOutboxError("CONFLICT");
      if (!before.preparation) throw new BrowserOutboxError("SETUP_REQUIRED");
      const payload = await openBrowserTaskPreparation(before.preparation),
        after = await this.taskSnapshot(input.id);
      if (!same(before, after)) throw new BrowserOutboxError("CONFLICT");
      const { key: _key, ...proof } = after.preparation!;
      return { entry: after.entry, payload, proof };
    });
  }
  commit(raw: unknown, preparation?: Omit<BrowserTaskPreparation, "key">) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            envelope: privateEnvelopeSchema,
          })
          .parse(raw),
        envelope = wire(input.envelope),
        identity = await this.identity();
      return this.tx<Entry>(identity, "readwrite", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity);
          io.request(io.store("entries").get(input.id), (raw) => {
            const entry = this.entry(raw, identity.scope);
            const publish = () => {
              io.gate(() => {
                if (
                  entry.header.expiresAt <= this.now() ||
                  !same(entry.context, this.authority(entry.context.peerId))
                )
                  throw new BrowserOutboxError("DENIED");
              });
              if (
                !same(envelope.header, entry.header) ||
                entry.header.expiresAt <= this.now()
              )
                throw new BrowserOutboxError("DENIED");
              if (entry.state === "pending" && entry.envelope) {
                if (!same(envelope, entry.envelope))
                  throw new BrowserOutboxError("CONFLICT");
                io.done(entry);
                return;
              }
              if (
                entry.state !== "reserved" ||
                entry.revision !== input.expectedRevision
              )
                throw new BrowserOutboxError("CONFLICT");
              entry.envelope = envelope;
              entry.state = "pending";
              entry.revision++;
              this.bump(meta);
              io.store("entries").put(entry);
              io.store("meta").put(meta);
              io.done(entry);
            };
            if (entry.composed) {
              if (!preparation) throw new BrowserOutboxError("DENIED");
              io.request(io.store("task_preparations").get(entry.id), (raw) => {
                const { key: _key, ...proof } = readBrowserTaskPreparation(
                  raw,
                  entry,
                );
                if (!same(proof, preparation))
                  throw new BrowserOutboxError("CONFLICT");
                publish();
              });
            } else {
              if (preparation) throw new BrowserOutboxError("DENIED");
              publish();
            }
          });
        });
      });
    });
  }
  delivery(id: string, expectedRevision?: number) {
    return this.safe(async () => {
      z.uuid().parse(id);
      if (expectedRevision !== undefined) positive.parse(expectedRevision);
      const identity = await this.identity();
      return this.tx<PrivateEnvelope>(identity, "readwrite", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity);
          io.request(io.store("entries").get(id), (raw) => {
            const entry = this.entry(raw, identity.scope);
            if (
              expectedRevision !== undefined &&
              entry.revision !== expectedRevision
            )
              throw new BrowserOutboxError("CONFLICT");
            io.gate(() => {
              if (
                entry.header.expiresAt <= this.now() ||
                !same(entry.context, this.authority(entry.context.peerId))
              )
                throw new BrowserOutboxError("DENIED");
            });
            if (
              entry.state !== "pending" ||
              !entry.envelope ||
              entry.header.expiresAt <= this.now()
            )
              throw new BrowserOutboxError("DENIED");
            if (
              entry.attempts >= Number.MAX_SAFE_INTEGER ||
              entry.revision >= Number.MAX_SAFE_INTEGER
            )
              throw new BrowserOutboxError("CAPACITY");
            entry.attempts++;
            entry.revision++;
            this.bump(meta);
            io.store("entries").put(entry);
            io.store("meta").put(meta);
            io.done(wire(entry.envelope));
          });
        });
      });
    });
  }
  private receiptKeys(context: BrowserDeliveryContext, result = false) {
    const value = this.receiptAuthority(context.peerId);
    if (
      !value ||
      (result && value.resultsEnabled !== true) ||
      !same(browserDeliveryContextSchema.parse(value.context), context) ||
      !same(this.authority(context.peerId), context)
    )
      throw new BrowserOutboxError("DENIED");
    return {
      privateKey: value.recipientKey.privateKey,
      publicKey: value.recipientKey.publicKey,
      senderPublicKey: value.senderPublicKey,
    };
  }
  private responseEntry(identity: Identity, id: string) {
    return this.tx<Entry>(identity, "readonly", (io) => {
      io.request(io.store("meta").get(identity.scope), (raw) => {
        this.meta(raw, identity);
        io.request(io.store("entries").get(id), (raw) =>
          io.done(this.entry(raw, identity.scope)),
        );
      });
    });
  }
  private async decodeResponse(
    before: Entry,
    envelope: PrivateEnvelope,
    result: boolean,
    at: () => number,
  ) {
    const h = envelope.header,
      original = before.header,
      keys = this.receiptKeys(before.context, result);
    if (
      !before.envelope ||
      h.operationId !== original.operationId ||
      h.ownerId !== original.ownerId ||
      h.senderId !== original.recipientId ||
      h.recipientId !== original.senderId ||
      h.senderKeyEpoch !== original.recipientKeyEpoch ||
      h.recipientKeyEpoch !== original.senderKeyEpoch
    )
      throw new BrowserOutboxError("DENIED");
    const opened = await openPrivateEnvelope(
      envelope,
      h,
      {
        recipientKey: {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
        },
        senderPublicKey: keys.senderPublicKey,
      },
      at,
    );
    let payload;
    try {
      const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
      );
      payload = result
        ? privateResultPayloadSchema.parse(raw)
        : privateAcceptedPayloadSchema.parse(raw);
    } finally {
      opened.plaintext.fill(0);
    }
    const receipt = payload.receipt;
    if (
      !same(receipt.header, original) ||
      receipt.acceptedAt >= original.expiresAt ||
      receipt.acceptedAt < original.issuedAt - 30000 ||
      receipt.acceptedAt > this.now() + 30000
    )
      throw new BrowserOutboxError("DENIED");
    if (
      payload.type === "task.result" &&
      (payload.task.updatedAt < receipt.acceptedAt ||
        payload.task.updatedAt > this.now() + 30000)
    )
      throw new BrowserOutboxError("DENIED");
    const receiptHash = await digest(["browser-receipt:v1", receipt]),
      resultHash = result ? await digest(["browser-result:v1", payload]) : null;
    return { keys, payload, receiptHash, resultHash };
  }
  private currentKeys(
    context: BrowserDeliveryContext,
    keys: Awaited<ReturnType<BrowserPrivateOutbox["decodeResponse"]>>["keys"],
    result: boolean,
  ) {
    const current = this.receiptKeys(context, result);
    if (
      current.privateKey !== keys.privateKey ||
      current.publicKey !== keys.publicKey ||
      current.senderPublicKey !== keys.senderPublicKey
    )
      throw new BrowserOutboxError("DENIED");
  }
  /** Consume authenticated destination acceptance; never plaintext relay status. */
  acceptReceipt(raw: unknown) {
    return this.acceptResponse(raw, false);
  }
  /** Retain a terminal result as ciphertext. It may arrive before the separate receipt. */
  acceptResult(raw: unknown) {
    return this.acceptResponse(raw, true);
  }
  private acceptResponse(raw: unknown, result: boolean) {
    return this.safe(async () => {
      const envelope = wire(raw),
        h = envelope.header,
        identity = await this.identity(),
        before = await this.responseEntry(identity, h.operationId),
        decoded = await this.decodeResponse(before, envelope, result, this.now);
      return this.tx<Entry>(identity, "readwrite", (io) => {
        io.gate(() => {
          this.currentKeys(before.context, decoded.keys, result);
          if (h.expiresAt <= this.now()) throw new BrowserOutboxError("DENIED");
        });
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity);
          io.request(io.store("entries").get(h.operationId), (raw) => {
            const entry = this.entry(raw, identity.scope);
            if (
              !same(entry.context, before.context) ||
              !same(entry.envelope, before.envelope)
            )
              throw new BrowserOutboxError("CONFLICT");
            if (entry.receiptHash && entry.receiptHash !== decoded.receiptHash)
              throw new BrowserOutboxError("CONFLICT");
            if (
              result &&
              entry.resultHash &&
              entry.resultHash !== decoded.resultHash
            )
              throw new BrowserOutboxError("CONFLICT");
            if (result ? !!entry.resultEnvelope : !!entry.receiptEnvelope) {
              io.done(entry);
              return;
            }
            if (entry.revision >= Number.MAX_SAFE_INTEGER)
              throw new BrowserOutboxError("CAPACITY");
            entry.state = "accepted";
            entry.receiptHash = decoded.receiptHash;
            if (result) {
              entry.resultEnvelope = envelope;
              entry.resultHash = decoded.resultHash;
              entry.resultReceivedAt = this.now();
            } else entry.receiptEnvelope = envelope;
            entry.revision++;
            this.bump(meta);
            entrySchema.parse(entry);
            io.store("entries").put(entry);
            io.store("meta").put(meta);
            io.done(entry);
          });
        });
      });
    });
  }
  /** Explicit local history read. Receipt time is used only to reauthenticate retained
   * ciphertext; current account/permission/keys still gate plaintext return. Never dispatch.
   */
  readResult(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        identity = await this.identity(),
        before = await this.responseEntry(identity, input.id);
      if (before.revision !== input.expectedRevision)
        throw new BrowserOutboxError("CONFLICT");
      if (
        !before.resultEnvelope ||
        !before.resultReceivedAt ||
        before.resultReceivedAt > this.now() + 30000
      )
        throw new BrowserOutboxError("DENIED");
      const decoded = await this.decodeResponse(
        before,
        wire(before.resultEnvelope),
        true,
        () => before.resultReceivedAt!,
      );
      if (
        decoded.payload.type !== "task.result" ||
        decoded.resultHash !== before.resultHash ||
        decoded.receiptHash !== before.receiptHash
      )
        throw new BrowserOutboxError("DENIED");
      const payload = decoded.payload;
      return this.tx<typeof payload>(identity, "readonly", (io) => {
        io.gate(() => this.currentKeys(before.context, decoded.keys, true));
        io.request(io.store("meta").get(identity.scope), (raw) => {
          this.meta(raw, identity);
          io.request(io.store("entries").get(input.id), (raw) => {
            const entry = this.entry(raw, identity.scope);
            if (
              entry.revision !== input.expectedRevision ||
              !same(entry, before)
            )
              throw new BrowserOutboxError("CONFLICT");
            io.done(payload);
          });
        });
      });
    });
  }
  stop(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        identity = await this.identity();
      return this.tx<Entry>(identity, "readwrite", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity, false);
          io.request(io.store("entries").get(input.id), (raw) => {
            const entry = this.entry(raw, identity.scope);
            if (entry.state === "accepted")
              throw new BrowserOutboxError("CONFLICT");
            if (entry.revision !== input.expectedRevision)
              throw new BrowserOutboxError("CONFLICT");
            if (entry.revision >= Number.MAX_SAFE_INTEGER)
              throw new BrowserOutboxError("CAPACITY");
            entry.state = "stopped";
            entry.revision++;
            this.bump(meta);
            io.store("entries").put(entry);
            io.store("meta").put(meta);
            io.done(entry);
          });
        });
      });
    });
  }
  export() {
    return this.safe(async () => {
      const identity = await this.identity();
      return this.tx<{ meta: Meta | null; entries: Entry[] }>(
        identity,
        "readonly",
        (io) => {
          io.request(io.store("meta").get(identity.scope), (raw) => {
            const meta =
              raw === undefined ? null : this.meta(raw, identity, false);
            io.request(
              io.store("entries").index("scope").getAll(identity.scope, 257),
              (rows) => {
                if (rows.length > 256) throw new BrowserOutboxError("CAPACITY");
                io.done({
                  meta,
                  entries: rows.map((raw) => this.entry(raw, identity.scope)),
                });
              },
            );
          });
        },
      );
    });
  }
  clear(raw: unknown) {
    return this.safe(async () => {
      const input = z
          .strictObject({
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        identity = await this.identity();
      return this.tx<Meta>(identity, "readwrite", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity, false);
          if (meta.revision !== input.expectedRevision)
            throw new BrowserOutboxError("CONFLICT");
          this.bump(meta);
          meta.locked = true;
          const remove = (name: string, next: () => void) => {
            io.request(
              io
                .store(name)
                .index("scope")
                .openCursor(IDBKeyRange.only(identity.scope)),
              (cursor) => {
                if (cursor) {
                  cursor.delete();
                  cursor.continue();
                } else next();
              },
            );
          };
          // Counters are shared with possession checks; keep the minimal replay
          // fence when deleting task ciphertext. A new identity is still required.
          remove("entries", () =>
            remove("task_preparations", () => {
              io.store("meta").put(meta);
              io.done(meta);
            }),
          );
        });
      });
    });
  }
}
