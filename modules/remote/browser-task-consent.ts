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
  BrowserPrivateOutbox,
  type BrowserOutboxAuthorization,
} from "./browser-outbox.js";
import {
  BrowserOutboxError,
  browserPrivateIdentity,
  type BrowserDeliveryContext,
} from "./browser-outbox-state.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import { privateTaskPayloadSchema } from "./private-task-contracts.js";
import { sealPrivateEnvelope } from "./private-envelope.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/),
  b64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const choicesSchema = z
  .strictObject({
    peerId: z.uuid(),
    peerKeyEpoch: positive,
    sendTasks: z.boolean(),
    receiveResults: z.boolean(),
    expiresAt: positive,
  })
  .refine((v) => v.sendTasks);
const grantSchema = z
  .strictObject({
    id: z.uuid(),
    revision: positive,
    approvedAt: positive,
    revoked: z.boolean(),
    choices: choicesSchema,
    local: browserKeyProofSchema,
    peer: browserPeerProofSchema,
  })
  .refine(
    (v) =>
      same(v.local, v.peer.key) &&
      v.choices.peerId === v.peer.peerId &&
      v.choices.peerKeyEpoch === v.peer.keyEpoch &&
      v.approvedAt < v.choices.expiresAt &&
      v.choices.expiresAt <= v.local.binding.expiresAt &&
      v.choices.expiresAt - v.approvedAt <= 86400000,
  );
const grantsSchema = z
  .array(grantSchema)
  .max(20)
  .refine(
    (v) =>
      new Set(v.map((g) => g.choices.peerId)).size === v.length &&
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
type Grant = z.infer<typeof grantSchema>;
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
  proof: Proof;
  guard: Guard;
  expiresAt: number;
};
const stores = ["lifecycle", "slots", "peers", "peer_checks", "task_consents"];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const encode = (v: Uint8Array) =>
  btoa(String.fromCharCode(...v))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
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
      "browser-task-consent:v1",
      r.scope,
      r.deviceHash,
      r.revision,
      r.locked,
    ]),
  );
