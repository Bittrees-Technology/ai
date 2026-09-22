import { stat } from "node:fs/promises";
import {
  loadStorageKey,
  type SecretEntry,
} from "../../modules/storage/keychain.js";
import {
  createRecoveryKit,
  recoverStorageKey,
} from "../../modules/storage/recovery-kit.js";
import { restoreContentBackup } from "../../modules/storage/content-backup.js";
import { Vault } from "../../modules/storage/vault.js";
import { RecoveryError, withCompanionStopped } from "./recovery.js";
/** Not wired to HTTP, CLI or native UI until recovery delivery/review is implemented. */
export async function prepareUserRecoveryKit(entry: SecretEntry) {
  let key: Buffer;
  try {
    key = await loadStorageKey(entry, true);
  } catch {
    throw new RecoveryError("ORIGINAL_KEY_UNAVAILABLE");
  }
  try {
    return createRecoveryKit(key);
  } finally {
    key.fill(0);
  }
}
/** Recovers a separate copy without reading, creating or replacing a Keychain entry. */
export async function recoverContentWithKit(
  backup: string,
  parent: string,
  kit: Uint8Array,
  recoveryCode: string,
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
      key = recoverStorageKey(kit, recoveryCode);
    } catch {
      throw new RecoveryError("RECOVERY_KIT_REJECTED");
    }
    try {
      const directory = await restoreContentBackup(
        backup,
        new Vault(key),
        parent,
      );
      return {
        directory,
        activated: false as const,
        keyInstalled: false as const,
      };
    } catch {
      throw new RecoveryError("BACKUP_RESTORE_FAILED");
    } finally {
      key.fill(0);
    }
  }, port);
}
