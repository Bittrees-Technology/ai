import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { normalizeKeychainSecret } from "../../modules/storage/keychain.js";
import type { PrivateKeyEntries } from "../../modules/remote/private-endpoint-keys.js";
const services = {
  key: "org.bittrees.ai.endpoint-keys",
  attempt: "org.bittrees.ai.endpoint-key-attempts",
  deleted: "org.bittrees.ai.endpoint-key-deletions",
};
export function privateKeyAccount(
  profile: string,
  localOwner: string,
  keyId: string,
) {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(profile) ||
    !localOwner ||
    localOwner.length > 256 ||
    !z.uuid().safeParse(keyId).success
  )
    throw Error("Invalid endpoint key slot");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "org.bittrees.ai/endpoint-slot/v1",
        profile,
        localOwner,
        keyId,
      ]),
    )
    .digest("hex");
}
/** Only a trusted bundled helper path. No secret bytes enter arguments, env or output. */
export function macPrivateKeyEntries(
  helper: string,
  profile: string,
  localOwner: string,
  keyId: string,
): PrivateKeyEntries {
  if (process.platform !== "darwin" || !isAbsolute(helper))
    throw Error("Private key storage requires macOS");
  const account = privateKeyAccount(profile, localOwner, keyId);
  const slot = (kind: keyof typeof services) => {
    const native = new AsyncEntry(services[kind], account);
    return {
      getSecret: async () => normalizeKeychainSecret(await native.getSecret()),
      deleteCredential: () => native.deleteCredential(),
      addSecretIfAbsent(value: Uint8Array): Promise<boolean> {
        if (!value.byteLength || value.byteLength > 4096)
          return Promise.reject(Error("Invalid endpoint key record"));
        return new Promise((resolve, reject) => {
          const child = spawn(helper, ["--kind", kind, "--account", account], {
            env: {
              HOME: homedir(),
              TMPDIR: tmpdir(),
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              LANG: "en_US.UTF-8",
            },
            stdio: ["pipe", "ignore", "ignore"],
            timeout: 60000,
          });
          child.on("error", () =>
            reject(Error("Endpoint key storage unavailable")),
          );
          child.stdin.on("error", () => {});
          child.on("close", (code) =>
            code === 0
              ? resolve(true)
              : code === 2
                ? resolve(false)
                : reject(Error("Endpoint key storage unconfirmed")),
          );
          child.stdin.end(value);
        });
      },
    };
  };
  return {
    key: slot("key"),
    attempt: slot("attempt"),
    deleted: slot("deleted"),
  };
}
