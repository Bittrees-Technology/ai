import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const browserKeyIdentitySchema = z.strictObject({
  localOwner: z.string().min(1).max(256),
  binding: privateBindingSchema,
  keyId: z.uuid(),
  keyEpoch: positive,
});
export type BrowserKeyIdentity = z.infer<typeof browserKeyIdentitySchema>;
const encoded = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
export const browserKeyRecoverySchema = z.strictObject({
  format: z.literal("bittrees-browser-endpoint-recovery-v1"),
  iv: encoded(16),
  ciphertext: encoded(4096),
});
export type BrowserKeyRecovery = z.infer<typeof browserKeyRecoverySchema>;
const payloadSchema = z.strictObject({
  identity: browserKeyIdentitySchema,
  publicKey: encoded(87),
  privateKey: encoded(1024),
});
const aad = new TextEncoder().encode(
  "org.bittrees.ai/browser-endpoint-recovery/v1",
);
const encode = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function decode(value: string) {
  const b = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(b) !== value) throw Error();
  return b;
}
function checkKey(key: CryptoKey) {
  if (
    !(key instanceof CryptoKey) ||
    key.type !== "secret" ||
    key.extractable ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256 ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  )
    throw Error();
}
/** This opens key material only. It never restores registration, consent, replay
 * authority or a slot. A lifecycle host must reconcile those separately. */
export async function openBrowserKeyRecovery(
  raw: unknown,
  recoveryKey: CryptoKey,
) {
  let plaintext: Uint8Array<ArrayBuffer> | undefined,
    secret: Uint8Array<ArrayBuffer> | undefined;
  try {
    checkKey(recoveryKey);
    const kit = browserKeyRecoverySchema.parse(raw),
      iv = decode(kit.iv),
      ciphertext = decode(kit.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 3072)
      throw Error();
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
        recoveryKey,
        ciphertext,
      ),
    );
    const record = payloadSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
    secret = decode(record.privateKey);
    const publicBytes = decode(record.publicKey);
    if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw Error();
    const pair = {
      privateKey: await crypto.subtle.importKey(
        "pkcs8",
        secret,
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
    const probe = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      ),
      left = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "ECDH", public: probe.publicKey },
          pair.privateKey,
          256,
        ),
      ),
      right = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "ECDH", public: pair.publicKey },
          probe.privateKey,
          256,
        ),
      );
    const match =
      left.length === right.length && left.every((b, i) => b === right[i]);
    left.fill(0);
    right.fill(0);
    if (!match) throw Error();
    return { identity: record.identity, publicKey: record.publicKey, pair };
  } catch {
    throw Error("BROWSER_KEY_RECOVERY_FAILED");
  } finally {
    plaintext?.fill(0);
    secret?.fill(0);
  }
}
/** recoveryKey comes from an explicitly user-held random recovery secret; never
 * persist it beside the kit or substitute the local storage/account credential. */
export async function createBrowserKeyMaterial(
  raw: unknown,
  recoveryKey: CryptoKey,
) {
  let secret: Uint8Array<ArrayBuffer> | undefined,
    plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    checkKey(recoveryKey);
    const identity = browserKeyIdentitySchema.parse(raw),
      generated = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
    secret = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", generated.privateKey),
    );
    const publicKey = encode(
      new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey)),
    );
    plaintext = new TextEncoder().encode(
      JSON.stringify({ identity, publicKey, privateKey: encode(secret) }),
    );
    if (plaintext.length > 3056) throw Error();
    const iv = crypto.getRandomValues(new Uint8Array(12)),
      ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          recoveryKey,
          plaintext,
        ),
      );
    const recovery: BrowserKeyRecovery = {
      format: "bittrees-browser-endpoint-recovery-v1",
      iv: encode(iv),
      ciphertext: encode(ciphertext),
    };
    // Round-trip before any durable ready publication; returned handles are nonextractable.
    const reopened = await openBrowserKeyRecovery(recovery, recoveryKey);
    if (
      JSON.stringify(reopened.identity) !== JSON.stringify(identity) ||
      reopened.publicKey !== publicKey
    )
      throw Error();
    return { ...reopened, recovery };
  } catch {
    throw Error("BROWSER_KEY_RECOVERY_FAILED");
  } finally {
    secret?.fill(0);
    plaintext?.fill(0);
  }
}
