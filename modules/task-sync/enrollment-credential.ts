import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { Vault } from "../storage/vault.js";

/** Read the existing device bearer without creating credentials or calling
 * Keychain. Trusted native owner supplies the already-unlocked vaults. Never
 * fall back to another identity when a preferred connection is unreadable.
 */
export async function existingEnrollmentCredential(
  directory: string,
  personal: Vault,
  coordinator?: Vault,
): Promise<string> {
  if (!isAbsolute(directory)) throw Error("Absolute app directory required");
  const marketplace = join(directory, "marketplace");
  let preferred = false;
  try {
    const parent = await lstat(marketplace);
    if (parent.isSymbolicLink() || !parent.isDirectory())
      throw Error("Invalid coordinator directory");
    await lstat(join(marketplace, "connection.enc"));
    preferred = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const vault = preferred ? coordinator : personal;
  if (!vault) throw Error("Existing coordinator vault required");
  const path = preferred
    ? join(marketplace, "connection.enc")
    : join(directory, "workflow-device.enc");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 29 || before.size > 65536)
      throw Error("Invalid encrypted device credential");
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== bytes.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Device credential changed during read");
    const value = vault.open<unknown>(
      bytes,
      preferred ? "marketplace-connection" : "workflow-device",
    );
    return z
      .object({ controlToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(value).controlToken;
  } finally {
    await file.close();
  }
}
