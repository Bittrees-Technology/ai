import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { z } from "zod";

export const privateEnvelopeSuite = "HPKE-Auth-P256-SHA256-AES256GCM" as const;
export const privateEnvelopeLimit = 65536;
const uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const privateHeaderSchema = z.strictObject({
  version: z.literal(1),
  suite: z.literal(privateEnvelopeSuite),
  ownerId: uuid,
  senderId: uuid,
  recipientId: uuid,
  senderKeyEpoch: positive,
  recipientKeyEpoch: positive,
  messageId: uuid,
  operationId: uuid,
  sequence: positive,
  issuedAt: positive,
  expiresAt: positive,
});
export type PrivateHeader = z.infer<typeof privateHeaderSchema>;
const encoded = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
export const privateEnvelopeSchema = z.strictObject({
  header: privateHeaderSchema,
  enc: encoded(87),
  ciphertext: encoded(Math.ceil(((privateEnvelopeLimit + 16) * 4) / 3)),
});
export type PrivateEnvelope = z.infer<typeof privateEnvelopeSchema>;
export class PrivateEnvelopeError extends Error {
  readonly code = "PRIVATE_ENVELOPE_INVALID";
  constructor() {
    super("PRIVATE_ENVELOPE_INVALID");
  }
}
const encoder = new TextEncoder();
const info = encoder.encode("org.bittrees.ai/private-envelope/v1");
const suite = () =>
  new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
function aad(h: PrivateHeader) {
  return encoder.encode(
    JSON.stringify([
      h.version,
      h.suite,
      h.ownerId,
      h.senderId,
      h.recipientId,
      h.senderKeyEpoch,
      h.recipientKeyEpoch,
      h.messageId,
      h.operationId,
      h.sequence,
      h.issuedAt,
      h.expiresAt,
    ]),
  );
}
function validTime(h: PrivateHeader, now: number) {
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    h.senderId === h.recipientId ||
    h.issuedAt > now + 30000 ||
    h.expiresAt <= now ||
    h.expiresAt <= h.issuedAt ||
    h.expiresAt - h.issuedAt > 86400000
  )
    throw new PrivateEnvelopeError();
}
function key(key: CryptoKey, type: "public" | "private") {
  if (
    !(key instanceof CryptoKey) ||
    key.type !== type ||
    key.algorithm.name !== "ECDH" ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
    (type === "private" && !key.usages.includes("deriveBits"))
  )
    throw new PrivateEnvelopeError();
  return key;
}
function pair(value: CryptoKeyPair): CryptoKeyPair {
  return {
    privateKey: key(value.privateKey, "private"),
    publicKey: key(value.publicKey, "public"),
  };
}
function encode(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096)
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(text: string) {
  const bytes = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(bytes) !== text) throw new PrivateEnvelopeError();
  return bytes;
}

/** Internal codec only. Keys must be independently pinned; this neither enrolls recipients nor authorizes actions. */
export async function sealPrivateEnvelope(
  rawHeader: unknown,
  plaintext: Uint8Array,
  keys: { senderKey: CryptoKeyPair; recipientPublicKey: CryptoKey },
  now = Date.now,
): Promise<PrivateEnvelope> {
  let owned: Uint8Array | undefined;
  try {
    const header = privateHeaderSchema.parse(rawHeader);
    validTime(header, now());
    if (
      !(plaintext instanceof Uint8Array) ||
      !(plaintext.buffer instanceof ArrayBuffer) ||
      plaintext.byteLength < 1 ||
      plaintext.byteLength > privateEnvelopeLimit
    )
      throw new PrivateEnvelopeError();
    owned = new Uint8Array(plaintext);
    const senderKey = pair(keys.senderKey),
      recipientPublicKey = key(keys.recipientPublicKey, "public");
    // One-shot HPKE Auth: no shared sender contexts, no caller-chosen ephemeral key or nonce.
    const result = await suite().seal(
      { senderKey, recipientPublicKey, info },
      owned,
      aad(header),
    );
    validTime(header, now());
    return privateEnvelopeSchema.parse({
      header,
      enc: encode(new Uint8Array(result.enc)),
      ciphertext: encode(new Uint8Array(result.ct)),
    });
  } catch {
    throw new PrivateEnvelopeError();
  } finally {
    owned?.fill(0);
  }
}

/** expectedHeader must pass current trusted routing/epoch checks. Candidate message/operation/sequence
 * fields must be consumed in a durable acceptance transaction before any dispatch.
 * Successful decryption is NOT replay consumption or action approval. Persist acceptance atomically before use.
 */
export async function openPrivateEnvelope(
  raw: unknown,
  expectedHeader: unknown,
  keys: { recipientKey: CryptoKeyPair; senderPublicKey: CryptoKey },
  now = Date.now,
): Promise<{ header: PrivateHeader; plaintext: Uint8Array }> {
  let owned: Uint8Array | undefined;
  try {
    const envelope = privateEnvelopeSchema.parse(raw),
      expected = privateHeaderSchema.parse(expectedHeader),
      header = envelope.header;
    validTime(header, now());
    if (JSON.stringify(header) !== JSON.stringify(expected))
      throw new PrivateEnvelopeError();
    const enc = decode(envelope.enc),
      ciphertext = decode(envelope.ciphertext);
    if (
      enc.length !== 65 ||
      enc[0] !== 4 ||
      ciphertext.length < 17 ||
      ciphertext.length > privateEnvelopeLimit + 16
    )
      throw new PrivateEnvelopeError();
    const recipientKey = pair(keys.recipientKey),
      senderPublicKey = key(keys.senderPublicKey, "public");
    owned = new Uint8Array(
      await suite().open(
        { recipientKey, senderPublicKey, enc, info },
        ciphertext,
        aad(header),
      ),
    );
    validTime(header, now());
    if (owned.length < 1 || owned.length > privateEnvelopeLimit)
      throw new PrivateEnvelopeError();
    const plaintext = owned;
    owned = undefined;
    return { header, plaintext };
  } catch {
    throw new PrivateEnvelopeError();
  } finally {
    owned?.fill(0);
  }
}
