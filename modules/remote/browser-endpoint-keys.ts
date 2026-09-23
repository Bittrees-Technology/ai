import { z } from "zod";
import {
  privateBindingSchema,
  inspectPrivateInvitation,
} from "./private-peer-contracts.js";
import {
  browserKeyIdentitySchema as identitySchema,
  browserKeyRecoverySchema,
  createBrowserKeyMaterial,
} from "./browser-key-recovery.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export type BrowserKeyAuthority = z.infer<typeof identitySchema> & {
  creationAllowed: boolean;
};
const recordSchema = z.strictObject({
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  keyId: z.uuid(),
  identity: identitySchema,
  state: z.enum(["reserved", "ready", "deleted"]),
  publicKey: z.string().nullable(),
  privateHandle: z.unknown(),
  publicHandle: z.unknown(),
  recovery: browserKeyRecoverySchema.nullable(),
});
type Record = z.infer<typeof recordSchema>;
export class BrowserKeyError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "MISSING"
      | "DELETED"
      | "CREATION_INCOMPLETE"
      | "STORAGE_UNAVAILABLE"
      | "CAPACITY"
      | "BUSY",
  ) {
    super(code);
  }
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const identity = (a: BrowserKeyAuthority) =>
  identitySchema.parse({
    localOwner: a.localOwner,
    binding: a.binding,
    keyId: a.keyId,
    keyEpoch: a.keyEpoch,
  });
const dbName = "org.bittrees.ai.browser-endpoint-keys";
const publicBytes = async (key: CryptoKey) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.exportKey("raw", key)),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
/** Internal immutable-slot provider. The trusted host supplies verified registration,
 * fresh key IDs/epochs and current selection; stored rows never grant authority.
 * Recovery exports ciphertext only; restored material cannot select a slot or grant authority. No production mounting is provided here.
 */
