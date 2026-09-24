import {
  consumeBrowserIncomingReplay,
  browserIncomingReplayStore,
} from "./browser-incoming-replay.js";
import {
  privateReplayIdentity,
  type PrivateReplayIdentity,
} from "./private-replay.js";
import { z } from "zod";
import {
  BrowserKeyLifecycle,
  browserKeyProofSchema,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import { BrowserPeerEnrollment, BrowserPeerError } from "./browser-peers.js";
import {
  browserPeerProofSchema,
  type BrowserPeerProof,
} from "./browser-peer-state.js";
import {
  browserStoredKeyMatches,
  browserStoredPeerMatches,
} from "./browser-private-authority.js";
import { browserKeyScope, BrowserKeyError } from "./browser-key-state.js";
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import {
  browserStorageTransaction,
  browserStorageError,
  type BrowserStorageIO,
} from "./browser-storage.js";
import {
  BrowserOutboxError,
  browserPrivateIdentity,
  browserPrivateChannel,
  reserveBrowserSequence,
} from "./browser-outbox-state.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  type PrivateEnvelope,
  PrivateEnvelopeError,
  privateHeaderSchema,
  privateEnvelopeSchema,
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  openPrivateEnvelope,
} from "./private-envelope.js";
import {
  peerChallengeSchema,
  peerResponseSchema,
  hashPeerEnvelope,
} from "./peer-check-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/),
  b64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const checked = z.strictObject({ confirmed: z.literal(true) }),
  target = checked.extend({ id: z.uuid() });
const metaId = "00000000-0000-4000-8000-000000000000";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const metaSchema = z.strictObject({
  scope: hex,
  id: z.literal(metaId),
  kind: z.literal("meta"),
  revision: positive,
  deviceHash: hex,
  locked: z.boolean(),
});
type Meta = z.infer<typeof metaSchema>;
const recordSchema = z
  .strictObject({
    scope: hex,
    id: z.uuid().refine((id) => id !== metaId),
    kind: z.literal("check"),
    role: z.enum(["challenge", "response"]),
    revision: positive,
    senderId: z.uuid(),
    operationId: z.uuid(),
    local: browserKeyProofSchema,
    peer: browserPeerProofSchema,
    header: privateHeaderSchema,
    state: z.enum(["preparing", "pending", "verified", "stopped"]),
    preparation: z.strictObject({
      iv: b64.length(16),
      ciphertext: b64.max(2048),
    }),
    preparationKey: z.unknown(),
    envelope: privateEnvelopeSchema.nullable(),
    requestHash: hex.nullable(),
    responseHash: hex.nullable(),
    verifiedAt: positive.nullable(),
  })
  .refine(
    (e) =>
      same(e.local, e.peer.key) &&
      e.header.ownerId === e.local.binding.ownerId &&
      e.header.senderId === e.local.binding.deviceId &&
      e.header.recipientId === e.peer.peerId &&
      e.header.senderKeyEpoch === e.local.keyEpoch &&
      e.header.recipientKeyEpoch === e.peer.keyEpoch &&
      e.header.operationId === e.operationId &&
      e.header.expiresAt - e.header.issuedAt <= 300000 &&
      (e.role === "challenge"
        ? e.id === e.operationId &&
          e.senderId === e.local.binding.deviceId &&
          e.requestHash === null
        : e.senderId === e.peer.peerId && e.requestHash !== null) &&
      (e.state !== "preparing" || e.envelope === null) &&
      (e.state !== "pending" || e.envelope !== null) &&
      (!e.envelope || same(e.envelope.header, e.header)) &&
      (e.state === "verified"
        ? e.role === "challenge" &&
          e.envelope !== null &&
          e.responseHash !== null &&
          e.verifiedAt !== null &&
          e.verifiedAt >= e.header.issuedAt &&
          e.verifiedAt < e.header.expiresAt
        : e.responseHash === null && e.verifiedAt === null),
  );
