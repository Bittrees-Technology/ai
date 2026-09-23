import { z } from "zod";
import { browserStoredKeyMatches } from "./browser-private-authority.js";
import {
  browserPeerRecordSchema as recordSchema,
  browserPeerProofSchema as proofSchema,
  type BrowserPeerRecord as Record,
  type BrowserPeerProof,
} from "./browser-peer-state.js";
export type { BrowserPeerProof } from "./browser-peer-state.js";
import {
  browserKeyProofSchema,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import {
  browserKeyScope,
  openBrowserKeyDatabase,
} from "./browser-key-state.js";
import {
  inspectPrivateInvitation,
  privateInvitationTime,
  type PrivateInvitation,
} from "./private-peer-contracts.js";
import { type PrivatePeerState } from "./private-peer-state.js";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = revision.refine((v) => v > 0);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const checked = z.strictObject({
  expectedRevision: revision,
  confirmed: z.literal(true),
});
type Review = {
  id: string;
  revision: number;
  key: BrowserKeyProof;
  invitation: PrivateInvitation;
  fingerprint: string;
  keyHash: string;
  expiresAt: number;
  startedAt: number;
  startedMono: number;
};
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export class BrowserPeerError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "REPAIR_REQUIRED"
      | "STORAGE_UNAVAILABLE"
      | "BUSY",
  ) {
    super(code);
  }
}

/** Public peer pins only. A trusted host supplies a freshly verified local key
 * proof; stored records and incoming invitations never supply authority. Pin
 * publication and local key/lifecycle checks share one IndexedDB transaction.
 * A pin is neither possession evidence nor consent to send/receive tasks. */
