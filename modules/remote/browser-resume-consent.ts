import {
  consumeBrowserIncomingReplay,
  browserIncomingReplayStore,
} from "./browser-incoming-replay.js";
import {
  privateReplayIdentity,
  privateReplayIdentitySchema,
  type PrivateReplayIdentity,
} from "./private-replay.js";
import { z } from "zod";
import {
  BrowserKeyLifecycle,
  browserKeyProofSchema,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import { BrowserPeerEnrollment } from "./browser-peers.js";
import {
  browserPeerProofSchema,
  type BrowserPeerProof,
} from "./browser-peer-state.js";
import { browserKeyScope } from "./browser-key-state.js";
import {
  browserStoredKeyMatches,
  browserStoredPeerMatches,
} from "./browser-private-authority.js";
import { browserStoredCheckMatches } from "./browser-peer-checks.js";
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import {
  browserStorageTransaction,
  type BrowserStorageIO,
} from "./browser-storage.js";
import {
  BrowserOutboxError,
  browserPrivateIdentity,
} from "./browser-outbox-state.js";
import { privateResumeOfferSchema } from "./private-resume-contracts.js";
import {
  privateEnvelopeSchema,
  openPrivateEnvelope,
  PrivateEnvelopeError,
} from "./private-envelope.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/),
  b64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const offerInputSchema = z.strictObject({
  expectedRevision: revision,
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  envelope: privateEnvelopeSchema,
});
const choicesSchema = z.strictObject({
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  permissionId: z.uuid(),
  taskId: z.uuid(),
  taskRevision: positive,
  modelDigest: hex,
  expiresAt: positive,
});
const channel = (v: z.infer<typeof choicesSchema>) =>
  JSON.stringify([v.peerId, v.taskId]);
export const browserResumeGrantSchema = z
  .strictObject({
    id: z.uuid(),
    revision: positive,
    approvedAt: positive,
    revoked: z.boolean(),
    choices: choicesSchema,
    offer: privateResumeOfferSchema,
    offerReplay: privateReplayIdentitySchema.extend({
      type: z.literal("task.resume.offer"),
    }),
    local: browserKeyProofSchema,
    peer: browserPeerProofSchema,
  })
  .refine(
    (v) =>
      same(v.local, v.peer.key) &&
      v.choices.permissionId === v.offer.permissionId &&
      v.choices.taskId === v.offer.taskId &&
      v.choices.taskRevision === v.offer.taskRevision &&
      v.choices.modelDigest === v.offer.modelDigest &&
      v.choices.expiresAt <= v.offer.expiresAt &&
      v.offer.issuedAt <= v.approvedAt + 30000 &&
      v.choices.peerId === v.peer.peerId &&
      v.choices.peerKeyEpoch === v.peer.keyEpoch &&
      v.approvedAt < v.choices.expiresAt &&
      v.choices.expiresAt <= v.local.binding.expiresAt &&
      v.choices.expiresAt - v.approvedAt <= 86400000,
  );
const grantsSchema = z
  .array(browserResumeGrantSchema)
  .max(64)
  .refine(
    (v) =>
      new Set(v.map((g) => channel(g.choices))).size === v.length &&
      new Set(v.map((g) => g.id)).size === v.length,
  );
const rowSchema = z
  .strictObject({
    scope: hex,
    deviceHash: hex,
    revision: positive,
    locked: z.boolean(),
    iv: b64.length(16).nullable(),
    ciphertext: b64.max(262144).nullable(),
    key: z.unknown(),
  })
  .refine((v) =>
    v.locked
      ? v.iv === null && v.ciphertext === null && v.key === null
      : !!v.iv && !!v.ciphertext && !!v.key,
  );
type Grant = z.infer<typeof browserResumeGrantSchema>;
type Row = z.infer<typeof rowSchema>;
type Choices = z.infer<typeof choicesSchema>;
type Guard = { generation: number; wall: number; mono: number };
type Proof = {
  local: BrowserKeyProof;
  peer: BrowserPeerProof;
  deviceHash: string;
};
type Prepared = {
  id: string;
  expectedRevision: number;
  row: Row | null;
  grants: Grant[];
  choices: Choices;
  offer: z.infer<typeof privateResumeOfferSchema>;
  replay: PrivateReplayIdentity;
  proof: Proof;
  guard: Guard;
  expiresAt: number;
};
const stores = [
  "lifecycle",
  "slots",
  "peers",
  "peer_checks",
  "resume_consents",
  browserIncomingReplayStore,
];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const encode = (v: Uint8Array) => {
  let value = "";
  for (let i = 0; i < v.length; i += 4096)
    value += String.fromCharCode(...v.subarray(i, i + 4096));
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};
function decode(v: string) {
  const b = Uint8Array.from(
    atob(v.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(b) !== v) throw Error();
  return b;
}
function retainedKey(v: unknown): CryptoKey {
  if (
    !(v instanceof CryptoKey) ||
    v.type !== "secret" ||
    v.extractable ||
    v.algorithm.name !== "AES-GCM" ||
    (v.algorithm as AesKeyAlgorithm).length !== 256 ||
    !same([...v.usages].sort(), ["decrypt", "encrypt"])
  )
    throw Error();
  return v;
}
const aad = (r: Pick<Row, "scope" | "deviceHash" | "revision" | "locked">) =>
  new TextEncoder().encode(
    JSON.stringify([
      "browser-resume-consent:v1",
      r.scope,
      r.deviceHash,
      r.revision,
      r.locked,
    ]),
  );
export class BrowserResumeConsentError extends Error {
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
function normalize(e: unknown) {
  if (e instanceof BrowserResumeConsentError) return e;
  if (e instanceof PrivateEnvelopeError)
    return new BrowserResumeConsentError("DENIED");
  if (
    e instanceof Error &&
    ["DENIED", "CONFLICT", "CAPACITY", "BUSY", "STORAGE_UNAVAILABLE"].includes(
      e.message,
    )
  )
    return new BrowserResumeConsentError(
      e.message as BrowserResumeConsentError["code"],
    );
  if (
    e instanceof Error &&
    [
      "SETUP_REQUIRED",
      "MISSING",
      "DELETED",
      "CREATION_INCOMPLETE",
      "REPAIR_REQUIRED",
    ].includes(e.message)
  )
    return new BrowserResumeConsentError("REPAIR_REQUIRED");
  return new BrowserResumeConsentError(
    e instanceof DOMException && e.name === "QuotaExceededError"
      ? "CAPACITY"
      : "STORAGE_UNAVAILABLE",
  );
}
/** Separate browser consent for one authenticated Mac offer. No task or source
 * authority is inherited. A future transport must call the returned guard within
 * its content/replay transaction; resolving a grant alone never authorizes delivery. */
export class BrowserResumeConsent {
  private closed = false;
  private busy = false;
  private generation = 0;
  private pending?: Prepared;
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
    return new BrowserResumeConsent(
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
    this.pending = undefined;
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private input<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new BrowserResumeConsentError("DENIED");
    return p.data;
  }
  private check(g: Guard, local?: BrowserKeyProof, expiresAt?: number) {
    if (this.closed) throw new BrowserResumeConsentError("STORAGE_UNAVAILABLE");
    if (this.generation !== g.generation)
      throw new BrowserResumeConsentError("CONFLICT");
    const n = this.now(),
      elapsed = this.monotonic() - g.mono;
    if (
      !Number.isSafeInteger(n) ||
      n < g.wall ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= 120000 ||
      (expiresAt !== undefined &&
        (n >= expiresAt || elapsed >= expiresAt - g.wall))
    )
      throw new BrowserResumeConsentError("DENIED");
    if (local) {
      const b = privateBindingSchema.safeParse(this.current());
      if (
        !b.success ||
        !same(b.data, local.binding) ||
        n >= b.data.expiresAt ||
        elapsed >= b.data.expiresAt - g.wall
      )
        throw new BrowserResumeConsentError("DENIED");
    }
  }
  private async exclusive<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) throw new BrowserResumeConsentError("BUSY");
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
    } catch (e) {
      throw normalize(e);
    } finally {
      this.busy = false;
    }
  }
  private row(raw: unknown): Row | null {
    if (raw === undefined) return null;
    const r = rowSchema.parse(raw);
    if (r.scope !== this.scope) throw Error();
    if (!r.locked) retainedKey(r.key);
    return r;
  }
  private validate<T>(io: BrowserStorageIO<T>, proof: Proof, next: () => void) {
    io.request(io.store("lifecycle").get(this.scope), (metadata) =>
      io.request(
        io.store("slots").get([this.scope, proof.local.keyId]),
        (slot) => {
          if (
            !browserStoredKeyMatches(
              metadata,
              slot,
              this.owner,
              this.scope,
              proof.local,
            )
          )
            throw new BrowserOutboxError("DENIED");
          io.request(io.store("peers").get(this.scope), (peer) => {
            if (!browserStoredPeerMatches(peer, this.scope, proof.peer))
              throw new BrowserOutboxError("DENIED");
            io.request(
              io.store("peer_checks").index("scope").getAll(this.scope, 258),
              (rows) => {
                if (
                  !browserStoredCheckMatches(
                    rows,
                    this.scope,
                    proof.deviceHash,
                    proof.local,
                    proof.peer,
                    this.now(),
                  )
                )
                  throw new BrowserOutboxError("DENIED");
                next();
              },
            );
          });
        },
      ),
    );
  }
  private tx<T>(
    g: Guard,
    mode: IDBTransactionMode,
    proof: Proof | null,
    work: (io: BrowserStorageIO<T>, row: Row | null) => void,
    expiresAt?: number,
  ) {
    return browserStorageTransaction<T>(
      this.db,
      stores,
      mode,
      () => this.check(g, proof?.local, expiresAt),
      (io) => {
        const run = () =>
          io.request(io.store("resume_consents").get(this.scope), (raw) =>
            work(io, this.row(raw)),
          );
        if (proof) this.validate(io, proof, run);
        else run();
      },
      normalize,
    );
  }
  private async read(g: Guard) {
    const row = await this.tx<Row | null>(g, "readonly", null, (io, row) =>
      io.done(row),
    );
    let grants: Grant[] = [];
    if (row && !row.locked) {
      const bytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(row.iv!), additionalData: aad(row) },
          retainedKey(row.key),
          decode(row.ciphertext!),
        ),
      );
      try {
        grants = grantsSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } finally {
        bytes.fill(0);
      }
      if (grants.some((g) => g.revision > row.revision)) throw Error();
    }
    this.check(g);
    await this.tx(g, "readonly", null, (io, current) => {
      if (!same(row, current)) throw new BrowserResumeConsentError("CONFLICT");
      io.done(null);
    });
    return { row, grants };
  }
  private async encrypted(
    row: Row,
    grants: Grant[],
    key?: CryptoKey,
  ): Promise<Row> {
    const k =
      key ??
      (await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ));
    const iv = crypto.getRandomValues(new Uint8Array(12)),
      bytes = new TextEncoder().encode(
        JSON.stringify(grantsSchema.parse(grants)),
      );
    try {
      if (bytes.byteLength > 128 * 1024)
        throw new BrowserResumeConsentError("CAPACITY");
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad(row) },
          k,
          bytes,
        ),
      );
      return rowSchema.parse({
        ...row,
        iv: encode(iv),
        ciphertext: encode(ciphertext),
        key: k,
      });
    } finally {
      bytes.fill(0);
    }
  }
  private next(row: Row | null) {
    if ((row?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
      throw new BrowserResumeConsentError("CAPACITY");
    return (row?.revision ?? 0) + 1;
  }
  private async proofs(g: Guard, peerId: string, epoch: number) {
    const local = await this.keys.resolve();
    this.check(g, local.proof);
    const peer = await this.peers.resolve(peerId, epoch);
    if (!same(local.proof, peer.proof.key))
      throw new BrowserResumeConsentError("CONFLICT");
    const identity = await browserPrivateIdentity(local.proof.binding);
    this.check(g, local.proof);
    return {
      local,
      peer,
      proof: {
        local: local.proof,
        peer: peer.proof,
        deviceHash: identity.deviceHash,
      },
    };
  }
  private active(row: Row | null, deviceHash: string) {
    if (row && (row.locked || row.deviceHash !== deviceHash))
      throw new BrowserResumeConsentError("REPAIR_REQUIRED");
  }
  status() {
    return this.exclusive(async (g) => {
      const value = await this.read(g);
      return {
        revision: value.row?.revision ?? 0,
        needsFreshDevice: value.row?.locked ?? false,
        grants: value.grants,
      };
    });
  }
  private async openOffer(g: Guard, input: z.infer<typeof offerInputSchema>) {
    const { row, grants } = await this.read(g),
      p = await this.proofs(g, input.peerId, input.peerKeyEpoch);
    if ((row?.revision ?? 0) !== input.expectedRevision)
      throw new BrowserResumeConsentError("CONFLICT");
    this.active(row, p.proof.deviceHash);
    const h = input.envelope.header,
      b = p.proof.local.binding;
    if (
      h.ownerId !== b.ownerId ||
      h.recipientId !== b.deviceId ||
      h.recipientKeyEpoch !== p.proof.local.keyEpoch ||
      h.senderId !== input.peerId ||
      h.senderKeyEpoch !== input.peerKeyEpoch
    )
      throw new BrowserResumeConsentError("DENIED");
    const opened = await openPrivateEnvelope(
      input.envelope,
      h,
      { recipientKey: p.local.pair, senderPublicKey: p.peer.publicKey },
      this.now,
    );
    let offer: z.infer<typeof privateResumeOfferSchema>;
    try {
      offer = this.input(
        privateResumeOfferSchema,
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
        ),
      );
    } catch {
      throw new BrowserResumeConsentError("DENIED");
    } finally {
      opened.plaintext.fill(0);
    }
    const n = this.now();
    if (
      offer.issuedAt > n + 30000 ||
      offer.expiresAt <= n ||
      h.expiresAt > offer.expiresAt
    )
      throw new BrowserResumeConsentError("DENIED");
    await this.tx(
      g,
      "readonly",
      p.proof,
      (io, current) => {
        if (!same(current, row))
          throw new BrowserResumeConsentError("CONFLICT");
        io.done(null);
      },
      h.expiresAt,
    );
    return { row, grants, p, offer, h, b };
  }
  /** Authenticate an offer before showing choices. No permission is selected,
   * pending approval created, replay identity consumed or persistent row written. */
  inspectOffer(raw: unknown) {
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(offerInputSchema, raw),
        opened = await this.openOffer(g, input);
      return structuredClone({
        expectedRevision: input.expectedRevision,
        offer: opened.offer,
        local: opened.p.proof.local,
        peer: opened.p.proof.peer,
        openingExpiresAt: opened.h.expiresAt,
      });
    });
  }
  prepare(raw: unknown) {
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(
          offerInputSchema.extend({
            expiresAt: positive,
          }),
          raw,
        ),
        { row, grants, p, offer, h, b } = await this.openOffer(g, input),
        replay = await privateReplayIdentity(input.envelope, offer.type),
        n = this.now();
      if (
        input.expiresAt <= n ||
        input.expiresAt > Math.min(n + 86400000, b.expiresAt, offer.expiresAt)
      )
        throw new BrowserResumeConsentError("DENIED");
      const choices = choicesSchema.parse({
        peerId: input.peerId,
        peerKeyEpoch: input.peerKeyEpoch,
        permissionId: offer.permissionId,
        taskId: offer.taskId,
        taskRevision: offer.taskRevision,
        modelDigest: offer.modelDigest,
        expiresAt: input.expiresAt,
      });
      if (
        grants.length >= 64 &&
        !grants.some((v) => channel(v.choices) === channel(choices))
      )
        throw new BrowserResumeConsentError("CAPACITY");
      await this.tx(
        g,
        "readonly",
        p.proof,
        (io, current) => {
          if (!same(current, row))
            throw new BrowserResumeConsentError("CONFLICT");
          io.done(null);
        },
        input.expiresAt,
      );
      const expiresAt = Math.min(g.wall + 120000, input.expiresAt, h.expiresAt),
        id = crypto.randomUUID();
      this.pending = {
        id,
        expectedRevision: input.expectedRevision,
        choices,
        offer,
        replay,
        row,
        grants,
        proof: p.proof,
        guard: g,
        expiresAt,
      };
      return structuredClone({
        reviewId: id,
        expectedRevision: input.expectedRevision,
        choices,
        offer,
        local: p.proof.local,
        peer: p.proof.peer,
        expiresAt,
      });
    });
  }
  approve(raw: unknown) {
    const r = this.pending;
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(
        z.strictObject({
          reviewId: z.uuid(),
          expectedRevision: revision,
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        }),
        raw,
      );
      if (
        !r ||
        input.reviewId !== r.id ||
        input.expectedRevision !== r.expectedRevision
      )
        throw new BrowserResumeConsentError("CONFLICT");
      this.check(r.guard, r.proof.local, r.expiresAt);
      const p = await this.proofs(g, r.choices.peerId, r.choices.peerKeyEpoch);
      if (!same(p.proof, r.proof))
        throw new BrowserResumeConsentError("CONFLICT");
      const identity = await browserPrivateIdentity(p.local.proof.binding),
        prior = r.grants.find((v) => channel(v.choices) === channel(r.choices)),
        retained =
          !!prior &&
          same(prior.offerReplay, r.replay) &&
          same(prior.offer, r.offer),
        next = this.next(r.row),
        grant = browserResumeGrantSchema.parse({
          id: crypto.randomUUID(),
          revision: next,
          approvedAt: this.now(),
          revoked: false,
          choices: r.choices,
          offer: r.offer,
          offerReplay: r.replay,
          local: p.proof.local,
          peer: p.proof.peer,
        });
      const grants = [
        ...r.grants.filter((v) => channel(v.choices) !== channel(r.choices)),
        grant,
      ];
      const row = await this.encrypted(
        {
          scope: this.scope,
          deviceHash: p.proof.deviceHash,
          revision: next,
          locked: false,
          iv: null,
          ciphertext: null,
          key: null,
        },
        grants,
        r.row ? retainedKey(r.row.key) : undefined,
      );
      this.check(r.guard, r.proof.local, r.expiresAt);
      return this.tx<Grant>(
        r.guard,
        "readwrite",
        p.proof,
        (io, current) => {
          this.check(r.guard, r.proof.local, r.expiresAt);
          if (!same(current, r.row))
            throw new BrowserResumeConsentError("CONFLICT");
          this.active(current, p.proof.deviceHash);
          const write = () =>
            consumeBrowserIncomingReplay(
              io,
              identity.scope,
              r.replay,
              // The durable outcome is this original authenticated offer, retained
              // inside the encrypted grant. Explicit new reviews may change consent
              // IDs/choices while preserving that offer identity. Superseded offers
              // cannot recreate a missing original outcome or renew old authority.
              {
                store: "resume_consents",
                key: [this.scope, r.replay.operation],
              },
              retained,
              () => {
                io.store("resume_consents").put(row);
                io.done(structuredClone(grant));
              },
            );
          if (current) write();
          else
            io.request(io.store("resume_consents").count(), (count) => {
              if (count >= 32) throw new BrowserResumeConsentError("CAPACITY");
              write();
            });
        },
        r.expiresAt,
      );
    });
  }
  revoke(raw: unknown) {
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(
          z.strictObject({
            grantId: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        { row, grants } = await this.read(g);
      if (!row || row.locked || row.revision !== input.expectedRevision)
        throw new BrowserResumeConsentError("CONFLICT");
      const selected = grants.find((v) => v.id === input.grantId);
      if (!selected || selected.revoked)
        throw new BrowserResumeConsentError("DENIED");
      const rev = this.next(row);
      selected.revoked = true;
      selected.revision = rev;
      const next = await this.encrypted(
        { ...row, revision: rev },
        grants,
        retainedKey(row.key),
      );
      return this.tx(g, "readwrite", null, (io, current) => {
        if (!same(current, row))
          throw new BrowserResumeConsentError("CONFLICT");
        io.store("resume_consents").put(next);
        io.done({ revision: rev });
      });
    });
  }
  clear(raw: unknown) {
    this.pending = undefined;
    return this.exclusive((g) => {
      const input = this.input(
        z.strictObject({
          expectedRevision: positive,
          confirmed: z.literal(true),
        }),
        raw,
      );
      return this.tx(g, "readwrite", null, (io, row) => {
        if (!row || row.revision !== input.expectedRevision)
          throw new BrowserResumeConsentError("CONFLICT");
        const next = rowSchema.parse({
          ...row,
          revision: this.next(row),
          locked: true,
          iv: null,
          ciphertext: null,
          key: null,
        });
        io.store("resume_consents").put(next);
        io.done({ revision: next.revision, needsFreshDevice: true });
      });
    });
  }
  reset(raw: unknown) {
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(
          z.strictObject({
            expectedRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        { row } = await this.read(g),
        local = await this.keys.resolve(),
        identity = await browserPrivateIdentity(local.proof.binding);
      this.check(g, local.proof);
      if (!row || row.revision !== input.expectedRevision)
        throw new BrowserResumeConsentError("CONFLICT");
      if (row.deviceHash === identity.deviceHash)
        throw new BrowserResumeConsentError("REPAIR_REQUIRED");
      const next = await this.encrypted(
        {
          ...row,
          deviceHash: identity.deviceHash,
          revision: this.next(row),
          locked: false,
        },
        [],
      );
      return this.tx(g, "readwrite", null, (io, current) => {
        this.check(g, local.proof);
        if (!same(current, row))
          throw new BrowserResumeConsentError("CONFLICT");
        io.request(io.store("lifecycle").get(this.scope), (metadata) =>
          io.request(
            io.store("slots").get([this.scope, local.proof.keyId]),
            (slot) => {
              if (
                !browserStoredKeyMatches(
                  metadata,
                  slot,
                  this.owner,
                  this.scope,
                  local.proof,
                )
              )
                throw new BrowserResumeConsentError("DENIED");
              io.store("resume_consents").put(next);
              io.done({ revision: next.revision });
            },
          ),
        );
      });
    });
  }

  authorize(grantId: string, rawTask: unknown) {
    return this.exclusive(async (g) => {
      this.input(z.uuid(), grantId);
      const task = this.input(
        z.strictObject({
          permissionId: z.uuid(),
          taskId: z.uuid(),
          taskRevision: positive,
          modelDigest: hex,
        }),
        rawTask,
      );
      const { row, grants } = await this.read(g),
        grant = grants.find((v) => v.id === grantId);
      if (
        !grant ||
        grant.revoked ||
        task.permissionId !== grant.choices.permissionId ||
        task.taskId !== grant.choices.taskId ||
        task.taskRevision !== grant.choices.taskRevision ||
        task.modelDigest !== grant.choices.modelDigest
      )
        throw new BrowserResumeConsentError("DENIED");
      const p = await this.proofs(
        g,
        grant.choices.peerId,
        grant.choices.peerKeyEpoch,
      );
      this.active(row, p.proof.deviceHash);
      if (
        !same(grant.local, p.proof.local) ||
        !same(grant.peer, p.proof.peer) ||
        grant.approvedAt > this.now()
      )
        throw new BrowserResumeConsentError("DENIED");
      const check = () => this.check(g, p.proof.local, grant.choices.expiresAt);
      check();
      const validate = <T>(io: BrowserStorageIO<T>, next: () => void) => {
        check();
        this.validate(io, p.proof, () =>
          io.request(io.store("resume_consents").get(this.scope), (raw) => {
            check();
            if (!same(this.row(raw), row))
              throw new BrowserResumeConsentError("DENIED");
            next();
          }),
        );
      };
      await this.tx(
        g,
        "readonly",
        p.proof,
        (io, current) => {
          if (!same(current, row))
            throw new BrowserResumeConsentError("CONFLICT");
          io.done(null);
        },
        grant.choices.expiresAt,
      );
      return {
        grant: structuredClone(grant),
        stores: [...stores],
        check,
        validate,
        localKey: p.local.pair,
        peerPublicKey: p.peer.publicKey,
      };
    });
  }
}
