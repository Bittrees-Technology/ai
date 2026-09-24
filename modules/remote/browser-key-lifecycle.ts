import { z } from "zod";
import {
  BrowserEndpointKeys,
  browserEndpointRecordSchema,
  type BrowserKeyAuthority,
} from "./browser-endpoint-keys.js";
import {
  BrowserKeyError,
  browserLifecycleSchema,
  browserKeyScope,
  openBrowserKeyDatabase,
  type BrowserLifecycleState,
} from "./browser-key-state.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  browserRecoveryKey,
  browserKeyRecoverySchema,
  openBrowserKeyRecovery,
} from "./browser-key-recovery.js";
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  positive = revision.refine((v) => v > 0);
const checked = z.strictObject({
  expectedRevision: revision,
  confirmed: z.literal(true),
});
const target = checked.extend({ keyId: z.uuid() });
export const browserKeyProofSchema = z.strictObject({
  revision: positive,
  keyId: z.uuid(),
  keyEpoch: positive,
  binding: privateBindingSchema,
  publicKey: z
    .string()
    .length(87)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type BrowserKeyProof = z.infer<typeof browserKeyProofSchema>;
type SlotRecord = z.infer<typeof browserEndpointRecordSchema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Synchronous prerequisite for a future common-database content transaction.
 * The caller must first resolve/authenticate with this key, then read lifecycle
 * and slot in the SAME transaction as consent, replay and content effects.
 * This neither grants authority nor reconstructs unknown historical identities. */
export function browserReplayCoverageMatches(
  rawState: unknown,
  rawRecord: unknown,
  rawProof: unknown,
  authority: {
    localOwner: string;
    scope: string;
    binding: PrivateBinding;
    now: number;
  },
): boolean {
  const state = browserLifecycleSchema.safeParse(rawState),
    record = browserEndpointRecordSchema.safeParse(rawRecord),
    proof = browserKeyProofSchema.safeParse(rawProof),
    binding = privateBindingSchema.safeParse(authority.binding);
  if (
    !state.success ||
    !record.success ||
    !proof.success ||
    !binding.success ||
    !Number.isSafeInteger(authority.now) ||
    authority.now <= 0 ||
    binding.data.expiresAt <= authority.now
  )
    return false;
  const s = state.data,
    r = record.data,
    p = proof.data,
    b = binding.data;
  const slot = s.slots.find((v) => v.state === "active");
  return (
    !s.locked &&
    s.scope === authority.scope &&
    s.revision === p.revision &&
    s.ownerId === b.ownerId &&
    s.deviceId === b.deviceId &&
    same(p.binding, b) &&
    !!slot &&
    slot.id === p.keyId &&
    slot.keyEpoch === p.keyEpoch &&
    slot.publicKey === p.publicKey &&
    same(slot.binding, b) &&
    r.state === "ready" &&
    r.scope === authority.scope &&
    r.keyId === p.keyId &&
    r.identity.localOwner === authority.localOwner &&
    r.identity.keyId === p.keyId &&
    r.identity.keyEpoch === p.keyEpoch &&
    same(r.identity.binding, b) &&
    r.publicKey === p.publicKey &&
    !!r.recovery &&
    r.incomingReplayBoundary === "from-generation-v1"
  );
}
/** Durable local selection only. Verified identity/fresh-registration callbacks come
 * from a trusted host, never from metadata, invitations, requests or recovered keys. */
export class BrowserKeyLifecycle {
  private closed = false;
  private generation = 0;
  private busy = false;
  private selected: BrowserKeyAuthority | null = null;
  private provider!: BrowserEndpointKeys;
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => PrivateBinding | null,
    private freshRegistration: (binding: PrivateBinding) => boolean,
    private now: () => number,
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
    freshRegistration: (binding: PrivateBinding) => boolean = () => false,
    now = Date.now,
  ) {
    const scope = await browserKeyScope(owner),
      db = await openBrowserKeyDatabase(),
      self = new BrowserKeyLifecycle(
        db,
        owner,
        scope,
        current,
        freshRegistration,
        now,
      );
    try {
      self.provider = await BrowserEndpointKeys.open(
        owner,
        () => {
          if (self.closed || !self.selected) return null;
          try {
            return same(self.binding(), self.selected.binding)
              ? self.selected
              : null;
          } catch {
            return null;
          }
        },
        now,
      );
      return self;
    } catch (e) {
      db.close();
      throw e;
    }
  }
  invalidate() {
    this.generation++;
    this.selected = null;
    this.provider?.invalidate();
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.provider?.close();
    this.db.close();
  }
  private binding() {
    try {
      const b = privateBindingSchema.parse(this.current());
      if (b.expiresAt <= this.now()) throw Error();
      return b;
    } catch {
      throw new BrowserKeyError("DENIED");
    }
  }
  private check(g: number, b: PrivateBinding | null) {
    if (this.closed) throw new BrowserKeyError("STORAGE_UNAVAILABLE");
    if (g !== this.generation) throw new BrowserKeyError("CONFLICT");
    if (b && !same(this.binding(), b)) throw new BrowserKeyError("DENIED");
  }
  private input<T>(schema: z.ZodType<T>, raw: unknown) {
    const p = schema.safeParse(raw);
    if (!p.success) throw new BrowserKeyError("DENIED");
    return p.data;
  }
  private async exclusive<T>(fn: (g: number) => Promise<T>) {
    if (this.busy) throw new BrowserKeyError("BUSY");
    this.busy = true;
    const g = this.generation;
    try {
      const value = await fn(g);
      this.check(g, null);
      return value;
    } catch (e) {
      if (e instanceof BrowserKeyError) throw e;
      throw new BrowserKeyError("DENIED");
    } finally {
      this.busy = false;
    }
  }
  private tx<T>(
    g: number,
    b: PrivateBinding | null,
    mode: IDBTransactionMode,
    fn: (
      state: BrowserLifecycleState | null,
      rows: SlotRecord[],
      meta: IDBObjectStore,
      slots: IDBObjectStore,
    ) => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction, value: T, error: BrowserKeyError | undefined;
      const check = () => this.check(g, b);
      try {
        check();
        tx = this.db.transaction(["slots", "lifecycle"], mode, {
          durability: "strict",
        });
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
      const guard = (f: () => void) => {
        try {
          check();
          f();
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
      guard(() => {
        const meta = tx.objectStore("lifecycle"),
          slots = tx.objectStore("slots"),
          m = meta.get(this.scope);
        m.onsuccess = () =>
          guard(() => {
            const state = m.result
              ? browserLifecycleSchema.parse(m.result)
              : null;
            if (state && state.scope !== this.scope)
              throw new BrowserKeyError("CONFLICT");
            const r = slots.index("scope").getAll(this.scope, 21);
            r.onsuccess = () =>
              guard(() => {
                if (r.result.length > 20) throw new BrowserKeyError("CAPACITY");
                const rows = r.result.map((v) =>
                  browserEndpointRecordSchema.parse(v),
                );
                if (
                  rows.some(
                    (v) =>
                      v.scope !== this.scope ||
                      v.keyId !== v.identity.keyId ||
                      v.identity.localOwner !== this.owner,
                  )
                )
                  throw new BrowserKeyError("CONFLICT");
                if (
                  state &&
                  rows.some(
                    (v) =>
                      !state.slots.some(
                        (s) =>
                          s.id === v.keyId &&
                          s.keyEpoch === v.identity.keyEpoch &&
                          same(s.binding, v.identity.binding),
                      ),
                  )
                )
                  throw new BrowserKeyError("CONFLICT");
                value = fn(state, rows, meta, slots);
                check();
              });
          });
      });
    });
  }
  private expected(s: BrowserLifecycleState | null, r: number) {
    if ((s?.revision ?? 0) !== r) throw new BrowserKeyError("CONFLICT");
  }
  private save(s: BrowserLifecycleState, meta: IDBObjectStore) {
    if (s.revision >= Number.MAX_SAFE_INTEGER)
      throw new BrowserKeyError("CAPACITY");
    s.revision++;
    browserLifecycleSchema.parse(s);
    meta.put(s);
    return s;
  }
  private live(s: BrowserLifecycleState | null, b: PrivateBinding) {
    if (!s || s.locked) throw new BrowserKeyError("SETUP_REQUIRED");
    if (s.ownerId !== b.ownerId || s.deviceId !== b.deviceId)
      throw new BrowserKeyError("DENIED");
    return s;
  }
  private selectedSlot(
    s: BrowserLifecycleState,
    b: PrivateBinding,
    active = false,
  ) {
    const slot = s.slots.find(
      (x) => x.state === "active" || (!active && x.state === "preparing"),
    );
    if (!slot || !same(slot.binding, b)) throw new BrowserKeyError("DENIED");
    return slot;
  }
  private select(
    s: BrowserLifecycleState,
    slot: BrowserLifecycleState["slots"][number],
  ) {
    const next = {
      localOwner: this.owner,
      binding: slot.binding,
      keyId: slot.id,
      keyEpoch: slot.keyEpoch,
      creationAllowed: slot.state === "preparing",
      lifecycleRevision: s.revision,
    };
    if (!same(this.selected, next)) {
      this.provider.invalidate();
      this.selected = next;
    }
  }
  status() {
    const g = this.generation;
    return this.tx(g, null, "readonly", (s, rows) => ({
      revision: s?.revision ?? 0,
      locked: s?.locked ?? true,
      requiresFreshRegistration: !s || s.locked,
      registrationDeviceId: s?.deviceId ?? null,
      legacySlots: s ? 0 : rows.length,
      slots: s
        ? structuredClone(s.slots)
        : rows.map((r) => ({
            id: r.keyId,
            keyEpoch: r.identity.keyEpoch,
            binding: r.identity.binding,
            state: r.state === "deleted" ? "deleted" : "retired",
            publicKey: r.publicKey,
          })),
    }));
  }
  begin(raw: unknown) {
    const input = this.input(checked, raw);
    this.invalidate();
    const g = this.generation,
      b = this.binding();
    return this.tx(g, b, "readwrite", (state, rows, meta) => {
      this.expected(state, input.expectedRevision);
      let s = state;
      if (!s) {
        if (rows.length || !this.freshRegistration(b))
          throw new BrowserKeyError("SETUP_REQUIRED");
        s = {
          scope: this.scope,
          revision: 0,
          ownerId: b.ownerId,
          deviceId: b.deviceId,
          locked: false,
          slots: [],
        };
      }
      this.live(s, b);
      if (s.slots.length >= 20) throw new BrowserKeyError("CAPACITY");
      const keyEpoch = Math.max(0, ...s.slots.map((x) => x.keyEpoch)) + 1;
      if (!Number.isSafeInteger(keyEpoch))
        throw new BrowserKeyError("CAPACITY");
      for (const slot of s.slots)
        if (slot.state === "active" || slot.state === "preparing")
          slot.state = "retired";
      const slot = {
        id: crypto.randomUUID(),
        keyEpoch,
        binding: b,
        createdAt: this.now(),
        state: "preparing" as const,
        publicKey: null,
      };
      s.slots.push(slot);
      this.save(s, meta);
      return { revision: s.revision, keyId: slot.id, keyEpoch };
    });
  }
  private async preparing(
    g: number,
    input: { keyId: string; expectedRevision: number },
    b: PrivateBinding,
  ) {
    return this.tx(g, b, "readonly", (state) => {
      this.expected(state, input.expectedRevision);
      const s = this.live(state, b),
        slot = this.selectedSlot(s, b);
      if (slot.id !== input.keyId || slot.state !== "preparing")
        throw new BrowserKeyError("DENIED");
      this.select(s, slot);
      return { state: s, slot };
    });
  }
  private async material(
    g: number,
    input: { keyId: string; expectedRevision: number },
    b: PrivateBinding,
    key: CryptoKey,
  ) {
    const before = await this.preparing(g, input, b);
    const created = await this.provider.create(
      {
        keyId: before.slot.id,
        keyEpoch: before.slot.keyEpoch,
        confirmed: true,
      },
      key,
    );
    const recovery = await this.provider.recovery({
        keyId: before.slot.id,
        confirmed: true,
      }),
      opened = await openBrowserKeyRecovery(recovery, key);
    if (
      opened.publicKey !== created.publicKey ||
      !same(opened.identity, {
        localOwner: this.owner,
        binding: b,
        keyId: before.slot.id,
        keyEpoch: before.slot.keyEpoch,
      })
    )
      throw new BrowserKeyError("CONFLICT");
    await this.preparing(g, input, b);
    return {
      keyId: created.keyId,
      keyEpoch: created.keyEpoch,
      revision: input.expectedRevision,
      publicKey: created.publicKey,
      recovery,
    };
  }
  private async publishPrepared(
    g: number,
    input: { keyId: string; expectedRevision: number },
    b: PrivateBinding,
    key: CryptoKey,
    rawKit: unknown,
  ) {
    const recovery = this.input(browserKeyRecoverySchema, rawKit);
    const before = await this.preparing(g, input, b),
      saved = await this.provider.recovery({
        keyId: input.keyId,
        confirmed: true,
      });
    if (!same(saved, recovery)) throw new BrowserKeyError("CONFLICT");
    const opened = await openBrowserKeyRecovery(recovery, key),
      retained = await this.provider.resolve();
    if (
      opened.publicKey !== retained.publicKey ||
      !same(opened.identity, {
        localOwner: this.owner,
        binding: b,
        keyId: before.slot.id,
        keyEpoch: before.slot.keyEpoch,
      })
    )
      throw new BrowserKeyError("CONFLICT");
    return this.tx(g, b, "readwrite", (state, rows, meta) => {
      this.expected(state, input.expectedRevision);
      const s = this.live(state, b),
        slot = this.selectedSlot(s, b),
        record = rows.find((r) => r.keyId === input.keyId);
      if (
        slot.id !== input.keyId ||
        slot.state !== "preparing" ||
        record?.state !== "ready" ||
        record.publicKey !== opened.publicKey ||
        !same(record.recovery, recovery)
      )
        throw new BrowserKeyError("CONFLICT");
      slot.state = "active";
      slot.publicKey = opened.publicKey;
      this.save(s, meta);
      this.select(s, slot);
      return {
        revision: s.revision,
        keyId: slot.id,
        keyEpoch: slot.keyEpoch,
        binding: b,
        publicKey: opened.publicKey,
      };
    });
  }
  /** Saves recoverable material without activating it, allowing an explicit download
   * and file/code round trip before the separate final confirmation. */
  prepareRecovery(raw: unknown, code: string) {
    return this.exclusive(async (g) => {
      const input = this.input(target, raw),
        b = this.binding(),
        key = await browserRecoveryKey(code);
      this.check(g, b);
      return this.material(g, input, b, key);
    });
  }
  activatePrepared(raw: unknown, code: string, kit: unknown) {
    return this.exclusive(async (g) => {
      const input = this.input(
          target.extend({ recoverySaved: z.literal(true) }),
          raw,
        ),
        b = this.binding(),
        key = await browserRecoveryKey(code);
      this.check(g, b);
      return this.publishPrepared(g, input, b, key, kit);
    });
  }
  /** Existing trusted-host compound operation. The browser setup interface uses the
   * split prepareRecovery/activatePrepared flow and supplies its selected file. */
  provision(raw: unknown, code: string) {
    return this.exclusive(async (g) => {
      const input = this.input(
          target.extend({ recoverySaved: z.literal(true) }),
          raw,
        ),
        b = this.binding(),
        key = await browserRecoveryKey(code);
      this.check(g, b);
      const material = await this.material(g, input, b, key);
      return this.publishPrepared(g, input, b, key, material.recovery);
    });
  }
  private proof(
    state: BrowserLifecycleState | null,
    rows: SlotRecord[],
    b: PrivateBinding,
  ) {
    const s = this.live(state, b),
      slot = this.selectedSlot(s, b, true),
      saved = rows.find((r) => r.keyId === slot.id);
    if (
      saved?.state !== "ready" ||
      saved.publicKey !== slot.publicKey ||
      !saved.recovery
    )
      throw new BrowserKeyError("DENIED");
    return {
      revision: s.revision,
      keyId: slot.id,
      keyEpoch: slot.keyEpoch,
      binding: b,
      publicKey: slot.publicKey!,
    };
  }
  async validate(raw: unknown) {
    try {
      const proof = this.input(browserKeyProofSchema, raw),
        g = this.generation,
        b = this.binding();
      return await this.tx(g, b, "readonly", (s, rows) =>
        same(this.proof(s, rows, b), proof),
      );
    } catch {
      return false;
    }
  }
  /** Inspection only; do not cache this result for later content admission. */
  async validateReplayCoverage(raw: unknown) {
    try {
      const proof = this.input(browserKeyProofSchema, raw),
        g = this.generation,
        b = this.binding();
      return await this.tx(g, b, "readonly", (s, rows) =>
        browserReplayCoverageMatches(
          s,
          rows.find((r) => r.keyId === proof.keyId),
          proof,
          {
            localOwner: this.owner,
            scope: this.scope,
            binding: b,
            now: this.now(),
          },
        ),
      );
    } catch {
      return false;
    }
  }
  private async retained(g: number) {
    const b = this.binding(),
      before = await this.tx(g, b, "readonly", (state, rows) => {
        const proof = this.proof(state, rows, b);
        return {
          proof,
          state: state!,
          slot: this.selectedSlot(state!, b, true),
        };
      });
    this.select(before.state, before.slot);
    const key = await this.provider.resolve();
    await this.tx(g, b, "readonly", (state, rows) => {
      if (
        !same(this.proof(state, rows, b), before.proof) ||
        key.publicKey !== before.proof.publicKey ||
        browserReplayCoverageMatches(
          state,
          rows.find((r) => r.keyId === key.keyId),
          before.proof,
          {
            localOwner: this.owner,
            scope: this.scope,
            binding: b,
            now: this.now(),
          },
        ) !== key.incomingReplayCovered
      )
        throw new BrowserKeyError("CONFLICT");
    });
    return { ...key, proof: before.proof };
  }
  resolve() {
    return this.exclusive((g) => this.retained(g));
  }
  invitation(raw: unknown) {
    return this.exclusive(async (g) => {
      const key = await this.retained(g);
      const invitation = await this.provider.invitation(raw);
      await this.tx(g, key.proof.binding, "readonly", (state, rows) => {
        if (
          !same(this.proof(state, rows, key.proof.binding), key.proof) ||
          invitation.invitation.publicKey !== key.proof.publicKey
        )
          throw new BrowserKeyError("CONFLICT");
      });
      return invitation;
    });
  }
  revoke(raw: unknown) {
    const input = this.input(target, raw);
    this.invalidate();
    const g = this.generation;
    return this.tx(g, null, "readwrite", (s, _rows, meta) => {
      this.expected(s, input.expectedRevision);
      if (!s) throw new BrowserKeyError("MISSING");
      const slot = s.slots.find((x) => x.id === input.keyId);
      if (!slot || slot.state === "deleted")
        throw new BrowserKeyError("MISSING");
      if (slot.state !== "retired") {
        slot.state = "retired";
        this.save(s, meta);
      }
      return { revision: s.revision };
    });
  }
  remove(raw: unknown) {
    const input = this.input(target, raw);
    this.invalidate();
    const g = this.generation;
    return this.tx(g, null, "readwrite", (s, rows, meta, store) => {
      this.expected(s, input.expectedRevision);
      if (!s) throw new BrowserKeyError("MISSING");
      const slot = s.slots.find((x) => x.id === input.keyId);
      if (!slot) throw new BrowserKeyError("MISSING");
      if (slot.state !== "deleted") {
        const row = rows.find((r) => r.keyId === slot.id);
        store.put({
          scope: this.scope,
          keyId: slot.id,
          identity: {
            localOwner: this.owner,
            binding: slot.binding,
            keyId: slot.id,
            keyEpoch: slot.keyEpoch,
          },
          state: "deleted",
          publicKey: null,
          privateHandle: null,
          publicHandle: null,
          recovery: null,
        });
        slot.state = "deleted";
        slot.publicKey = null;
        this.save(s, meta);
      }
      return { revision: s.revision };
    });
  }
  clear(raw: unknown) {
    const input = this.input(checked, raw);
    this.invalidate();
    const g = this.generation;
    return this.tx(g, null, "readwrite", (s, rows, meta, store) => {
      this.expected(s, input.expectedRevision);
      if (!s) {
        if (rows.length) throw new BrowserKeyError("SETUP_REQUIRED");
        return { revision: 0 };
      }
      for (const slot of s.slots) {
        store.put({
          scope: this.scope,
          keyId: slot.id,
          identity: {
            localOwner: this.owner,
            binding: slot.binding,
            keyId: slot.id,
            keyEpoch: slot.keyEpoch,
          },
          state: "deleted",
          publicKey: null,
          privateHandle: null,
          publicHandle: null,
          recovery: null,
        });
        slot.state = "deleted";
        slot.publicKey = null;
      }
      s.locked = true;
      this.save(s, meta);
      return { revision: s.revision };
    });
  }
  reset(raw: unknown) {
    const input = this.input(checked, raw);
    this.invalidate();
    const g = this.generation,
      b = this.binding();
    return this.tx(g, b, "readwrite", (state, rows, meta) => {
      this.expected(state, input.expectedRevision);
      if (
        !this.freshRegistration(b) ||
        state?.deviceId === b.deviceId ||
        (state && state.ownerId !== b.ownerId) ||
        rows.some(
          (r) =>
            r.identity.binding.deviceId === b.deviceId ||
            r.identity.binding.ownerId !== b.ownerId,
        )
      )
        throw new BrowserKeyError("SETUP_REQUIRED");
      if (!state && !rows.length) throw new BrowserKeyError("SETUP_REQUIRED");
      const s = state ?? {
        scope: this.scope,
        revision: 0,
        ownerId: b.ownerId,
        deviceId: b.deviceId,
        locked: false,
        slots: rows.map((r) => ({
          id: r.keyId,
          keyEpoch: r.identity.keyEpoch,
          binding: r.identity.binding,
          createdAt: this.now(),
          state:
            r.state === "deleted" ? ("deleted" as const) : ("retired" as const),
          publicKey: r.state === "ready" ? r.publicKey : null,
        })),
      };
      if (s.slots.some((x) => x.binding.deviceId === b.deviceId))
        throw new BrowserKeyError("SETUP_REQUIRED");
      for (const slot of s.slots)
        if (slot.state === "active" || slot.state === "preparing")
          slot.state = "retired";
      s.deviceId = b.deviceId;
      s.locked = false;
      this.save(s, meta);
      return { revision: s.revision };
    });
  }
  recovery(raw: unknown) {
    return this.provider.recovery(raw);
  }
}
