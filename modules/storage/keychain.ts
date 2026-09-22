import { AsyncEntry } from "@napi-rs/keyring";
import { randomBytes, timingSafeEqual } from "node:crypto";
export interface SecretEntry {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(value: Uint8Array): Promise<void>;
}
export async function loadStorageKey(
  entry: SecretEntry,
  existingData: boolean,
): Promise<Buffer> {
  const saved = await entry.getSecret();
  if (saved) {
    if (saved.length !== 32) throw new Error("Invalid key-store entry");
    return Buffer.from(saved);
  }
  if (existingData)
    throw new Error(
      "Storage key unavailable; restore the original key before opening existing data",
    );
  const key = randomBytes(32);
  await entry.setSecret(key);
  const verified = await entry.getSecret();
  if (
    !verified ||
    verified.length !== 32 ||
    !timingSafeEqual(key, Buffer.from(verified))
  )
    throw new Error("Key-store verification failed");
  return key;
}
export function macKeychainEntry(profile: string): SecretEntry {
  if (process.platform !== "darwin")
    throw new Error("Packaged key storage currently supports macOS only");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("Invalid profile");
  const entry = new AsyncEntry("org.bittrees.ai.storage", profile);
  return {
    getSecret: async () => normalizeKeychainSecret(await entry.getSecret()),
    setSecret: async (value) => {
      await entry.setSecret(value);
    },
  };
}

/** The native addon can return number[]/null despite its async TypeScript declaration. */
export function normalizeKeychainSecret(
  value: unknown,
): Uint8Array | undefined {
  if (value == null) return undefined;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (
    Array.isArray(value) &&
    Array.from(value).every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    return Uint8Array.from(value);
  throw new Error("Invalid key-store response");
}