export class BrowserPeerEnrollment {
  private closed = false;
  private generation = 0;
  private busy = false;
  private reviews = new Map<string, Review>();
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => BrowserKeyProof | null,
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
    current: () => BrowserKeyProof | null,
    now = Date.now,
    monotonic = () => performance.now(),
  ) {
    const scope = await browserKeyScope(owner),
      db = await openBrowserKeyDatabase();
    return new BrowserPeerEnrollment(db, owner, scope, current, now, monotonic);
  }
  invalidate() {
    this.generation++;
    this.reviews.clear();
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private input<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new BrowserPeerError("DENIED");
    return p.data;
  }
  private key() {
    const key = this.input(browserKeyProofSchema, this.current());
    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0 || key.binding.expiresAt <= now)
      throw new BrowserPeerError("DENIED");
    return key;
  }
  private check(g: number, key: BrowserKeyProof | null) {
    if (this.closed) throw new BrowserPeerError("STORAGE_UNAVAILABLE");
    if (g !== this.generation) throw new BrowserPeerError("CONFLICT");
    if (key && !same(this.key(), key)) throw new BrowserPeerError("DENIED");
  }
  private async exclusive<T>(fn: (g: number) => Promise<T>) {
    if (this.busy) throw new BrowserPeerError("BUSY");
    this.busy = true;
    const g = this.generation;
    try {
      const v = await fn(g);
      this.check(g, null);
      return v;
    } catch (e) {
      if (e instanceof BrowserPeerError) throw e;
      throw new BrowserPeerError("STORAGE_UNAVAILABLE");
    } finally {
      this.busy = false;
    }
  }
  private record(raw: unknown): Record | null {
    if (raw === undefined) return null;
    const p = recordSchema.safeParse(raw);
    if (!p.success || p.data.scope !== this.scope)
      throw new BrowserPeerError("STORAGE_UNAVAILABLE");
    return p.data;
  }
  /** No asynchronous crypto/network callback occurs inside this transaction. */
  private tx<T>(
    g: number,
    key: BrowserKeyProof | null,
    mode: IDBTransactionMode,
    fn: (record: Record | null, store: IDBObjectStore) => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction, value: T, error: BrowserPeerError | undefined;
      const check = () => this.check(g, key);
      try {
        check();
        tx = this.db.transaction(["slots", "lifecycle", "peers"], mode, {
          durability: "strict",
        });
      } catch (e) {
        reject(
          e instanceof BrowserPeerError
            ? e
            : new BrowserPeerError("STORAGE_UNAVAILABLE"),
        );
        return;
      }
      const fail = (e: unknown) => {
        error =
          e instanceof BrowserPeerError
            ? e
            : new BrowserPeerError(
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
      const guard = (f: () => void) => {
        try {
          check();
          f();
        } catch (e) {
          fail(e);
        }
      };
      const timer = setTimeout(
        () => fail(new BrowserPeerError("STORAGE_UNAVAILABLE")),
        15000,
      );
      tx.onabort = () => {
        clearTimeout(timer);
        reject(
          error ??
            new BrowserPeerError(
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
          resolve(value);
        } catch (e) {
          reject(e);
        }
      };
      const run = () => {
        const store = tx.objectStore("peers"),
          request = store.get(this.scope);
        request.onsuccess = () =>
          guard(() => {
            value = fn(this.record(request.result), store);
            check();
          });
      };
      guard(() => {
        if (!key) {
          run();
          return;
        }
        const meta = tx.objectStore("lifecycle").get(this.scope);
        meta.onsuccess = () =>
          guard(() => {
            const saved = tx.objectStore("slots").get([this.scope, key.keyId]);
            saved.onsuccess = () =>
              guard(() => {
                if (
                  !browserStoredKeyMatches(
                    meta.result,
                    saved.result,
                    this.owner,
                    this.scope,
                    key,
                  )
                )
                  throw new BrowserPeerError("DENIED");
                run();
              });
          });
      });
    });
  }
  private active(record: Record | null, key: BrowserKeyProof) {
    if (record?.locked) throw new BrowserPeerError("REPAIR_REQUIRED");
    if (record && !same(record.key, key))
      throw new BrowserPeerError("CONFLICT");
    return record;
  }
  private expected(record: Record | null, revision: number) {
    if ((record?.revision ?? 0) !== revision)
      throw new BrowserPeerError("CONFLICT");
  }
  private save(
    record: Omit<Record, "revision">,
    previous: number,
    store: IDBObjectStore,
  ) {
    if (previous >= Number.MAX_SAFE_INTEGER)
      throw new BrowserPeerError("CAPACITY");
    const next = recordSchema.parse({ ...record, revision: previous + 1 });
    store.put(next);
    return next.revision;
  }
  private allowed(
    state: PrivatePeerState | null | undefined,
    i: PrivateInvitation,
    keyHash: string,
  ) {
    const old = state?.peers.find((p) => p.peerId === i.peerId);
    if (
      state?.retired.some((p) => p.keyHash === keyHash) ||
      state?.peers.some((p) => p.keyHash === keyHash) ||
      i.keyEpoch <=
        Math.max(
          old?.keyEpoch ?? 0,
          ...(state?.retired
            .filter((p) => p.peerId === i.peerId)
            .map((p) => p.keyEpoch) ?? []),
        )
    )
      throw new BrowserPeerError("DENIED");
    if (
      (!old && (state?.peers.length ?? 0) >= 20) ||
      (old && (state?.retired.length ?? 0) >= 512)
    )
      throw new BrowserPeerError("CAPACITY");
  }
  private async anchor(key: BrowserKeyProof) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "browser-peer-device:v1",
          this.owner,
          key.binding.deviceId,
        ]),
      ),
    );
    return Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  private liveReview(r: Review) {
    const n = this.now(),
      elapsed = this.monotonic() - r.startedMono;
    return (
      n >= r.startedAt &&
      n < r.expiresAt &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < r.expiresAt - r.startedAt
    );
  }
  prepare(raw: unknown) {
    return this.exclusive(async (g) => {
      const key = this.key(),
        before = await this.tx(g, key, "readonly", (r) => this.active(r, key));
      let inspected: Awaited<ReturnType<typeof inspectPrivateInvitation>>;
      try {
        inspected = await inspectPrivateInvitation(raw, this.now());
      } catch {
        throw new BrowserPeerError("DENIED");
      }
      const i = inspected.invitation;
      await this.tx(g, key, "readonly", (r) => {
        this.active(r, key);
        this.expected(r, before?.revision ?? 0);
        if (
          !privateInvitationTime(i, this.now()) ||
          i.ownerId !== key.binding.ownerId ||
          i.recipientId !== key.binding.deviceId ||
          i.publicKey === key.publicKey
        )
          throw new BrowserPeerError("DENIED");
        this.allowed(r?.state, i, inspected.keyHash);
      });
      for (const [id, r] of this.reviews)
        if (!this.liveReview(r)) this.reviews.delete(id);
      if (this.reviews.size >= 4) throw new BrowserPeerError("CAPACITY");
      const startedAt = this.now(),
        r: Review = {
          id: crypto.randomUUID(),
          revision: before?.revision ?? 0,
          key,
          invitation: i,
          fingerprint: inspected.fingerprint,
          keyHash: inspected.keyHash,
          expiresAt: Math.min(
            i.expiresAt,
            key.binding.expiresAt,
            startedAt + 300000,
          ),
          startedAt,
          startedMono: this.monotonic(),
        };
      this.check(g, key);
      this.reviews.set(r.id, r);
      return structuredClone({
        reviewId: r.id,
        expectedRevision: r.revision,
        fingerprint: r.fingerprint,
        invitation: i,
        expiresAt: r.expiresAt,
        replaces:
          before?.state?.peers.find((p) => p.peerId === i.peerId) ?? null,
      });
    });
  }
  approve(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
        checked.extend({ reviewId: z.uuid(), comparedFingerprint: hex }),
        raw,
      );
      const r = this.reviews.get(input.reviewId);
      this.reviews.delete(input.reviewId);
      if (
        !r ||
        !this.liveReview(r) ||
        r.revision !== input.expectedRevision ||
        r.fingerprint !== input.comparedFingerprint
      )
        throw new BrowserPeerError("DENIED");
      const anchor = await this.anchor(r.key);
      return this.tx(g, r.key, "readwrite", (record, store) => {
        this.active(record, r.key);
        this.expected(record, r.revision);
        if (
          !this.liveReview(r) ||
          !privateInvitationTime(r.invitation, this.now())
        )
          throw new BrowserPeerError("DENIED");
        this.allowed(record?.state, r.invitation, r.keyHash);
        const state = record?.state ?? {
            binding: r.key.binding,
            peers: [],
            retired: [],
          },
          i = r.invitation;
        const old = state.peers.find((p) => p.peerId === i.peerId);
        if (old)
          state.retired.push({
            peerId: old.peerId,
            keyEpoch: old.keyEpoch,
            keyHash: old.keyHash,
          });
        state.peers = state.peers.filter((p) => p.peerId !== i.peerId);
        state.peers.push({
          peerId: i.peerId,
          keyEpoch: i.keyEpoch,
          publicKey: i.publicKey,
          keyHash: r.keyHash,
          fingerprint: r.fingerprint,
          approvedAt: this.now(),
          revoked: false,
        });
        const revision = this.save(
          {
            scope: this.scope,
            deviceAnchor: anchor,
            locked: false,
            key: r.key,
            state,
          },
          r.revision,
          store,
        );
        return {
          revision,
          peerId: i.peerId,
          keyEpoch: i.keyEpoch,
          fingerprint: r.fingerprint,
        };
      });
    });
  }
  /** Owner-local inspection/export and revocation work without an online lease. */
  status() {
    return this.exclusive((g) =>
      this.tx(g, null, "readonly", (r) =>
        structuredClone({
          revision: r?.revision ?? 0,
          needsFreshDevice: r?.locked ?? false,
          key: r?.key ?? null,
          state: r?.state ?? null,
        }),
      ),
    );
  }
  revoke(raw: unknown) {
    this.invalidate();
    return this.exclusive((g) => {
      const input = this.input(checked.extend({ peerId: z.uuid() }), raw);
      return this.tx(g, null, "readwrite", (r, store) => {
        this.expected(r, input.expectedRevision);
        const pin = r?.state?.peers.find((p) => p.peerId === input.peerId);
        if (!r || !pin) throw new BrowserPeerError("DENIED");
        pin.revoked = true;
        return {
          revision: this.save(r, r.revision, store),
          revokedLocally: true,
          remoteRevocationConfirmed: false,
        };
      });
    });
  }
  reset(raw: unknown) {
    this.invalidate();
    return this.exclusive(async (g) => {
      const input = this.input(checked, raw),
        key = this.key(),
        anchor = await this.anchor(key);
      return this.tx(g, key, "readwrite", (r, store) => {
        this.expected(r, input.expectedRevision);
        if (r?.locked && r.deviceAnchor === anchor)
          throw new BrowserPeerError("REPAIR_REQUIRED");
        const retired = [
          ...new Map(
            [
              ...(r?.state?.retired ?? []),
              ...(r?.state?.peers.map((p) => ({
                peerId: p.peerId,
                keyEpoch: p.keyEpoch,
                keyHash: p.keyHash,
              })) ?? []),
            ].map((p) => [p.keyHash, p]),
          ).values(),
        ];
        if (retired.length > 512) throw new BrowserPeerError("CAPACITY");
        return {
          revision: this.save(
            {
              scope: this.scope,
              deviceAnchor: anchor,
              locked: false,
              key,
              state: { binding: key.binding, peers: [], retired },
            },
            r?.revision ?? 0,
            store,
          ),
        };
      });
    });
  }
  clear(raw: unknown) {
    this.invalidate();
    return this.exclusive((g) => {
      const input = this.input(checked, raw);
      return this.tx(g, null, "readwrite", (r, store) => {
        this.expected(r, input.expectedRevision);
        if (!r) throw new BrowserPeerError("DENIED");
        return {
          revision: this.save(
            {
              scope: this.scope,
              deviceAnchor: r.deviceAnchor,
              locked: true,
              key: null,
              state: null,
            },
            r.revision,
            store,
          ),
          needsFreshDevice: true,
        };
      });
    });
  }
  async validate(raw: unknown) {
    try {
      const proof = this.input(proofSchema, raw),
        g = this.generation;
      return await this.tx(g, proof.key, "readonly", (r) => {
        this.active(r, proof.key);
        const pin = r?.state?.peers.find((p) => p.peerId === proof.peerId);
        return (
          r?.revision === proof.revision &&
          !!pin &&
          !pin.revoked &&
          pin.keyEpoch === proof.keyEpoch &&
          pin.fingerprint === proof.fingerprint
        );
      });
    } catch {
      return false;
    }
  }
  resolve(peerId: string, keyEpoch: number) {
    return this.exclusive(async (g) => {
      const key = this.key();
      const selected = await this.tx(g, key, "readonly", (r) => {
        this.active(r, key);
        const pin = r?.state?.peers.find((p) => p.peerId === peerId);
        if (!r || !pin || pin.revoked || pin.keyEpoch !== keyEpoch)
          throw new BrowserPeerError("DENIED");
        return {
          pin,
          proof: {
            revision: r.revision,
            key,
            peerId,
            keyEpoch,
            fingerprint: pin.fingerprint,
          },
        };
      });
      const bytes = Uint8Array.from(
        atob(selected.pin.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
      const publicKey = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
      this.check(g, key);
      if (!(await this.validate(selected.proof)))
        throw new BrowserPeerError("CONFLICT");
      return { publicKey, proof: structuredClone(selected.proof) };
    });
  }
}
