import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import {
  StorageCleanupJournal,
  assertCleanupScope,
  type StorageCleanupProof,
  type StorageCleanupResult,
} from "./recurring-storage-cleanup.js";

const pin = "5be39a0e84b198710f7ee40e45e4a062d7775795bf8b8e6137a3a630fba2fd85";
const script = fileURLToPath(
  new URL("./storage_cleanup_source.py", import.meta.url),
);
const inventorySchema = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        checkout: z.string().max(4096).nullable(),
      }),
    )
    .max(100),
  complete: z.boolean(),
  scannedDirectories: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative().safe(),
  measuredAt: z.number().int().nonnegative(),
});

/** Fixed bundled program, inherited offline sandbox, bounded IO and owned process group.
 * This is not an HTTP command endpoint. Only operator-created typed adapters call it.
 */
async function sourceRead(
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  for (let parent = dirname(script); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("Storage source directory changed");
    if (dirname(parent) === parent) break;
  }
  const info = await lstat(script);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 65536 ||
    info.mode & 0o022
  )
    throw Error("Storage source identity unavailable");
  const bytes = await readFile(script);
  if (createHash("sha256").update(bytes).digest("hex") !== pin)
    throw Error("Storage source changed; review required");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 65536)
    throw Error("Storage request exceeds bound");
  // Execute verified bytes through isolated stdin, eliminating a path replacement race.
  const program =
    bytes.toString("utf8").replace("if __name__ == '__main__':", "if False:") +
    "\nrequest=json.loads(" +
    JSON.stringify(serialized) +
    ")\n" +
    "mode=request['mode']\n" +
    "result=inventory() if mode=='inventory' else inspect(request['path'],request.get('checkout')) if mode=='inspect' else remove(request['proof']) if mode=='remove' else None\n" +
    "print(json.dumps(result))\n";
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", "-"], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir() },
    });
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const stop = () => {
      failed = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const timer = setTimeout(stop, 60000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024) stop();
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0 || signal.aborted)
        return reject(
          Error(
            "Storage source safety check failed; reconcile before mutation retry",
          ),
        );
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Error("Storage source returned invalid evidence"));
      }
    });
    child.stdin.end(program);
  });
}

/** Unregistered native source preparation: approval callback must be exact definition
 * and action authority, never merely a model decision or an imported task title.
 */
export class StorageCleanupSource {
  private journal: StorageCleanupJournal;
  constructor(
    path: string,
    vault: Vault,
    private authorized: () => boolean,
  ) {
    this.journal = new StorageCleanupJournal(path, vault, {
      authorized,
      revalidate: async (proof, signal) =>
        (await sourceRead(
          { mode: "inspect", path: proof.path, checkout: proof.checkout },
          signal,
        )) as StorageCleanupProof,
      removeVerifiedCache: async (proof, signal) =>
        (await sourceRead(
          { mode: "remove", proof },
          signal,
        )) as StorageCleanupResult,
    });
  }
  async inventory(signal: AbortSignal) {
    if (!this.authorized()) throw Error("Storage source approval required");
    const value = inventorySchema.parse(
      await sourceRead({ mode: "inventory" }, signal),
    );
    if (!this.authorized()) throw Error("Storage source approval changed");
    return value;
  }
  async inspect(
    path: string,
    checkout: string | undefined,
    signal: AbortSignal,
  ) {
    if (!this.authorized()) throw Error("Storage source approval required");
    // Lexical gate before invoking the worker. Full filesystem proof is worker-owned.
    assertCleanupScope({
      path,
      checkout,
      ignoredAndUntracked: true,
      repositoryStatusHash: "0".repeat(64),
    } as StorageCleanupProof);
    const value = (await sourceRead(
      { mode: "inspect", path, checkout },
      signal,
    )) as StorageCleanupProof;
    if (!this.authorized()) throw Error("Storage source approval changed");
    return value;
  }
  execute(id: string, proof: StorageCleanupProof, signal: AbortSignal) {
    return this.journal.execute(id, proof, signal);
  }
  close() {
    this.journal.close();
  }
}
