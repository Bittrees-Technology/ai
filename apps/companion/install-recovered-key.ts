import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { AddOnlySecretEntry } from "./key-install.js";
import { resolveActiveContent } from "./active-content.js";
import { withCompanionStopped, RecoveryError } from "./recovery.js";
import { recoverStorageKey } from "../../modules/storage/recovery-kit.js";
import { restoreContentBackup } from "../../modules/storage/content-backup.js";
import { verifyStoredKey } from "../../modules/storage/key-compatibility.js";
import { Vault } from "../../modules/storage/vault.js";
const matches = (a: Uint8Array | undefined, b: Buffer) =>
  !!a && a.byteLength === 32 && timingSafeEqual(a, b);
/** Internal only: validates backup and current key ownership before add-only installation. */
export async function installRecoveredKey(
  backup: string,
  parent: string,
  base: string,
  kit: Uint8Array,
  code: string,
  entry: AddOnlySecretEntry,
  port = 43127,
) {
  return withCompanionStopped(async () => {
    try {
      if (!(await stat(backup)).isFile() || !(await stat(parent)).isDirectory())
        throw Error();
    } catch {
      throw new RecoveryError("INVALID_PATH");
    }
    let key: Buffer;
    try {
      key = recoverStorageKey(kit, code);
    } catch {
      throw new RecoveryError("RECOVERY_KIT_REJECTED");
    }
    try {
      let existing: Uint8Array | undefined;
      try {
        existing = await entry.getSecret();
      } catch {
        throw new RecoveryError("KEY_STORE_UNAVAILABLE");
      }
      if (existing && !matches(existing, key))
        throw new RecoveryError("EXISTING_KEY_CONFLICT");
      try {
        let found = true;
        try {
          await lstat(base);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") found = false;
          else throw error;
        }
        if (found) {
          const current = await resolveActiveContent(base),
            imports = join(base, "model-imports");
          try {
            const info = await lstat(imports);
            if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await verifyStoredKey(current.directory, imports, new Vault(key));
        }
      } catch {
        throw new RecoveryError("CURRENT_DATA_KEY_CONFLICT");
      }
      let directory: string;
      try {
        directory = await restoreContentBackup(backup, new Vault(key), parent);
      } catch {
        throw new RecoveryError("BACKUP_RESTORE_FAILED");
      }
      // After an attempted add, never delete a credential or pretend failure means
      // nothing was written. Preserve the verified copy for explicit reconciliation.
      try {
        const created = await entry.addSecretIfAbsent(key);
        const verified = await entry.getSecret();
        return {
          directory,
          activated: false as const,
          keyStatus: matches(verified, key)
            ? created
              ? ("created" as const)
              : ("already-present" as const)
            : verified == null
              ? ("unconfirmed" as const)
              : ("conflict" as const),
        };
      } catch {
        return {
          directory,
          activated: false as const,
          keyStatus: "unconfirmed" as const,
        };
      }
    } finally {
      key.fill(0);
    }
  }, port);
}