type Entry = z.infer<typeof recordSchema>;
type Proofs = {
  local: Awaited<ReturnType<BrowserKeyLifecycle["resolve"]>>;
  peer: Awaited<ReturnType<BrowserPeerEnrollment["resolve"]>>;
};
type Guard = { generation: number; wall: number; mono: number };
export class BrowserPeerCheckError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "STORAGE_UNAVAILABLE"
      | "BUSY"
      | "REPAIR_REQUIRED",
  ) {
    super(code);
  }
}
const summary = (e: Entry) => ({
  id: e.id,
  role: e.role,
  revision: e.revision,
  state: e.state,
  peerId: e.peer.peerId,
  expiresAt: e.header.expiresAt,
  verifiedAt: e.verifiedAt,
});
type Summary = ReturnType<typeof summary>;
type Status = {
  revision: number;
  needsFreshDevice: boolean;
  checks: Summary[];
};
const encode = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function decode(s: string) {
  const b = Uint8Array.from(
    atob(s.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(b) !== s) throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
  return b;
}
function preparationKey(raw: unknown): CryptoKey {
  if (
    !(raw instanceof CryptoKey) ||
    raw.type !== "secret" ||
    raw.extractable ||
    raw.algorithm.name !== "AES-GCM" ||
    (raw.algorithm as AesKeyAlgorithm).length !== 256 ||
    !same([...raw.usages].sort(), ["decrypt", "encrypt"])
  )
    throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
  return raw;
}
function read(raw: unknown, scope: string): Entry {
  const e = recordSchema.parse(raw);
  if (e.scope !== scope) throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
  preparationKey(e.preparationKey);
  return e;
}
function aad(
  e: Pick<
    Entry,
    "scope" | "id" | "role" | "operationId" | "local" | "peer" | "requestHash"
  >,
) {
  return new TextEncoder().encode(
    JSON.stringify([
      "browser-peer-check-preparation:v1",
      e.scope,
      e.id,
      e.role,
      e.operationId,
      browserKeyProofSchema.parse(e.local),
      browserPeerProofSchema.parse(e.peer),
      e.requestHash,
    ]),
  );
}
/** Read all rows in the caller's same transaction as a permission/task write.
 * A historical summary or a cached validFor() result is not authority. */
export function browserStoredCheckMatches(
  rows: unknown[],
  scope: string,
  deviceHash: string,
  local: BrowserKeyProof,
  peer: BrowserPeerProof,
  now: number,
) {
  if (rows.length > 257) throw new BrowserPeerCheckError("CAPACITY");
  const parsed = rows.map((raw) => {
    const m = metaSchema.safeParse(raw);
    return m.success ? m.data : read(raw, scope);
  });
  const meta = parsed.find((r) => r.kind === "meta");
  if (
    !meta ||
    meta.scope !== scope ||
    meta.locked ||
    meta.deviceHash !== deviceHash ||
    !same(local, peer.key)
  )
    return false;
  return parsed.some(
    (e) =>
      e.kind === "check" &&
      e.role === "challenge" &&
      e.state === "verified" &&
      e.verifiedAt! <= now &&
      same(e.local, local) &&
      same(e.peer, peer),
  );
}
/** Retained local proof records, not task permission or a network sender. Each side
 * independently challenges. No preparation key/nonce leaves the metadata API.
 * A fresh nonextractable AES key protects each immutable preparation in IndexedDB;
 * it is local restart material, not a new user recovery key or restorable grant. */
export class BrowserPeerChecks {
  private closed = false;
  private generation = 0;
  private busy = false;
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => PrivateBinding | null,
    private keys: BrowserKeyLifecycle,
    private peers: BrowserPeerEnrollment,
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
    owner: string,
    current: () => PrivateBinding | null,
    keys: BrowserKeyLifecycle,
    peers: BrowserPeerEnrollment,
    now = Date.now,
    monotonic = () => performance.now(),
  ) {
    const scope = await browserKeyScope(owner),
      db = await openBrowserPrivateDatabase();
    return new BrowserPeerChecks(
      db,
      owner,
      scope,
      current,
      keys,
      peers,
      now,
      monotonic,
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
  private check(g: Guard, key?: BrowserKeyProof, deadline?: number) {
    if (this.closed) throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
    if (g.generation !== this.generation)
      throw new BrowserPeerCheckError("CONFLICT");
    if (key) {
      const n = this.now(),
        elapsed = this.monotonic() - g.mono,
        b = privateBindingSchema.safeParse(this.current());
      if (
        !b.success ||
        !same(b.data, key.binding) ||
        !Number.isSafeInteger(n) ||
        n < g.wall ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        n >= key.binding.expiresAt ||
        elapsed >= key.binding.expiresAt - g.wall ||
        (deadline !== undefined &&
          (n >= deadline || elapsed >= deadline - g.wall))
      )
        throw new BrowserPeerCheckError("DENIED");
    }
  }
  private async exclusive<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) throw new BrowserPeerCheckError("BUSY");
    this.busy = true;
    const g = {
      generation: this.generation,
      wall: this.now(),
      mono: this.monotonic(),
    };
    try {
      this.check(g);
      const v = await fn(g);
      this.check(g);
      return v;
    } catch (e) {
      if (e instanceof BrowserPeerCheckError) throw e;
      if (e instanceof PrivateEnvelopeError)
        throw new BrowserPeerCheckError("DENIED");
      if (e instanceof BrowserPeerError)
        throw new BrowserPeerCheckError(e.code);
      if (e instanceof BrowserKeyError)
        throw new BrowserPeerCheckError(
          e.code === "MISSING" ||
            e.code === "DELETED" ||
            e.code === "CREATION_INCOMPLETE" ||
            e.code === "SETUP_REQUIRED"
            ? "REPAIR_REQUIRED"
            : e.code,
        );
      if (e instanceof BrowserOutboxError)
        throw new BrowserPeerCheckError(
          e.code === "SETUP_REQUIRED" ? "REPAIR_REQUIRED" : e.code,
        );
      throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
    } finally {
      this.busy = false;
    }
  }
  private input<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new BrowserPeerCheckError("DENIED");
    return p.data;
  }
  private meta(raw: unknown): Meta | null {
    if (raw === undefined) return null;
    const m = metaSchema.parse(raw);
    if (m.scope !== this.scope)
      throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
    return m;
  }
  private bump(m: Meta, io: BrowserStorageIO<unknown>) {
    if (m.revision >= Number.MAX_SAFE_INTEGER)
      throw new BrowserPeerCheckError("CAPACITY");
    m.revision++;
    io.store("peer_checks").put(m);
  }
  private tx<T>(
    g: Guard,
    mode: IDBTransactionMode,
    p: { local: BrowserKeyProof; peer?: BrowserPeerProof } | null,
    deadline: number | undefined,
    work: (io: BrowserStorageIO<T>, meta: Meta | null) => void,
  ) {
    return browserStorageTransaction<T>(
      this.db,
      [
        "slots",
        "lifecycle",
        "peers",
        "peer_checks",
        "channels",
        browserIncomingReplayStore,
      ],
      mode,
      () => this.check(g, p?.local, deadline),
      (io) => {
        const run = () =>
          io.request(io.store("peer_checks").get([this.scope, metaId]), (raw) =>
            work(io, this.meta(raw)),
          );
        if (!p) {
          run();
          return;
        }
        io.request(io.store("lifecycle").get(this.scope), (metadata) =>
          io.request(
            io.store("slots").get([this.scope, p.local.keyId]),
            (slot) => {
              if (
                !browserStoredKeyMatches(
                  metadata,
                  slot,
                  this.owner,
                  this.scope,
                  p.local,
                )
              )
                throw new BrowserPeerCheckError("DENIED");
              if (!p.peer) {
                run();
                return;
              }
              io.request(io.store("peers").get(this.scope), (raw) => {
                if (!browserStoredPeerMatches(raw, this.scope, p.peer!))
                  throw new BrowserPeerCheckError("DENIED");
                run();
              });
            },
          ),
        );
      },
      (e) => (e instanceof BrowserPeerCheckError ? e : browserStorageError(e)),
    );
  }
  private async resolve(g: Guard, peerId: string) {
    const local = await this.keys.resolve();
    this.check(g, local.proof);
    const registry = await this.peers.status(),
      pin = registry.state?.peers.find((p) => p.peerId === peerId);
    if (!pin || pin.revoked) throw new BrowserPeerCheckError("DENIED");
    const peer = await this.peers.resolve(peerId, pin.keyEpoch);
    if (!same(peer.proof.key, local.proof))
      throw new BrowserPeerCheckError("CONFLICT");
    this.check(g, local.proof);
    return { local, peer };
  }
  private proof(p: Proofs) {
    return { local: p.local.proof, peer: p.peer.proof };
  }
  private assertActive(m: Meta | null, deviceHash: string) {
    if (!m || m.locked || m.deviceHash !== deviceHash)
      throw new BrowserPeerCheckError("REPAIR_REQUIRED");
  }
  private async prepare(
    base: Pick<
      Entry,
      "scope" | "id" | "role" | "operationId" | "local" | "peer" | "requestHash"
    >,
    content: unknown,
  ) {
    const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
      iv = crypto.getRandomValues(new Uint8Array(12)),
      bytes = new TextEncoder().encode(JSON.stringify(content));
    try {
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(base), tagLength: 128 },
        key,
        bytes,
      );
      return {
        preparationKey: key,
        preparation: {
          iv: encode(iv),
          ciphertext: encode(new Uint8Array(cipher)),
        },
      };
    } finally {
      bytes.fill(0);
    }
  }
  private async content(e: Entry) {
    const bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(e.preparation.iv),
          additionalData: aad(e),
          tagLength: 128,
        },
        preparationKey(e.preparationKey),
        decode(e.preparation.ciphertext),
      ),
    );
    try {
      const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ),
        v =
          e.role === "challenge"
            ? peerChallengeSchema.parse(raw)
            : peerResponseSchema.parse(raw);
      if (v.type === "peer.key.response" && v.requestHash !== e.requestHash)
        throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
      return v;
    } finally {
      bytes.fill(0);
    }
  }
  private async reserve(
    g: Guard,
    p: Proofs,
    role: Entry["role"],
    operationId: string,
    content: unknown,
    requestHash: string | null,
    deadline: number,
    incoming?: PrivateReplayIdentity,
  ) {
    const identity = await browserPrivateIdentity(p.local.proof.binding),
      channel = await browserPrivateChannel(identity, {
        senderKeyEpoch: p.local.proof.keyEpoch,
        peerId: p.peer.proof.peerId,
        peerKeyEpoch: p.peer.proof.keyEpoch,
      });
    const base = {
        scope: this.scope,
        id: role === "challenge" ? operationId : crypto.randomUUID(),
        role,
        operationId,
        local: p.local.proof,
        peer: p.peer.proof,
        requestHash,
      },
      prepared = await this.prepare(base, content);
    return this.tx<Entry>(
      g,
      "readwrite",
      this.proof(p),
      deadline,
      (io, meta) => {
        const finish = (entry: Entry, retained: boolean) => {
          if (!incoming) {
            io.done(entry);
            return;
          }
          consumeBrowserIncomingReplay(
            io,
            identity.scope,
            incoming,
            { store: "peer_checks", key: [this.scope, entry.id] },
            retained,
            () => io.done(entry),
          );
        };
        const senderId =
          role === "challenge"
            ? p.local.proof.binding.deviceId
            : p.peer.proof.peerId;
        io.request(
          io
            .store("peer_checks")
            .index("operation")
            .get([this.scope, role, senderId, operationId]),
          (raw) => {
            if (raw !== undefined) {
              const old = read(raw, this.scope);
              this.assertActive(meta, identity.deviceHash);
              if (
                old.requestHash !== requestHash ||
                !same(old.local, p.local.proof) ||
                !same(old.peer, p.peer.proof)
              )
                throw new BrowserPeerCheckError("CONFLICT");
              finish(old, true);
              return;
            }
            if (meta) this.assertActive(meta, identity.deviceHash);
            io.request(
              io.store("peer_checks").index("scope").count(this.scope),
              (count) => {
                if (!meta && count > 0)
                  throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
                if (count - (meta ? 1 : 0) >= 256)
                  throw new BrowserPeerCheckError("CAPACITY");
                reserveBrowserSequence(
                  io,
                  identity.scope,
                  channel,
                  (sequence) => {
                    const issuedAt = this.now(),
                      header = privateHeaderSchema.parse({
                        version: 1,
                        suite: privateEnvelopeSuite,
                        ownerId: p.local.proof.binding.ownerId,
                        senderId: p.local.proof.binding.deviceId,
                        recipientId: p.peer.proof.peerId,
                        senderKeyEpoch: p.local.proof.keyEpoch,
                        recipientKeyEpoch: p.peer.proof.keyEpoch,
                        messageId: crypto.randomUUID(),
                        operationId,
                        sequence,
                        issuedAt,
                        expiresAt: Math.min(
                          deadline,
                          issuedAt + 300000,
                          p.local.proof.binding.expiresAt,
                        ),
                      });
                    const e = read(
                      {
                        ...base,
                        ...prepared,
                        kind: "check",
                        revision: 1,
                        senderId,
                        header,
                        state: "preparing",
                        envelope: null,
                        responseHash: null,
                        verifiedAt: null,
                      },
                      this.scope,
                    );
                    io.store("peer_checks").add(e);
                    if (meta) this.bump(meta, io);
                    else
                      io.store("peer_checks").add(
                        metaSchema.parse({
                          scope: this.scope,
                          id: metaId,
                          kind: "meta",
                          revision: 1,
                          deviceHash: identity.deviceHash,
                          locked: false,
                        }),
                      );
                    finish(e, false);
                  },
                );
              },
            );
          },
        );
      },
    );
  }
  private async selected(g: Guard, id: string) {
    return this.tx<Entry>(g, "readonly", null, undefined, (io) =>
      io.request(io.store("peer_checks").get([this.scope, id]), (raw) => {
        if (raw === undefined) throw new BrowserPeerCheckError("DENIED");
        io.done(read(raw, this.scope));
      }),
    );
  }
  private async publish(g: Guard, id: string) {
    const before = await this.selected(g, id),
      p = await this.resolve(g, before.peer.peerId),
      identity = await browserPrivateIdentity(p.local.proof.binding);
    if (
      !same(before.local, p.local.proof) ||
      !same(before.peer, p.peer.proof) ||
      before.state === "stopped" ||
      this.now() < before.header.issuedAt
    )
      throw new BrowserPeerCheckError("DENIED");
    await this.tx(
      g,
      "readonly",
      this.proof(p),
      before.header.expiresAt,
      (io, m) => {
        this.assertActive(m, identity.deviceHash);
        io.request(io.store("peer_checks").get([this.scope, id]), (raw) => {
          if (!same(read(raw, this.scope), before))
            throw new BrowserPeerCheckError("CONFLICT");
          io.done(undefined);
        });
      },
    );
    if (before.state !== "preparing") return summary(before);
    const content = await this.content(before),
      bytes = new TextEncoder().encode(JSON.stringify(content));
    let envelope;
    try {
      this.check(g, p.local.proof, before.header.expiresAt);
      envelope = await sealPrivateEnvelope(
        before.header,
        bytes,
        { senderKey: p.local.pair, recipientPublicKey: p.peer.publicKey },
        this.now,
      );
    } finally {
      bytes.fill(0);
    }
    return this.tx<Summary>(
      g,
      "readwrite",
      this.proof(p),
      before.header.expiresAt,
      (io, m) => {
        this.assertActive(m, identity.deviceHash);
        io.request(io.store("peer_checks").get([this.scope, id]), (raw) => {
          const e = read(raw, this.scope);
          if (e.revision !== before.revision || !same(e, before))
            throw new BrowserPeerCheckError("CONFLICT");
          e.envelope = envelope!;
          e.state = "pending";
          this.save(e, io);
          this.bump(m!, io);
          io.done(summary(e));
        });
      },
    );
  }
  private save(e: Entry, io: BrowserStorageIO<unknown>) {
    if (e.revision >= Number.MAX_SAFE_INTEGER)
      throw new BrowserPeerCheckError("CAPACITY");
    e.revision++;
    io.store("peer_checks").put(read(e, this.scope));
  }
  begin(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
          checked.extend({
            peerId: z.uuid(),
            expectedKeyRevision: revision,
            expectedPeerRevision: revision,
          }),
          raw,
        ),
        p = await this.resolve(g, input.peerId);
      if (
        p.local.proof.revision !== input.expectedKeyRevision ||
        p.peer.proof.revision !== input.expectedPeerRevision
      )
        throw new BrowserPeerCheckError("CONFLICT");
      const e = await this.reserve(
        g,
        p,
        "challenge",
        crypto.randomUUID(),
        {
          version: 1,
          type: "peer.key.challenge",
          challenge: encode(crypto.getRandomValues(new Uint8Array(32))),
        },
        null,
        this.now() + 300000,
      );
      return this.publish(g, e.id);
    });
  }
  private async incoming(g: Guard, raw: unknown) {
    const envelope = this.input(privateEnvelopeSchema, raw),
      h = envelope.header,
      p = await this.resolve(g, h.senderId);
    if (
      h.ownerId !== p.local.proof.binding.ownerId ||
      h.recipientId !== p.local.proof.binding.deviceId ||
      h.recipientKeyEpoch !== p.local.proof.keyEpoch ||
      h.senderKeyEpoch !== p.peer.proof.keyEpoch ||
      h.expiresAt - h.issuedAt > 300000
    )
      throw new BrowserPeerCheckError("DENIED");
    const opened = await openPrivateEnvelope(
      envelope,
      h,
      { recipientKey: p.local.pair, senderPublicKey: p.peer.publicKey },
      this.now,
    );
    let content: unknown;
    try {
      content = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
      );
    } finally {
      opened.plaintext.fill(0);
    }
    this.check(g, p.local.proof, h.expiresAt);
    return { envelope, content, p };
  }
  respond(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
          checked.extend({ envelope: privateEnvelopeSchema }),
          raw,
        ),
        { envelope, content, p } = await this.incoming(g, input.envelope),
        challenge = this.input(peerChallengeSchema, content),
        hash = await hashPeerEnvelope(envelope),
        replay = await privateReplayIdentity(envelope, challenge.type),
        e = await this.reserve(
          g,
          p,
          "response",
          envelope.header.operationId,
          {
            version: 1,
            type: "peer.key.response",
            challenge: challenge.challenge,
            requestHash: hash,
          },
          hash,
          envelope.header.expiresAt,
          replay,
        );
      return this.publish(g, e.id);
    });
  }
  resume(raw: unknown) {
    return this.exclusive((g) => this.publish(g, this.input(target, raw).id));
  }
  delivery(raw: unknown) {
    return this.exclusive(async (g) => {
      const e = await this.selected(g, this.input(target, raw).id),
        p = await this.resolve(g, e.peer.peerId),
        identity = await browserPrivateIdentity(p.local.proof.binding);
      if (
        !same(e.local, p.local.proof) ||
        !same(e.peer, p.peer.proof) ||
        e.state !== "pending" ||
        !e.envelope ||
        this.now() < e.header.issuedAt
      )
        throw new BrowserPeerCheckError("DENIED");
      return this.tx<PrivateEnvelope>(
        g,
        "readonly",
        this.proof(p),
        e.header.expiresAt,
        (io, m) => {
          this.assertActive(m, identity.deviceHash);
          io.request(io.store("peer_checks").get([this.scope, e.id]), (raw) => {
            const latest = read(raw, this.scope);
            if (!same(latest, e)) throw new BrowserPeerCheckError("CONFLICT");
            io.done(structuredClone(e.envelope!));
          });
        },
      );
    });
  }
  complete(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
          checked.extend({ envelope: privateEnvelopeSchema }),
          raw,
        ),
        { envelope, content, p } = await this.incoming(g, input.envelope),
        response = this.input(peerResponseSchema, content),
        before = await this.selected(g, envelope.header.operationId);
      if (
        before.role !== "challenge" ||
        !["pending", "verified"].includes(before.state) ||
        !before.envelope ||
        !same(before.local, p.local.proof) ||
        !same(before.peer, p.peer.proof) ||
        envelope.header.expiresAt > before.header.expiresAt ||
        this.now() < before.header.issuedAt
      )
        throw new BrowserPeerCheckError("DENIED");
      const challenge = await this.content(before);
      if (
        challenge.type !== "peer.key.challenge" ||
        challenge.challenge !== response.challenge ||
        response.requestHash !== (await hashPeerEnvelope(before.envelope))
      )
        throw new BrowserPeerCheckError("DENIED");
      const hash = await hashPeerEnvelope(envelope),
        replay = await privateReplayIdentity(envelope, response.type),
        identity = await browserPrivateIdentity(p.local.proof.binding);
      return this.tx<Summary>(
        g,
        "readwrite",
        this.proof(p),
        Math.min(envelope.header.expiresAt, before.header.expiresAt),
        (io, m) => {
          this.assertActive(m, identity.deviceHash);
          io.request(
            io.store("peer_checks").get([this.scope, before.id]),
            (raw) => {
              const e = read(raw, this.scope);
              if (e.responseHash && e.responseHash !== hash)
                throw new BrowserPeerCheckError("CONFLICT");
              const duplicate =
                e.state === "verified" &&
                e.responseHash === hash &&
                same(e.local, before.local) &&
                same(e.peer, before.peer) &&
                same(e.envelope, before.envelope);
              if (
                !duplicate &&
                (e.revision !== before.revision || !same(e, before))
              )
                throw new BrowserPeerCheckError("CONFLICT");
              consumeBrowserIncomingReplay(
                io,
                identity.scope,
                replay,
                { store: "peer_checks", key: [this.scope, e.id] },
                duplicate,
                () => {
                  if (!duplicate) {
                    e.state = "verified";
                    e.responseHash = hash;
                    e.verifiedAt = this.now();
                    this.save(e, io);
                    this.bump(m!, io);
                  }
                  io.done(summary(e));
                },
              );
            },
          );
        },
      );
    });
  }
  status() {
    return this.exclusive((g) =>
      this.tx<Status>(g, "readonly", null, undefined, (io, m) =>
        io.request(
          io.store("peer_checks").index("scope").getAll(this.scope, 258),
          (rows) => {
            if (rows.length - (m ? 1 : 0) > 256)
              throw new BrowserPeerCheckError("CAPACITY");
            if (!m && rows.length)
              throw new BrowserPeerCheckError("STORAGE_UNAVAILABLE");
            io.done({
              revision: m?.revision ?? 0,
              needsFreshDevice: m?.locked ?? false,
              checks: rows
                .filter((r) => r.id !== metaId)
                .map((r) => summary(read(r, this.scope))),
            });
          },
        ),
      ),
    );
  }
  validFor(local: BrowserKeyProof, peer: BrowserPeerProof) {
    return this.exclusive(async (g) => {
      const l = this.input(browserKeyProofSchema, local),
        p = this.input(browserPeerProofSchema, peer);
      if (!same(l, p.key)) throw new BrowserPeerCheckError("DENIED");
      const identity = await browserPrivateIdentity(l.binding);
      return this.tx<boolean>(
        g,
        "readonly",
        { local: l, peer: p },
        undefined,
        (io, m) => {
          this.assertActive(m, identity.deviceHash);
          io.request(
            io.store("peer_checks").index("scope").getAll(this.scope, 258),
            (rows) => {
              io.done(
                browserStoredCheckMatches(
                  rows,
                  this.scope,
                  identity.deviceHash,
                  l,
                  p,
                  this.now(),
                ),
              );
            },
          );
        },
      );
    }).catch(() => false);
  }
  stop(raw: unknown) {
    return this.exclusive((g) => {
      const input = this.input(
        target.extend({ expectedRevision: positive }),
        raw,
      );
      return this.tx<Summary>(g, "readwrite", null, undefined, (io, m) =>
        io.request(
          io.store("peer_checks").get([this.scope, input.id]),
          (raw) => {
            if (!m) throw new BrowserPeerCheckError("DENIED");
            const e = read(raw, this.scope);
            if (e.revision !== input.expectedRevision)
              throw new BrowserPeerCheckError("CONFLICT");
            if (e.state === "verified")
              throw new BrowserPeerCheckError("DENIED");
            e.state = "stopped";
            this.save(e, io);
            this.bump(m, io);
            io.done(summary(e));
          },
        ),
      );
    });
  }
  clear(raw: unknown) {
    return this.exclusive((g) => {
      const input = this.input(
        checked.extend({ expectedRevision: positive }),
        raw,
      );
      return this.tx<{ revision: number; needsFreshDevice: boolean }>(
        g,
        "readwrite",
        null,
        undefined,
        (io, m) => {
          if (!m || m.revision !== input.expectedRevision)
            throw new BrowserPeerCheckError("CONFLICT");
          io.request(
            io
              .store("peer_checks")
              .index("scope")
              .openCursor(IDBKeyRange.only(this.scope)),
            (cursor) => {
              if (cursor) {
                if (cursor.value.id !== metaId) cursor.delete();
                cursor.continue();
              } else {
                m.locked = true;
                this.bump(m, io);
                io.done({ revision: m.revision, needsFreshDevice: true });
              }
            },
          );
        },
      );
    });
  }
  reset(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
          checked.extend({ expectedRevision: positive }),
          raw,
        ),
        local = await this.keys.resolve(),
        identity = await browserPrivateIdentity(local.proof.binding);
      return this.tx<{ revision: number }>(
        g,
        "readwrite",
        { local: local.proof },
        undefined,
        (io, m) => {
          if (!m || m.revision !== input.expectedRevision)
            throw new BrowserPeerCheckError("CONFLICT");
          if (m.deviceHash === identity.deviceHash)
            throw new BrowserPeerCheckError("REPAIR_REQUIRED");
          m.deviceHash = identity.deviceHash;
          m.locked = false;
          this.bump(m, io);
          io.done({ revision: m.revision });
        },
      );
    });
  }
}
