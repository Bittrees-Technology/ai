import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { macKeychainEntry } from "../../modules/storage/keychain.js";
export interface AddOnlySecretEntry {
  getSecret(): Promise<Uint8Array | undefined>;
  /** Must atomically add without changing an existing item; false means it exists. */
  addSecretIfAbsent(value: Uint8Array): Promise<boolean>;
}
/** Caller supplies the trusted bundled helper, never a user-provided executable. */
export function macAddOnlyEntry(
  helper: string,
  profile = "personal",
): AddOnlySecretEntry {
  if (!isAbsolute(helper)) throw Error("Invalid key helper");
  const entry = macKeychainEntry(profile);
  return {
    getSecret: async () => (await entry.getSecret()) ?? undefined,
    addSecretIfAbsent(value) {
      if (value.byteLength !== 32)
        return Promise.reject(Error("Invalid storage key"));
      return new Promise((resolve, reject) => {
        const child = spawn(helper, ["--profile", profile], {
          env: {
            HOME: homedir(),
            TMPDIR: tmpdir(),
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: "en_US.UTF-8",
          },
          stdio: ["pipe", "ignore", "ignore"],
          timeout: 60000,
        });
        child.on("error", () => reject(Error("Key installation unavailable")));
        child.stdin.on("error", () => {
          /* Exit status determines outcome; never echo secret input. */
        });
        child.on("close", (code) =>
          code === 0
            ? resolve(true)
            : code === 2
              ? resolve(false)
              : reject(Error("Key installation unconfirmed")),
        );
        child.stdin.end(value);
      });
    },
  };
}
