import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

export class StorageCandidateSkip extends Error {}

const pin = "1f822446f357a0b499f2b318438e7262377259365ef1ef54d398b86322498b85";
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
  activity?: { url: string; token: string; operationId: string },
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
    "try:\n result=inventory() if mode=='inventory' else inspect(request['path'],request.get('checkout')) if mode=='inspect' else remove(request['proof']) if mode=='remove' else activity(request['path'],None) if mode=='activity' else None\n" +
    "except SafeCandidateSkip:\n result={'safeCandidateSkip':True}\n" +
    "print(json.dumps(result))\n";
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", "-"], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: homedir(),
        ...(activity
          ? {
              BITTREES_STORAGE_ACTIVITY_URL: activity.url,
              BITTREES_STORAGE_ACTIVITY_TOKEN: activity.token,
              BITTREES_STORAGE_OPERATION_ID: activity.operationId,
            }
          : {}),
      },
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
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result?.safeCandidateSkip === true)
          return reject(new StorageCandidateSkip("Candidate safely held"));
        resolve(result);
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
  private activity?: {
    operationId: string;
    path: string;
    checkout: string | null;
    revision: string;
  };
  activityApproval(id: string) {
    return this.authorized() &&
      this.activity?.operationId === id &&
      this.activityConfig?.()?.revision === this.activity.revision
      ? this.activity
      : null;
  }
  private async read(input: any, signal: AbortSignal) {
    if (input.mode === "inventory") return sourceRead(input, signal);
    const config = this.activityConfig?.();
    if (!config || this.activity)
      throw Error("Storage safety helper unavailable");
    const url = new URL(config.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/activity" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^[a-f0-9]{64}$/.test(config.token)
    )
      throw Error("Invalid activity helper");
    const target = input.proof ?? input;
    const operationId = randomUUID();
    this.activity = {
      operationId,
      path: target.path,
      checkout: target.checkout ?? null,
      revision: config.revision,
    };
    try {
      return await sourceRead(input, signal, { ...config, operationId });
    } finally {
      this.activity = undefined;
    }
  }
  constructor(
    path: string,
    vault: Vault,
    private authorized: () => boolean,
    private activityConfig?: () =>
      { url: string; token: string; revision: string } | undefined,
  ) {
    this.journal = new StorageCleanupJournal(path, vault, {
      authorized,
      revalidate: async (proof, signal) =>
        (await this.read(
          { mode: "inspect", path: proof.path, checkout: proof.checkout },
          signal,
        )) as StorageCleanupProof,
      removeVerifiedCache: async (proof, signal) =>
        (await this.read(
          { mode: "remove", proof },
          signal,
        )) as StorageCleanupResult,
    });
  }
  async probe(signal: AbortSignal): Promise<void> {
    if (!this.authorized()) throw Error("Storage source approval required");
    try {
      await this.read(
        { mode: "activity", path: homedir() + "/.npm/_cacache" },
        signal,
      );
    } catch (error) {
      if (!(error instanceof StorageCandidateSkip)) throw error;
    }
    if (!this.authorized()) throw Error("Storage source approval changed");
  }
  async inventory(signal: AbortSignal) {
    if (!this.authorized()) throw Error("Storage source approval required");
    const value = inventorySchema.parse(
      await this.read({ mode: "inventory" }, signal),
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
    const value = (await this.read(
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
