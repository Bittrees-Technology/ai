import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadStorageKey,
  type SecretEntry,
} from "../../modules/storage/keychain.js";
import { restoreContentBackup } from "../../modules/storage/content-backup.js";
import { Vault } from "../../modules/storage/vault.js";
import { RecoveryError, withCompanionStopped } from "./recovery.js";
const pointerName = "active-content.json";
const validName = (v: unknown): v is string =>
  typeof v === "string" && /^bittrees-ai-recovered-[A-Za-z0-9]{6}$/.test(v);
async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("Invalid directory");
}
async function contentDirectory(base: string, name: string) {
  const parent = join(base, "stores"),
    path = join(parent, name);
  await directory(parent);
  await directory(path);
  for (const file of ["tasks.db", "memory.db"]) {
    const info = await lstat(join(path, file));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
      throw Error("Missing content store");
  }
  return path;
}
/** Call only while holding the companion port. An invalid pointer must never create empty stores. */
export async function resolveActiveContent(
  base: string,
): Promise<{
  directory: string;
  name: string | null;
  previous: string | null;
}> {
  await directory(base);
  let handle;
  try {
    handle = await open(
      join(base, pointerName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { directory: base, name: null, previous: null };
    throw new RecoveryError("INVALID_ACTIVE_CONTENT");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024) throw Error();
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) throw Error();
    const pointer = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (
      !pointer ||
      Object.keys(pointer).sort().join(",") !== "current,previous,version" ||
      pointer.version !== 1 ||
      !validName(pointer.current) ||
      !(pointer.previous === null || validName(pointer.previous))
    )
      throw Error();
    return {
      directory: await contentDirectory(base, pointer.current),
      name: pointer.current,
      previous: pointer.previous,
    };
  } catch {
    throw new RecoveryError("INVALID_ACTIVE_CONTENT");
  } finally {
    await handle.close();
  }
}
/** Restore both stores before switching one pointer; every previous dataset remains in place. */
export async function activateContentBackup(
  backup: string,
  base: string,
  entry: SecretEntry,
  port = 43127,
) {
  return withCompanionStopped(async () => {
    const before = await resolveActiveContent(base);
    let key: Buffer;
    try {
      key = await loadStorageKey(entry, true);
    } catch {
      throw new RecoveryError("ORIGINAL_KEY_UNAVAILABLE");
    }
    let restored: string | undefined;
    let committed = false;
    const stage = join(base, `.active-content-${randomUUID()}.tmp`);
    try {
      const parent = join(base, "stores");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await directory(parent);
      restored = await restoreContentBackup(backup, new Vault(key), parent);
      const name = basename(restored);
      await contentDirectory(base, name);
      const handle = await open(stage, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, current: name, previous: before.name }) +
            "\n",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(stage, join(base, pointerName));
      committed = true;
      return {
        directory: restored,
        previousDirectory: before.directory,
        activated: true as const,
      };
    } catch {
      throw new RecoveryError("ACTIVATION_FAILED");
    } finally {
      key.fill(0);
      // A committed pointer must never be undone by cleanup errors.
      await rm(stage, { force: true }).catch(() => {});
      if (!committed && restored)
        await rm(restored, { recursive: true, force: true }).catch(() => {});
    }
  }, port);
}
