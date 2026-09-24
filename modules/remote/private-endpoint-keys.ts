import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  privateBindingSchema,
  inspectPrivateInvitation,
} from "./private-peer-contracts.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.strictObject({
  localOwner: z.string().min(1).max(256),
  binding: privateBindingSchema,
  keyId: z.uuid(),
  keyEpoch: positive,
});
const recordSchema = identitySchema.extend({
  version: z.literal(1),
  incomingReplayBoundary: z.literal("from-generation-v1").optional(),
  publicKey: z
    .string()
    .length(87)
    .regex(/^[A-Za-z0-9_-]+$/),
  privateKey: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type PrivateKeyAuthority = z.infer<typeof identitySchema> & {
  creationAllowed: boolean;
};
export interface PrivateKeySlot {
  /** Returns owned bytes; callers wipe their read buffers. */
  getSecret(): Promise<Uint8Array | undefined>;
  /** Atomic add; never update an existing item. */
  addSecretIfAbsent(value: Uint8Array): Promise<boolean>;
}
export interface PrivateKeyEntries {
  key: PrivateKeySlot & { deleteCredential(): Promise<boolean> };
  attempt: PrivateKeySlot;
  deleted: PrivateKeySlot;
}
export class PrivateKeyError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "MISSING"
      | "CREATION_INCOMPLETE"
      | "DELETED"
      | "CONFLICT"
      | "STORAGE_UNAVAILABLE"
      | "BUSY",
  ) {
    super(code);
  }
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && timingSafeEqual(a, b);
const identity = (value: PrivateKeyAuthority) =>
  identitySchema.parse({
    localOwner: value.localOwner,
    binding: value.binding,
    keyId: value.keyId,
    keyEpoch: value.keyEpoch,
  });
/** One immutable key slot selected by current trusted lifecycle state. Does not register a
 * device, grant consent, select authority from stored bytes, recover or rotate by itself.
 * entryFor must isolate the local owner/profile and return stable, add-only slots.
 */
export class PrivateEndpointKeys {
  private busy = false;
  private generation = 0;
  /** Host calls immediately on pairing/permission/key changes, even if identity later returns. */
  invalidate() {
    this.generation++;
    this.cache = undefined;
  }
  private cache?: {
    record: Buffer;
    scope: string;
    pair: CryptoKeyPair;
    incomingReplayCovered: boolean;
  };
  constructor(
    private localOwner: string,
    private entryFor: (keyId: string) => PrivateKeyEntries,
    private current: () => PrivateKeyAuthority | null,
    private now = Date.now,
  ) {}
  private authority() {
    const value = this.current();
    try {
      if (!value || typeof value.creationAllowed !== "boolean") throw Error();
      const parsed = identity(value);
      if (
        parsed.localOwner !== this.localOwner ||
        parsed.binding.expiresAt <= this.now()
      )
        throw Error();
      return { ...parsed, creationAllowed: value.creationAllowed };
    } catch {
      throw new PrivateKeyError("DENIED");
    }
  }
  private unchanged(a: PrivateKeyAuthority) {
    if (
      JSON.stringify(identity(this.authority())) !== JSON.stringify(identity(a))
    )
      throw new PrivateKeyError("CONFLICT");
  }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.busy) throw new PrivateKeyError("BUSY");
    this.busy = true;
    const generation = this.generation;
    try {
      const value = await action();
      if (generation !== this.generation) throw new PrivateKeyError("CONFLICT");
      return value;
    } catch (e) {
      this.cache = undefined;
      if (e instanceof PrivateKeyError) throw e;
      throw new PrivateKeyError("STORAGE_UNAVAILABLE");
    } finally {
      this.busy = false;
    }
  }
  private marker(a: PrivateKeyAuthority) {
    return createHash("sha256")
      .update(encode(["org.bittrees.ai/endpoint-attempt/v1", identity(a)]))
      .digest();
  }
  private async live(entries: PrivateKeyEntries) {
    if (await entries.deleted.getSecret()) throw new PrivateKeyError("DELETED");
  }
  private async load(a: PrivateKeyAuthority, entries: PrivateKeyEntries) {
    await this.live(entries);
    const marker = await entries.attempt.getSecret();
    if (!marker || !same(marker, this.marker(a)))
      throw new PrivateKeyError("CONFLICT");
    const raw = await entries.key.getSecret();
    if (!raw) throw new PrivateKeyError("MISSING");
    try {
      if (raw.length > 4096) throw new PrivateKeyError("STORAGE_UNAVAILABLE");
      let pair: CryptoKeyPair;
      let incomingReplayCovered: boolean;
      if (this.cache && same(this.cache.record, await this.digest(raw))) {
        if (this.cache.scope !== JSON.stringify(identity(a)))
          throw new PrivateKeyError("CONFLICT");
        pair = this.cache.pair;
        incomingReplayCovered = this.cache.incomingReplayCovered;
      } else {
        const record = recordSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        );
        if (
          JSON.stringify(
            identitySchema.parse({
              localOwner: record.localOwner,
              binding: record.binding,
              keyId: record.keyId,
              keyEpoch: record.keyEpoch,
            }),
          ) !== JSON.stringify(identity(a))
        )
          throw new PrivateKeyError("CONFLICT");
        incomingReplayCovered =
          record.incomingReplayBoundary === "from-generation-v1";
        const privateBytes = Buffer.from(record.privateKey, "base64url"),
          publicBytes = Buffer.from(record.publicKey, "base64url");
        try {
          if (
            privateBytes.toString("base64url") !== record.privateKey ||
            publicBytes.toString("base64url") !== record.publicKey ||
            publicBytes.length !== 65 ||
            publicBytes[0] !== 4
          )
            throw Error();
          pair = {
            privateKey: await crypto.subtle.importKey(
              "pkcs8",
              privateBytes,
              { name: "ECDH", namedCurve: "P-256" },
              false,
              ["deriveBits"],
            ),
            publicKey: await crypto.subtle.importKey(
              "raw",
              publicBytes,
              { name: "ECDH", namedCurve: "P-256" },
              true,
              [],
            ),
          };
          // Prove correspondence without exporting the reimported private handle.
          const probe = await crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            false,
            ["deriveBits"],
          );
          const left = Buffer.from(
            await crypto.subtle.deriveBits(
              { name: "ECDH", public: probe.publicKey },
              pair.privateKey,
              256,
            ),
          );
          const right = Buffer.from(
            await crypto.subtle.deriveBits(
              { name: "ECDH", public: pair.publicKey },
              probe.privateKey,
              256,
            ),
          );
          try {
            if (!same(left, right)) throw Error();
          } finally {
            left.fill(0);
            right.fill(0);
          }
        } finally {
          privateBytes.fill(0);
        }
        // Cache only nonextractable handles and a digest; never retain PKCS8 bytes.
        this.cache = {
          record: await this.digest(raw),
          scope: JSON.stringify(identity(a)),
          pair,
          incomingReplayCovered,
        };
      }
      this.unchanged(a);
      await this.live(entries);
      const latest = await entries.key.getSecret();
      try {
        if (!latest || !same(raw, latest))
          throw new PrivateKeyError("CONFLICT");
      } finally {
        latest?.fill(0);
      }
      this.unchanged(a);
      const publicKey = Buffer.from(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      ).toString("base64url");
      await this.live(entries);
      this.unchanged(a);
      return {
        keyId: a.keyId,
        keyEpoch: a.keyEpoch,
        publicKey,
        incomingReplayCovered,
        pair: { privateKey: pair.privateKey, publicKey: pair.publicKey },
      };
    } finally {
      raw.fill(0);
    }
  }
  private async digest(raw: Uint8Array) {
    return Buffer.from(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(raw)),
    );
  }
  async resolve() {
    return this.exclusive(async () => {
      const a = this.authority(),
        entries = this.entryFor(a.keyId);
      return this.load(a, entries);
    });
  }
  /** Explicit fresh slot only. An attempt marker precedes all generation: missing keys
   * after interruption/deletion never cause generation under the old slot/epoch.
   */
  async create(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
        .strictObject({
          keyId: z.uuid(),
          keyEpoch: positive,
          confirmed: z.literal(true),
        })
        .safeParse(raw);
      const a = this.authority();
      if (
        !input.success ||
        input.data.keyId !== a.keyId ||
        input.data.keyEpoch !== a.keyEpoch
      )
        throw new PrivateKeyError("DENIED");
      const entries = this.entryFor(a.keyId);
      await this.live(entries);
      const existing = await entries.key.getSecret();
      if (existing) {
        existing.fill(0);
        return this.public(await this.load(a, entries));
      }
      if (!a.creationAllowed) throw new PrivateKeyError("DENIED");
      const marker = this.marker(a);
      if (!(await entries.attempt.addSecretIfAbsent(marker))) {
        // Another creator may have finished; no second generation is allowed.
        const saved = await entries.key.getSecret();
        if (saved) {
          saved.fill(0);
          return this.public(await this.load(a, entries));
        }
        throw new PrivateKeyError("CREATION_INCOMPLETE");
      }
      const savedMarker = await entries.attempt.getSecret();
      if (!savedMarker || !same(marker, savedMarker))
        throw new PrivateKeyError("STORAGE_UNAVAILABLE");
      this.unchanged(a);
      if (!this.authority().creationAllowed)
        throw new PrivateKeyError("DENIED");
      await this.live(entries);
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const secret = Buffer.from(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      );
      let encoded: Buffer | undefined;
      try {
        const publicKey = Buffer.from(
          await crypto.subtle.exportKey("raw", pair.publicKey),
        ).toString("base64url");
        encoded = encode({
          version: 1,
          // Only actual generation mints this provenance. Existing native entries
          // and resumed pre-upgrade attempts are read without backfilling it.
          incomingReplayBoundary: "from-generation-v1",
          ...identity(a),
          publicKey,
          privateKey: secret.toString("base64url"),
        });
        this.unchanged(a);
        if (!this.authority().creationAllowed)
          throw new PrivateKeyError("DENIED");
        await this.live(entries);
        if (!(await entries.key.addSecretIfAbsent(encoded)))
          throw new PrivateKeyError("CONFLICT");
        const saved = await entries.key.getSecret();
        try {
          if (!saved || !same(saved, encoded))
            throw new PrivateKeyError("STORAGE_UNAVAILABLE");
        } finally {
          saved?.fill(0);
        }
        return this.public(await this.load(a, entries));
      } finally {
        secret.fill(0);
        encoded?.fill(0);
        // Deletion can race the native add. Keep the permanent tombstone and remove
        // any late key bytes; an uncertain cleanup remains denied on later reads.
        if (await entries.deleted.getSecret()) {
          await entries.key.deleteCredential();
          throw new PrivateKeyError("DELETED");
        }
        this.unchanged(a);
      }
    });
  }
  private public(v: Awaited<ReturnType<PrivateEndpointKeys["load"]>>) {
    return { keyId: v.keyId, keyEpoch: v.keyEpoch, publicKey: v.publicKey };
  }
  async invitation(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
          .strictObject({ recipientId: z.uuid(), confirmed: z.literal(true) })
          .safeParse(raw),
        a = this.authority();
      if (!input.success || input.data.recipientId === a.binding.deviceId)
        throw new PrivateKeyError("DENIED");
      const entries = this.entryFor(a.keyId),
        key = await this.load(a, entries),
        issuedAt = this.now();
      const inspected = await inspectPrivateInvitation(
        {
          version: 1,
          ownerId: a.binding.ownerId,
          peerId: a.binding.deviceId,
          recipientId: input.data.recipientId,
          keyEpoch: a.keyEpoch,
          publicKey: key.publicKey,
          nonce: randomUUID(),
          issuedAt,
          expiresAt: Math.min(issuedAt + 300000, a.binding.expiresAt),
        },
        issuedAt,
      );
      await this.live(entries);
      this.unchanged(a);
      return {
        invitation: inspected.invitation,
        fingerprint: inspected.fingerprint,
      };
    });
  }
  /** Trusted local-owner deletion, available without a live remote lease. The tombstone
   * must remain; it prevents recreating this slot. Caller revokes peer permission first.
   */
  async remove(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
        .strictObject({ keyId: z.uuid(), confirmed: z.literal(true) })
        .safeParse(raw);
      if (!input.success) throw new PrivateKeyError("DENIED");
      this.cache = undefined;
      const entries = this.entryFor(input.data.keyId),
        tombstone = encode({ version: 1, deleted: true });
      await entries.deleted.addSecretIfAbsent(tombstone);
      const marker = await entries.deleted.getSecret();
      if (!marker || !same(marker, tombstone))
        throw new PrivateKeyError("STORAGE_UNAVAILABLE");
      await entries.key.deleteCredential();
      const remaining = await entries.key.getSecret();
      if (remaining) {
        remaining.fill(0);
        throw new PrivateKeyError("STORAGE_UNAVAILABLE");
      }
      return { deletedLocally: true, remoteRevocationConfirmed: false };
    });
  }
}
