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
  return new AsyncEntry("org.bittrees.ai.storage", profile);
}
