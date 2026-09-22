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
import { privateAcceptedPayloadSchema } from "./private-task-contracts.js";

/** Supplied by verified client key/peer state, never by a response or stored row. */
export type BrowserReceiptAuthority = {
  context: BrowserDeliveryContext;
  recipientKey: CryptoKeyPair;
  senderPublicKey: CryptoKey;
};
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
export const browserDeliveryContextSchema = z.strictObject({
  binding: privateBindingSchema,
  senderKeyEpoch: positive,
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  peerRevision: positive,
  peerFingerprint: hex,
  permissionRevision: positive,
  sendingEnabled: z.literal(true),
});
export type BrowserDeliveryContext = z.infer<
  typeof browserDeliveryContextSchema
>;
const metaSchema = z.strictObject({
  scope: hex,
  deviceHash: hex,
  revision: positive,
  locked: z.boolean(),
});
const entrySchema = z
  .strictObject({
    id: z.uuid(),
    scope: hex,
    revision: positive,
    context: browserDeliveryContextSchema,
    header: privateHeaderSchema,
    state: z.enum(["reserved", "pending", "stopped", "accepted"]),
    envelope: privateEnvelopeSchema.nullable(),
    receiptEnvelope: privateEnvelopeSchema.nullable().default(null),
    receiptHash: hex.nullable().default(null),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (e) =>
      (e.state === "accepted") === !!e.receiptEnvelope &&
      !!e.receiptEnvelope === !!e.receiptHash &&
      (!e.receiptEnvelope ||
        (!!e.envelope &&
          e.receiptEnvelope.header.ownerId === e.header.ownerId &&
          e.receiptEnvelope.header.operationId === e.header.operationId &&
          e.receiptEnvelope.header.senderId === e.header.recipientId &&
          e.receiptEnvelope.header.recipientId === e.header.senderId &&
          e.receiptEnvelope.header.senderKeyEpoch ===
            e.header.recipientKeyEpoch &&
          e.receiptEnvelope.header.recipientKeyEpoch ===
            e.header.senderKeyEpoch)) &&
      e.id === e.header.operationId &&
      e.header.ownerId === e.context.binding.ownerId &&
      e.header.senderId === e.context.binding.deviceId &&
      e.header.recipientId === e.context.peerId &&
      e.header.senderKeyEpoch === e.context.senderKeyEpoch &&
      e.header.recipientKeyEpoch === e.context.peerKeyEpoch &&
      e.header.senderId !== e.header.recipientId &&
      (e.state !== "pending" || !!e.envelope) &&
      (e.state !== "reserved" || !e.envelope) &&
      (!e.envelope ||
        JSON.stringify(e.header) === JSON.stringify(e.envelope.header)),
  );
type Entry = z.infer<typeof entrySchema>;
type Meta = z.infer<typeof metaSchema>;
type Identity = { binding: PrivateBinding; scope: string; deviceHash: string };
export class BrowserOutboxError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "SETUP_REQUIRED"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
const dbName = "org.bittrees.ai.private-outbox",
  stores = ["meta", "entries", "channels"];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
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
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
    };
  }
  static open(
    current: () => PrivateBinding | null,
    permission: (peerId: string) => BrowserDeliveryContext | null,
    freshRegistration: () => PrivateBinding | null = () => null,
    now = Date.now,
    receiptAuthority: (peerId: string) => BrowserReceiptAuthority | null = () =>
      null,
  ): Promise<BrowserPrivateOutbox> {
    return new Promise((resolve, reject) => {
      let ended = false;
      const fail = () => {
        if (!ended) {
          ended = true;
          clearTimeout(timer);
          reject(new BrowserOutboxError("STORAGE_UNAVAILABLE"));
        }
      };
      const timer = setTimeout(fail, 10000);
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(dbName, 1);
      } catch {
        fail();
        return;
      }
      request.onblocked = fail;
      request.onerror = fail;
      request.onupgradeneeded = () => {
        if (ended) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        db.createObjectStore("meta", { keyPath: "scope" });
        const entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("scope", "scope");
        const channels = db.createObjectStore("channels", {
          keyPath: ["scope", "channel"],
        });
        channels.createIndex("scope", "scope");
      };
      request.onsuccess = () => {
        if (ended) {
          request.result.close();
          return;
        }
        ended = true;
        clearTimeout(timer);
        resolve(
          new BrowserPrivateOutbox(
            request.result,
            current,
            permission,
            freshRegistration,
            now,
            receiptAuthority,
          ),
        );
      };
    });
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
    const [scope, deviceHash] = await Promise.all([
      digest(["browser-owner:v1", binding.ownerId]),
      digest(["browser-device:v1", binding.ownerId, binding.deviceId]),
    ]);
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
        extra();
      };
      let tx: IDBTransaction;
      try {
        check();
        tx = this.db.transaction(stores, mode, { durability: "strict" });
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
      guard(() =>
        work({
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
        }),
      );
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
          .parse(raw),
        identity = await this.identity(),
        context = this.authority(input.peerId);
      const channel = await digest([
        "browser-channel:v1",
        identity.scope,
        identity.deviceHash,
        context.senderKeyEpoch,
        context.peerId,
        context.peerKeyEpoch,
      ]);
      return this.tx<Entry>(identity, "readwrite", (io) => {
        io.gate(() => {
          if (!same(context, this.authority(input.peerId)))
            throw new BrowserOutboxError("DENIED");
        });
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity);
          io.request(
            io.store("entries").index("scope").count(identity.scope),
            (count) => {
              if (count >= 256) throw new BrowserOutboxError("CAPACITY");
              io.request(
                io.store("channels").get([identity.scope, channel]),
                (raw) => {
                  const previous =
                    raw === undefined
                      ? { scope: identity.scope, channel, next: 1 }
                      : z
                          .strictObject({
                            scope: hex,
                            channel: hex,
                            next: positive,
                          })
                          .parse(raw);
                  if (
                    previous.scope !== identity.scope ||
                    previous.channel !== channel ||
                    previous.next >= Number.MAX_SAFE_INTEGER
                  )
                    throw new BrowserOutboxError("CAPACITY");
                  const issuedAt = this.now(),
                    header = privateHeaderSchema.parse({
                      version: 1,
                      suite: privateEnvelopeSuite,
                      ownerId: identity.binding.ownerId,
                      senderId: identity.binding.deviceId,
                      recipientId: context.peerId,
                      senderKeyEpoch: context.senderKeyEpoch,
                      recipientKeyEpoch: context.peerKeyEpoch,
                      messageId: crypto.randomUUID(),
                      operationId: crypto.randomUUID(),
                      sequence: previous.next,
                      issuedAt,
                      expiresAt: Math.min(
                        issuedAt + 86400000,
                        identity.binding.expiresAt,
                      ),
                    });
                  if (header.expiresAt <= issuedAt)
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
                  });
                  previous.next++;
                  this.bump(meta);
                  io.store("channels").put(previous);
                  io.store("entries").add(entry);
                  io.store("meta").put(meta);
                  io.done(entry);
                },
              );
            },
          );
        });
      });
    });
  }
  commit(raw: unknown) {
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
          });
        });
      });
    });
  }
  delivery(id: string) {
    return this.safe(async () => {
      z.uuid().parse(id);
      const identity = await this.identity();
      return this.tx<PrivateEnvelope>(identity, "readwrite", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          const meta = this.meta(raw, identity);
          io.request(io.store("entries").get(id), (raw) => {
            const entry = this.entry(raw, identity.scope);
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
  private receiptKeys(context: BrowserDeliveryContext) {
    const value = this.receiptAuthority(context.peerId);
    if (
      !value ||
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
  /** Consume authenticated destination acceptance; never accepts plaintext relay status. */
  acceptReceipt(raw: unknown) {
    return this.safe(async () => {
      const envelope = wire(raw),
        h = envelope.header,
        identity = await this.identity();
      const before = await this.tx<Entry>(identity, "readonly", (io) => {
        io.request(io.store("meta").get(identity.scope), (raw) => {
          this.meta(raw, identity);
          io.request(io.store("entries").get(h.operationId), (raw) => {
            const entry = this.entry(raw, identity.scope);
            io.done(entry);
          });
        });
      });
      const original = before.header,
        keys = this.receiptKeys(before.context);
      if (
        !before.envelope ||
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
        this.now,
      );
      let receipt;
      try {
        receipt = privateAcceptedPayloadSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        ).receipt;
      } finally {
        opened.plaintext.fill(0);
      }
      if (
        !same(receipt.header, original) ||
        receipt.acceptedAt >= original.expiresAt ||
        receipt.acceptedAt < original.issuedAt - 30000 ||
        receipt.acceptedAt > this.now() + 30000
      )
        throw new BrowserOutboxError("DENIED");
      const receiptHash = await digest(["browser-receipt:v1", receipt]);
      return this.tx<Entry>(identity, "readwrite", (io) => {
        io.gate(() => {
          const current = this.receiptKeys(before.context);
          if (
            current.privateKey !== keys.privateKey ||
            current.publicKey !== keys.publicKey ||
            current.senderPublicKey !== keys.senderPublicKey ||
            h.expiresAt <= this.now()
          )
            throw new BrowserOutboxError("DENIED");
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
            if (entry.receiptHash) {
              if (entry.receiptHash !== receiptHash)
                throw new BrowserOutboxError("CONFLICT");
              io.done(entry);
              return;
            }
            if (entry.revision >= Number.MAX_SAFE_INTEGER)
              throw new BrowserOutboxError("CAPACITY");
            entry.state = "accepted";
            entry.receiptEnvelope = envelope;
            entry.receiptHash = receiptHash;
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
          remove("entries", () =>
            remove("channels", () => {
              io.store("meta").put(meta);
              io.done(meta);
            }),
          );
        });
      });
    });
  }
}