export class BrowserTaskConsentError extends Error {
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
  if (e instanceof BrowserTaskConsentError) return e;
  if (
    e instanceof Error &&
    ["DENIED", "CONFLICT", "CAPACITY", "BUSY", "STORAGE_UNAVAILABLE"].includes(
      e.message,
    )
  )
    return new BrowserTaskConsentError(
      e.message as BrowserTaskConsentError["code"],
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
    return new BrowserTaskConsentError("REPAIR_REQUIRED");
  return new BrowserTaskConsentError(
    e instanceof DOMException && e.name === "QuotaExceededError"
      ? "CAPACITY"
      : "STORAGE_UNAVAILABLE",
  );
}
/** Browser is a task sender/result reader, not an inference endpoint. Choices are
 * encrypted locally; every use validates the retained rows in the task transaction.
 * Exported summaries and restored ciphertext are never authority. */
export class BrowserTaskConsent {
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
    return new BrowserTaskConsent(
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
    if (!p.success) throw new BrowserTaskConsentError("DENIED");
    return p.data;
  }
  private check(g: Guard, local?: BrowserKeyProof, expiresAt?: number) {
    if (this.closed) throw new BrowserTaskConsentError("STORAGE_UNAVAILABLE");
    if (this.generation !== g.generation)
      throw new BrowserTaskConsentError("CONFLICT");
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
      throw new BrowserTaskConsentError("DENIED");
    if (local) {
      const b = privateBindingSchema.safeParse(this.current());
      if (
        !b.success ||
        !same(b.data, local.binding) ||
        n >= b.data.expiresAt ||
        elapsed >= b.data.expiresAt - g.wall
      )
        throw new BrowserTaskConsentError("DENIED");
    }
  }
  private async exclusive<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) throw new BrowserTaskConsentError("BUSY");
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
          io.request(io.store("task_consents").get(this.scope), (raw) =>
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
      if (!same(row, current)) throw new BrowserTaskConsentError("CONFLICT");
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
        throw new BrowserTaskConsentError("CAPACITY");
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
      throw new BrowserTaskConsentError("CAPACITY");
    return (row?.revision ?? 0) + 1;
  }
  private async proofs(g: Guard, peerId: string, epoch: number) {
    const local = await this.keys.resolve();
    this.check(g, local.proof);
    const peer = await this.peers.resolve(peerId, epoch);
    if (!same(local.proof, peer.proof.key))
      throw new BrowserTaskConsentError("CONFLICT");
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
      throw new BrowserTaskConsentError("REPAIR_REQUIRED");
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
  prepare(raw: unknown) {
    this.pending = undefined;
    return this.exclusive(async (g) => {
      const input = this.input(
          z.strictObject({
            expectedRevision: revision,
            choices: choicesSchema,
          }),
          raw,
        ),
        { row, grants } = await this.read(g),
        p = await this.proofs(
          g,
          input.choices.peerId,
          input.choices.peerKeyEpoch,
        );
      if ((row?.revision ?? 0) !== input.expectedRevision)
        throw new BrowserTaskConsentError("CONFLICT");
      this.active(row, p.proof.deviceHash);
      const n = this.now();
      if (
        input.choices.expiresAt <= n ||
        input.choices.expiresAt >
          Math.min(n + 86400000, p.proof.local.binding.expiresAt)
      )
        throw new BrowserTaskConsentError("DENIED");
      if (
        grants.length >= 20 &&
        !grants.some((v) => v.choices.peerId === input.choices.peerId)
      )
        throw new BrowserTaskConsentError("CAPACITY");
      await this.tx(
        g,
        "readonly",
        p.proof,
        (io, current) => {
          if (!same(current, row))
            throw new BrowserTaskConsentError("CONFLICT");
          io.done(null);
        },
        input.choices.expiresAt,
      );
      const expiresAt = Math.min(g.wall + 120000, input.choices.expiresAt),
        id = crypto.randomUUID();
      this.pending = {
        id,
        expectedRevision: input.expectedRevision,
        choices: input.choices,
        row,
        grants,
        proof: p.proof,
        guard: g,
        expiresAt,
      };
      return structuredClone({
        reviewId: id,
        expectedRevision: input.expectedRevision,
        choices: input.choices,
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
        throw new BrowserTaskConsentError("CONFLICT");
      this.check(r.guard, r.proof.local, r.expiresAt);
      const p = await this.proofs(g, r.choices.peerId, r.choices.peerKeyEpoch);
      if (!same(p.proof, r.proof))
        throw new BrowserTaskConsentError("CONFLICT");
      const next = this.next(r.row),
        grant = grantSchema.parse({
          id: crypto.randomUUID(),
          revision: next,
          approvedAt: this.now(),
          revoked: false,
          choices: r.choices,
          local: p.proof.local,
          peer: p.proof.peer,
        });
      const grants = [
        ...r.grants.filter((v) => v.choices.peerId !== r.choices.peerId),
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
            throw new BrowserTaskConsentError("CONFLICT");
          this.active(current, p.proof.deviceHash);
          const write = () => {
            io.store("task_consents").put(row);
            io.done(structuredClone(grant));
          };
          if (current) write();
          else
            io.request(io.store("task_consents").count(), (count) => {
              if (count >= 32) throw new BrowserTaskConsentError("CAPACITY");
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
            peerId: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        { row, grants } = await this.read(g);
      if (!row || row.locked || row.revision !== input.expectedRevision)
        throw new BrowserTaskConsentError("CONFLICT");
      const selected = grants.find((v) => v.choices.peerId === input.peerId);
      if (!selected) throw new BrowserTaskConsentError("DENIED");
      const rev = this.next(row);
      selected.revoked = true;
      selected.revision = rev;
      const next = await this.encrypted(
        { ...row, revision: rev },
        grants,
        retainedKey(row.key),
      );
      return this.tx(g, "readwrite", null, (io, current) => {
        if (!same(current, row)) throw new BrowserTaskConsentError("CONFLICT");
        io.store("task_consents").put(next);
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
          throw new BrowserTaskConsentError("CONFLICT");
        const next = rowSchema.parse({
          ...row,
          revision: this.next(row),
          locked: true,
          iv: null,
          ciphertext: null,
          key: null,
        });
        io.store("task_consents").put(next);
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
        throw new BrowserTaskConsentError("CONFLICT");
      if (row.deviceHash === identity.deviceHash)
        throw new BrowserTaskConsentError("REPAIR_REQUIRED");
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
        if (!same(current, row)) throw new BrowserTaskConsentError("CONFLICT");
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
                throw new BrowserTaskConsentError("DENIED");
              io.store("task_consents").put(next);
              io.done({ revision: next.revision });
            },
          ),
        );
      });
    });
  }
  /** Internal operation-scoped sender. No key handles are returned. The caller
   * keeps verified identity alive until the operation and final check complete. */
  authorize(
    peerId: string,
    peerKeyEpoch: number,
    freshRegistration: () => PrivateBinding | null = () => null,
    operationCheck: () => void = () => {},
  ) {
    return this.exclusive(async (g) => {
      operationCheck();
      this.input(z.uuid(), peerId);
      this.input(positive, peerKeyEpoch);
      const { row, grants } = await this.read(g),
        p = await this.proofs(g, peerId, peerKeyEpoch),
        grant = grants.find((v) => v.choices.peerId === peerId);
      this.active(row, p.proof.deviceHash);
      if (
        !row ||
        !grant ||
        grant.revoked ||
        !grant.choices.sendTasks ||
        !same(grant.local, p.proof.local) ||
        !same(grant.peer, p.proof.peer) ||
        grant.approvedAt > this.now()
      )
        throw new BrowserTaskConsentError("DENIED");
      this.check(g, p.proof.local, grant.choices.expiresAt);
      const check = () => {
        try {
          operationCheck();
          this.check(g, p.proof.local, grant.choices.expiresAt);
        } catch {
          throw new BrowserOutboxError("DENIED");
        }
      };
      const context: BrowserDeliveryContext = {
        binding: p.proof.local.binding,
        senderKeyEpoch: p.proof.local.keyEpoch,
        peerId,
        peerKeyEpoch,
        peerRevision: p.proof.peer.revision,
        peerFingerprint: p.proof.peer.fingerprint,
        permissionRevision: grant.revision,
        permissionId: grant.id,
        sendingEnabled: true,
      };
      const guard: BrowserOutboxAuthorization = {
        stores,
        check,
        validate: (io, next) =>
          this.validate(io, p.proof, () =>
            io.request(io.store("task_consents").get(this.scope), (raw) => {
              if (!same(this.row(raw), row))
                throw new BrowserOutboxError("DENIED");
              next();
            }),
          ),
      };
      await this.tx(
        g,
        "readonly",
        p.proof,
        (io, current) => {
          if (!same(current, row))
            throw new BrowserTaskConsentError("CONFLICT");
          io.done(null);
        },
        grant.choices.expiresAt,
      );
      const outbox = await BrowserPrivateOutbox.openVerified(
        () => {
          check();
          return { ...p.proof.local.binding };
        },
        (id) => {
          check();
          return id === peerId ? structuredClone(context) : null;
        },
        freshRegistration,
        this.now,
        (id) => {
          check();
          return id === peerId
            ? {
                context: structuredClone(context),
                recipientKey: p.local.pair,
                senderPublicKey: p.peer.publicKey,
                resultsEnabled: grant.choices.receiveResults,
              }
            : null;
        },
        guard,
      );
      try {
        check();
      } catch (e) {
        outbox.close();
        throw e;
      }
      const resumeTask = async (raw: unknown) => {
        check();
        const input = this.input(
            z.strictObject({ id: z.uuid(), expectedRevision: positive }),
            raw,
          ),
          original = await outbox.taskState(input.id);
        check();
        if (
          original.envelope &&
          (original.state === "pending" || original.state === "accepted")
        )
          return original;
        const prepared = await outbox.preparedTask(input);
        check();
        const bytes = new TextEncoder().encode(
          JSON.stringify(prepared.payload),
        );
        try {
          const envelope = await sealPrivateEnvelope(
            prepared.entry.header,
            bytes,
            { senderKey: p.local.pair, recipientPublicKey: p.peer.publicKey },
            this.now,
          );
          check();
          try {
            return await outbox.commit(
              {
                id: input.id,
                expectedRevision: prepared.entry.revision,
                envelope,
              },
              prepared.proof,
            );
          } catch (e) {
            if (!(e instanceof BrowserOutboxError) || e.code !== "CONFLICT")
              throw e;
            // A competing resume may have published first. Return only that
            // original durable ciphertext, never replace it or reserve again.
            const saved = await outbox.taskState(input.id);
            check();
            if (
              !same(saved.header, prepared.entry.header) ||
              !saved.envelope ||
              (saved.state !== "pending" && saved.state !== "accepted")
            )
              throw e;
            return saved;
          }
        } finally {
          bytes.fill(0);
        }
      };
      const reserveTask = async (raw: unknown) => {
        check();
        const input = this.input(
          z.strictObject({
            id: z.uuid(),
            payload: privateTaskPayloadSchema,
            expiresAt: positive,
          }),
          raw,
        );
        if (input.expiresAt > grant.choices.expiresAt)
          throw new BrowserTaskConsentError("DENIED");
        const reserved = await outbox.reserveTask({ ...input, peerId });
        check();
        return reserved;
      };
      return {
        outbox,
        context: structuredClone(context),
        taskDeadline: Math.min(
          this.now() + 86400000,
          grant.choices.expiresAt,
          p.proof.local.binding.expiresAt,
        ),
        reserveTask,
        resumeTask,
        // Compatibility for internal callers. Page submission must go through
        // the separate one-use exact-content review, not call this helper.
        prepareTask: async (payload: unknown) => {
          const reserved = await reserveTask({
            id: crypto.randomUUID(),
            payload,
            expiresAt: Math.min(
              this.now() + 86400000,
              grant.choices.expiresAt,
              p.proof.local.binding.expiresAt,
            ),
          });
          return resumeTask({
            id: reserved.id,
            expectedRevision: reserved.revision,
          });
        },
      };
    });
  }
}
