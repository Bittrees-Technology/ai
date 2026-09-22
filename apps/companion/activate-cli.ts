import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { macKeychainEntry } from "../../modules/storage/keychain.js";
import { activateContentBackup, rollbackContent } from "./active-content.js";
import { RecoveryError } from "./recovery.js";
export function activationArguments(args: string[]) {
  if (args.length === 2 && args[0] === "--previous" && args[1] === "--confirm")
    return { previous: true as const };
  if (
    args.length !== 3 ||
    args[0] !== "--backup" ||
    !args[1] ||
    args[1].startsWith("--") ||
    args[2] !== "--confirm"
  )
    throw new RecoveryError("INVALID_ARGUMENTS");
  return { backup: resolve(args[1]) };
}
const help =
  "Usage: activate --backup <coordinated .aib file> --confirm | activate --previous --confirm\nQuit Bittrees AI first. Requires the original personal Keychain key. Activates a freshly restored copy for this source build; older installed apps do not read the new selection. Keep a current backup before switching. --previous restores a fresh copy of the immediately previous content and retains the current data; it does not undo the app version or delete any copy.";
const messages: Record<string, string> = {
  INVALID_ARGUMENTS: help,
  NO_PREVIOUS_CONTENT: "There is no previous content selection to restore.",
  COMPANION_RUNNING_OR_PORT_UNAVAILABLE:
    "Quit Bittrees AI before activation. Its local port must be available.",
  INVALID_ACTIVE_CONTENT:
    "Current content selection is invalid or unavailable. Activation stopped; no empty replacement was created.",
  ORIGINAL_KEY_UNAVAILABLE:
    "The original storage key is missing, locked or invalid. No replacement key was created.",
  ACTIVATION_FAILED:
    "Backup activation failed. The previous content selection remains unchanged. Check the backup, original key and disk space.",
};
// Importable parser has no Keychain or filesystem side effects.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length === 3 && process.argv[2] === "--help")
    console.log(help);
  else
    try {
      const input = activationArguments(process.argv.slice(2));
      const base = join(
        homedir(),
        "Library",
        "Application Support",
        "Bittrees AI",
      );
      const entry = macKeychainEntry("personal");
      const result =
        "previous" in input
          ? await rollbackContent(base, entry)
          : await activateContentBackup(input.backup, base, entry);
      console.log(
        JSON.stringify({
          ...result,
          note: "Start this source build to use recovered content. Previous content was retained. Remote control consent is cleared; current source permissions still apply. Models, connections and import jobs are unchanged.",
        }),
      );
    } catch (error) {
      console.error(
        error instanceof RecoveryError
          ? (messages[error.message] ?? "Activation failed.")
          : "Activation unavailable. Requires macOS Keychain and an existing companion data folder.",
      );
      process.exitCode = 1;
    }
}