export class BrowserEndpointKeys {
  private closed = false;
  private generation = 0;
  private busy = false;
  private cache?: { scope: string; publicKey: string; pair: CryptoKeyPair };
  private constructor(
    private db: IDBDatabase,
    private localOwner: string,
    private scope: string,
    private current: () => BrowserKeyAuthority | null,
    private now: () => number,
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
      this.invalidate();
    };
  }
  static async open(
    localOwner: string,
    current: () => BrowserKeyAuthority | null,
    now = Date.now,
  ) {
    if (
      !z.string().min(1).max(256).safeParse(localOwner).success ||
      !globalThis.isSecureContext
    )
      throw new BrowserKeyError("DENIED");
    const scope = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(["browser-endpoint-owner:v1", localOwner]),
          ),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return new Promise<BrowserEndpointKeys>((resolve, reject) => {
      let ended = false;
      const fail = () => {
        if (!ended) {
          ended = true;
          clearTimeout(timer);
          reject(new BrowserKeyError("STORAGE_UNAVAILABLE"));
        }
      };
      const timer = setTimeout(fail, 10000);
      let r: IDBOpenDBRequest;
      try {
        r = indexedDB.open(dbName, 1);
      } catch {
        fail();
        return;
      }
      r.onerror = fail;
      r.onblocked = fail;
      r.onupgradeneeded = () => {
        if (ended) {
          r.transaction?.abort();
          return;
        }
        const slots = r.result.createObjectStore("slots", {
          keyPath: ["scope", "keyId"],
        });
        slots.createIndex("scope", "scope");
      };
      r.onsuccess = () => {
        if (ended) {
          r.result.close();
          return;
        }
        ended = true;
        clearTimeout(timer);
        resolve(
          new BrowserEndpointKeys(r.result, localOwner, scope, current, now),
        );
      };
    });
  }
  invalidate() {
    this.generation++;
    this.cache = undefined;
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private authority() {
    try {
      const a = this.current();
      if (!a || typeof a.creationAllowed !== "boolean") throw Error();
      const i = identity(a);
      if (i.localOwner !== this.localOwner || i.binding.expiresAt <= this.now())
        throw Error();
      return { ...i, creationAllowed: a.creationAllowed };
    } catch {
      throw new BrowserKeyError("DENIED");
    }
  }
  private check(a: BrowserKeyAuthority | null, generation: number) {
    if (this.closed) throw new BrowserKeyError("STORAGE_UNAVAILABLE");
    if (generation !== this.generation) throw new BrowserKeyError("CONFLICT");
    if (a && !same(identity(this.authority()), identity(a)))
      throw new BrowserKeyError("CONFLICT");
  }
  private async exclusive<T>(fn: (generation: number) => Promise<T>) {
    if (this.busy) throw new BrowserKeyError("BUSY");
    this.busy = true;
    const g = this.generation;
    try {
      const value = await fn(g);
      this.check(null, g);
      return value;
    } catch (e) {
      this.cache = undefined;
      if (e instanceof BrowserKeyError) throw e;
      throw new BrowserKeyError("STORAGE_UNAVAILABLE");
    } finally {
      this.busy = false;
    }
  }
  private record(raw: unknown, keyId: string) {
    const p = recordSchema.safeParse(raw);
    if (
      !p.success ||
      p.data.scope !== this.scope ||
      p.data.keyId !== keyId ||
      p.data.identity.keyId !== keyId ||
      p.data.identity.localOwner !== this.localOwner
    )
      throw new BrowserKeyError("CONFLICT");
    const r = p.data;
    if (
      r.state !== "ready" &&
      (r.publicKey !== null ||
        r.privateHandle !== null ||
        r.publicHandle !== null ||
        r.recovery !== null)
    )
      throw new BrowserKeyError("CONFLICT");
    return r;
  }
  /** All IDB callbacks are synchronous; WebCrypto runs outside transactions. */
  private tx<T>(
    a: BrowserKeyAuthority | null,
    g: number,
    mode: IDBTransactionMode,
    work: (
      s: IDBObjectStore,
      get: <R>(r: IDBRequest<R>, fn: (v: R) => void) => void,
      done: (v: T) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction, value: T, error: BrowserKeyError | undefined;
      const check = () => this.check(a, g);
      try {
        check();
        tx = this.db.transaction("slots", mode, { durability: "strict" });
      } catch (e) {
        reject(
          e instanceof BrowserKeyError
            ? e
            : new BrowserKeyError("STORAGE_UNAVAILABLE"),
        );
        return;
      }
      const fail = (e: unknown) => {
        error =
          e instanceof BrowserKeyError
            ? e
            : new BrowserKeyError(
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
        () => fail(new BrowserKeyError("STORAGE_UNAVAILABLE")),
        15000,
      );
      tx.onabort = () => {
        clearTimeout(timer);
        reject(
          error ??
            new BrowserKeyError(
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
      guard(() =>
        work(
          tx.objectStore("slots"),
          (r, fn) => {
            r.onsuccess = () => guard(() => fn(r.result));
          },
          (v) => {
            value = v;
          },
        ),
      );
    });
  }
  private read(a: BrowserKeyAuthority, g: number) {
    return this.tx<Record>(a, g, "readonly", (s, get, done) =>
      get(s.get([this.scope, a.keyId]), (raw) => {
        if (!raw) throw new BrowserKeyError("MISSING");
        const r = this.record(raw, a.keyId);
        if (!same(r.identity, identity(a)))
          throw new BrowserKeyError("CONFLICT");
        if (r.state === "deleted") throw new BrowserKeyError("DELETED");
        if (r.state !== "ready")
          throw new BrowserKeyError("CREATION_INCOMPLETE");
        done(r);
      }),
    );
  }
  private async load(a: BrowserKeyAuthority, g: number) {
    const r = await this.read(a, g),
      priv = r.privateHandle,
      pub = r.publicHandle;
    if (
      !(priv instanceof CryptoKey) ||
      !(pub instanceof CryptoKey) ||
      priv.type !== "private" ||
      priv.extractable ||
      pub.type !== "public" ||
      !pub.extractable ||
      priv.algorithm.name !== "ECDH" ||
      pub.algorithm.name !== "ECDH" ||
      (priv.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
      (pub.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
      !same(priv.usages, ["deriveBits"]) ||
      pub.usages.length !== 0
    )
      throw new BrowserKeyError("CONFLICT");
    if ((await publicBytes(pub)) !== r.publicKey)
      throw new BrowserKeyError("CONFLICT");
    // Persisted handles must still correspond; do not trust public metadata alone.
    if (!r.recovery) throw new BrowserKeyError("CONFLICT");
    const probe = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const left = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: probe.publicKey },
        priv,
        256,
      ),
    );
    const right = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: pub },
        probe.privateKey,
        256,
      ),
    );
    const match =
      left.length === right.length && left.every((b, i) => b === right[i]);
    left.fill(0);
    right.fill(0);
    if (!match) throw new BrowserKeyError("CONFLICT");
    // A second durable read fences deletion/replacement while crypto was running.
    const latest = await this.read(a, g);
    if (latest.publicKey !== r.publicKey) throw new BrowserKeyError("CONFLICT");
    this.check(a, g);
    const scope = JSON.stringify(identity(a));
    if (
      !this.cache ||
      this.cache.scope !== scope ||
      this.cache.publicKey !== r.publicKey
    )
      this.cache = {
        scope,
        publicKey: r.publicKey!,
        pair: { privateKey: priv, publicKey: pub },
      };
    return {
      keyId: a.keyId,
      keyEpoch: a.keyEpoch,
      publicKey: r.publicKey!,
      pair: { ...this.cache.pair },
    };
  }
  resolve() {
    return this.exclusive((g) => this.load(this.authority(), g));
  }
  create(raw: unknown, recoveryKey: CryptoKey) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            keyId: z.uuid(),
            keyEpoch: positive,
            confirmed: z.literal(true),
          })
          .safeParse(raw),
        a = this.authority();
      if (
        !input.success ||
        input.data.keyId !== a.keyId ||
        input.data.keyEpoch !== a.keyEpoch
      )
        throw new BrowserKeyError("DENIED");
      const existing = await this.tx<boolean>(
        a,
        g,
        "readwrite",
        (s, get, done) =>
          get(s.get([this.scope, a.keyId]), (raw) => {
            if (raw) {
              const r = this.record(raw, a.keyId);
              if (!same(r.identity, identity(a)))
                throw new BrowserKeyError("CONFLICT");
              if (r.state === "deleted") throw new BrowserKeyError("DELETED");
              if (r.state !== "ready")
                throw new BrowserKeyError("CREATION_INCOMPLETE");
              done(true);
              return;
            }
            if (!this.authority().creationAllowed)
              throw new BrowserKeyError("DENIED");
            get(s.index("scope").count(this.scope), (count) => {
              if (count >= 20) throw new BrowserKeyError("CAPACITY");
              if (!this.authority().creationAllowed)
                throw new BrowserKeyError("DENIED");
              get(
                s.add({
                  scope: this.scope,
                  keyId: a.keyId,
                  identity: identity(a),
                  state: "reserved",
                  publicKey: null,
                  privateHandle: null,
                  publicHandle: null,
                  recovery: null,
                }),
                () => done(false),
              );
            });
          }),
      );
      if (!existing) {
        this.check(a, g);
        if (!this.authority().creationAllowed)
          throw new BrowserKeyError("DENIED");
        const material = await createBrowserKeyMaterial(
            identity(a),
            recoveryKey,
          ),
          pair = material.pair,
          pub = material.publicKey;
        await this.tx<void>(a, g, "readwrite", (s, get, done) =>
          get(s.get([this.scope, a.keyId]), (raw) => {
            const r = this.record(raw, a.keyId);
            if (
              !same(r.identity, identity(a)) ||
              r.state !== "reserved" ||
              !this.authority().creationAllowed
            )
              throw new BrowserKeyError("CONFLICT");
            get(
              s.put({
                ...r,
                state: "ready",
                publicKey: pub,
                privateHandle: pair.privateKey,
                publicHandle: pair.publicKey,
                recovery: material.recovery,
              }),
              () => done(),
            );
          }),
        );
      }
      const value = await this.load(a, g);
      if (!existing && !this.authority().creationAllowed)
        throw new BrowserKeyError("DENIED");
      return {
        keyId: value.keyId,
        keyEpoch: value.keyEpoch,
        publicKey: value.publicKey,
      };
    });
  }
  /** Offline, explicit local key deletion. The fixed local owner comes from the host,
   * not the request. Tombstones remain; remote revocation is separate. */
  remove(raw: unknown) {
    this.invalidate();
    const input = z
      .strictObject({ keyId: z.uuid(), confirmed: z.literal(true) })
      .safeParse(raw);
    if (!input.success) return Promise.reject(new BrowserKeyError("DENIED"));
    const g = this.generation;
    return this.tx<void>(null, g, "readwrite", (s, get, done) =>
      get(s.get([this.scope, input.data.keyId]), (raw) => {
        if (!raw) throw new BrowserKeyError("MISSING");
        const r = this.record(raw, input.data.keyId);
        get(
          s.put({
            ...r,
            state: "deleted",
            publicKey: null,
            privateHandle: null,
            publicHandle: null,
            recovery: null,
          }),
          () => done(),
        );
      }),
    );
  }
  recovery(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({ keyId: z.uuid(), confirmed: z.literal(true) })
          .safeParse(raw),
        a = this.authority();
      if (!input.success || input.data.keyId !== a.keyId)
        throw new BrowserKeyError("DENIED");
      await this.load(a, g);
      const record = await this.read(a, g);
      if (!record.recovery) throw new BrowserKeyError("CONFLICT");
      return browserKeyRecoverySchema.parse(record.recovery);
    });
  }
  invitation(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({ recipientId: z.uuid(), confirmed: z.literal(true) })
          .safeParse(raw),
        a = this.authority();
      if (!input.success || input.data.recipientId === a.binding.deviceId)
        throw new BrowserKeyError("DENIED");
      const key = await this.load(a, g),
        now = this.now();
      const inspected = await inspectPrivateInvitation(
        {
          version: 1,
          ownerId: a.binding.ownerId,
          recipientId: input.data.recipientId,
          peerId: a.binding.deviceId,
          keyEpoch: a.keyEpoch,
          publicKey: key.publicKey,
          nonce: crypto.randomUUID(),
          issuedAt: now,
          expiresAt: Math.min(a.binding.expiresAt, now + 300000),
        },
        now,
      );
      await this.read(a, g);
      this.check(a, g);
      return {
        invitation: inspected.invitation,
        fingerprint: inspected.fingerprint,
        keyHash: inspected.keyHash,
      };
    });
  }
}
