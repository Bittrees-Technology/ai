import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
// Fixed v1 binary envelope: magic(8), kit ID(16), salt(32), nonce(12),
// encrypted storage key(32), GCM tag(16). All header bytes are authenticated.
const magic = Buffer.from("BTKEY01\n", "ascii");
const context = Buffer.from(
  "org.bittrees.ai/local-storage-recovery/v1",
  "utf8",
);
export const recoveryKitBytes = 116;
export class RecoveryKitError extends Error {
  constructor() {
    super("INVALID_RECOVERY_KIT");
  }
}
function wrappingKey(code: Uint8Array, salt: Uint8Array) {
  return Buffer.from(hkdfSync("sha256", code, salt, context, 32));
}
function codeBytes(value: string) {
  if (
    typeof value !== "string" ||
    value.length !== 48 ||
    !/^btr1_[A-Za-z0-9_-]{43}$/.test(value)
  )
    throw new RecoveryKitError();
  const bytes = Buffer.from(value.slice(5), "base64url");
  if (bytes.length !== 32 || "btr1_" + bytes.toString("base64url") !== value) {
    bytes.fill(0);
    throw new RecoveryKitError();
  }
  return bytes;
}
/** In-memory foundation only. The caller must separately deliver and protect the code. */
export function createRecoveryKit(storageKey: Uint8Array) {
  if (!(storageKey instanceof Uint8Array) || storageKey.byteLength !== 32)
    throw new RecoveryKitError();
  const secret = randomBytes(32);
  let key: Buffer | undefined;
  try {
    const id = randomBytes(16),
      salt = randomBytes(32),
      nonce = randomBytes(12);
    key = wrappingKey(secret, salt);
    const header = Buffer.concat([magic, id, salt, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.concat([context, header]));
    const encrypted = Buffer.concat([
      cipher.update(storageKey),
      cipher.final(),
    ]);
    return {
      kit: Buffer.concat([header, encrypted, cipher.getAuthTag()]),
      recoveryCode: "btr1_" + secret.toString("base64url"),
      kitId: id.toString("hex"),
    };
  } finally {
    key?.fill(0);
    secret.fill(0);
  }
}
/** Returns an owned key buffer only after authentication; caller must zero it after use. */
export function recoverStorageKey(
  kit: Uint8Array,
  recoveryCode: string,
): Buffer {
  let secret: Buffer | undefined,
    key: Buffer | undefined,
    plaintext: Buffer | undefined;
  try {
    if (!(kit instanceof Uint8Array) || kit.byteLength !== recoveryKitBytes)
      throw new RecoveryKitError();
    const bytes = Buffer.from(kit);
    if (!bytes.subarray(0, 8).equals(magic)) throw new RecoveryKitError();
    secret = codeBytes(recoveryCode);
    key = wrappingKey(secret, bytes.subarray(24, 56));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(56, 68),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.concat([context, bytes.subarray(0, 68)]));
    decipher.setAuthTag(bytes.subarray(100, 116));
    plaintext = decipher.update(bytes.subarray(68, 100));
    const final = decipher.final();
    if (final.length !== 0 || plaintext.length !== 32) {
      final.fill(0);
      throw new RecoveryKitError();
    }
    return Buffer.from(plaintext);
  } catch {
    throw new RecoveryKitError();
  } finally {
    plaintext?.fill(0);
    key?.fill(0);
    secret?.fill(0);
  }
}
