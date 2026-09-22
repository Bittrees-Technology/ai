import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadStorageKey,
  type SecretEntry,
} from "../../modules/storage/keychain.js";
import { Vault } from "../../modules/storage/vault.js";
import { restoreContentBackup } from "../../modules/storage/content-backup.js";
export class RecoveryError extends Error {}
export function recoveryArguments(args: string[]) {
  const values = new Map<string, string>();
  let confirmed = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--confirm" && !confirmed) {
      confirmed = true;
      continue;
    }
    if (
      !["--backup", "--destination-parent"].includes(flag) ||
      values.has(flag)
    )
      throw new RecoveryError("INVALID_ARGUMENTS");
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new RecoveryError("INVALID_ARGUMENTS");
    values.set(flag, value);
  }
  if (!confirmed || values.size !== 2)
    throw new RecoveryError("INVALID_ARGUMENTS");
  return {
    backup: resolve(values.get("--backup")!),
    parent: resolve(values.get("--destination-parent")!),
  };
}
/** Holds the same local port as the engine, but never opens current personal stores. */
export async function recoverContentCopy(
  backup: string,
  parent: string,
  entry: SecretEntry,
  port = 43127,
) {
  const guard = createServer((_req, res) => res.writeHead(503).end());
  try {
    await new Promise<void>((done, reject) => {
      guard.once("error", reject);
      guard.listen(port, "127.0.0.1", done);
    });
  } catch {
    throw new RecoveryError("COMPANION_RUNNING_OR_PORT_UNAVAILABLE");
  }
  try {
    try {
      if (!(await stat(backup)).isFile() || !(await stat(parent)).isDirectory())
        throw Error();
    } catch {
      throw new RecoveryError("INVALID_PATH");
    }
    let key: Buffer;
    try {
      key = await loadStorageKey(entry, true);
    } catch {
      throw new RecoveryError("ORIGINAL_KEY_UNAVAILABLE");
    }
    try {
      const directory = await restoreContentBackup(
        backup,
        new Vault(key),
        parent,
      );
      return { directory, activated: false as const };
    } catch {
      throw new RecoveryError("BACKUP_RESTORE_FAILED");
    } finally {
      key.fill(0);
    }
  } finally {
    guard.closeAllConnections();
    await new Promise<void>((done) => guard.close(() => done()));
  }
}
