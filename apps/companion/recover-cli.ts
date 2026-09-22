import { macKeychainEntry } from "../../modules/storage/keychain.js";
import {
  recoveryArguments,
  recoverContentCopy,
  RecoveryError,
} from "./recovery.js";
const help =
  "Usage: recover --backup <coordinated .aib file> --destination-parent <existing folder> --confirm\nQuit Bittrees AI first. Requires the original personal storage key in macOS Keychain. Creates a recovered copy; never replaces or activates current data.";
const messages: Record<string, string> = {
  INVALID_ARGUMENTS: help,
  COMPANION_RUNNING_OR_PORT_UNAVAILABLE:
    "Quit Bittrees AI before recovery. Its local port must be available.",
  INVALID_PATH: "Choose an existing backup file and destination parent folder.",
  ORIGINAL_KEY_UNAVAILABLE:
    "The original storage key is missing, locked or invalid. Recovery stopped without creating a replacement key.",
  BACKUP_RESTORE_FAILED:
    "The backup could not be restored with this key. Check the selected coordinated backup and available disk space. Current application data was not replaced.",
};
if (process.argv.slice(2).length === 1 && process.argv[2] === "--help")
  console.log(help);
else
  try {
    const input = recoveryArguments(process.argv.slice(2));
    const result = await recoverContentCopy(
      input.backup,
      input.parent,
      macKeychainEntry("personal"),
    );
    console.log(
      JSON.stringify({
        status: "recovered-copy",
        ...result,
        note: "Current data was not replaced. Inspect RECOVERY.json before any separate activation; keys, connections, models and import jobs are not recovered.",
      }),
    );
  } catch (error) {
    console.error(
      error instanceof RecoveryError
        ? (messages[error.message] ?? "Recovery failed.")
        : "Recovery unavailable. This command requires macOS Keychain.",
    );
    process.exitCode = 1;
  }
