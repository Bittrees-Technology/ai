import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import type { PrivateKeyEntries } from "../../modules/remote/private-endpoint-keys.js";
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
/** Only a trusted bundled helper. Secret input/output stays in bounded private pipes. */
export function macPrivateKeyEntries(
  helper: string,
  profile: string,
  localOwner: string,
  keyId: string,
): PrivateKeyEntries {
  if (process.platform !== "darwin" || !isAbsolute(helper))
    throw Error("Private key storage requires macOS");
  const account = privateKeyAccount(profile, localOwner, keyId);
  const run = (
    operation: "read" | "add" | "delete",
    kind: "key" | "attempt" | "deleted",
    value?: Uint8Array,
  ): Promise<{ exists: boolean; bytes: Uint8Array }> => {
    if (operation === "add" && (!value?.byteLength || value.byteLength > 4096))
      return Promise.reject(Error("Invalid endpoint key record"));
    return new Promise((resolve, reject) => {
      const output = Buffer.alloc(4096);
      let length = 0,
        invalid = false;
      const child = spawn(
        helper,
        ["--operation", operation, "--kind", kind, "--account", account],
        {
          env: {
            HOME: homedir(),
            TMPDIR: tmpdir(),
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: "en_US.UTF-8",
          },
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 15000,
          killSignal: "SIGKILL",
        },
      );
      child.on("error", () => {
        output.fill(0);
        reject(Error("Endpoint key storage unavailable"));
      });
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        if (operation !== "read" || length + chunk.length > 4096) {
          invalid = true;
          child.kill("SIGKILL");
        } else {
          chunk.copy(output, length);
          length += chunk.length;
        }
        chunk.fill(0);
      });
      child.on("close", (code) => {
        try {
          if (
            invalid ||
            ![0, 2].includes(code ?? -1) ||
            (code === 2 && length) ||
            (operation === "read" && code === 0 && !length)
          )
            throw Error();
          resolve({
            exists: code === 0,
            bytes: Uint8Array.from(output.subarray(0, length)),
          });
        } catch {
          reject(Error("Endpoint key storage unconfirmed"));
        } finally {
          output.fill(0);
        }
      });
      child.stdin.end(value);
    });
  };
  const slot = (kind: "key" | "attempt" | "deleted") => ({
    getSecret: async () => {
      const result = await run("read", kind);
      return result.exists ? result.bytes : undefined;
    },
    addSecretIfAbsent: async (value: Uint8Array) =>
      (await run("add", kind, value)).exists,
  });
  return {
    key: {
      ...slot("key"),
      deleteCredential: async () => (await run("delete", "key")).exists,
    },
    attempt: slot("attempt"),
    deleted: slot("deleted"),
  };
}
