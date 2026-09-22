import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  rm,
  link,
  open,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createReadStream } from "node:fs";
import { Vault } from "./vault.js";
import { Store, StoreError } from "./store.js";
import { MemoryStore } from "../memory/store.js";
import {
  encryptedBackup,
  encryptedMemoryBackup,
  restoreBackup,
  restoreMemoryBackup,
} from "./backup.js";
// Two encrypted 32 MiB SQLite snapshots, base64 wrapped and authenticated together.
const maxBundleBytes = 128 * 1024 * 1024;
const maxSnapshotBytes = 48 * 1024 * 1024;
const purpose = "content-backup:v1";
type SnapshotStore = Pick<Store, "backup" | "changeToken">;
type SnapshotMemory = Pick<MemoryStore, "backup" | "changeToken">;
export async function createContentBackup(
  tasks: SnapshotStore,
  memory: SnapshotMemory,
  vault: Vault,
  destination: string,
) {
  const dir = await mkdtemp(
    join(dirname(destination), ".bittrees-ai-content-backup-"),
  );
  await chmod(dir, 0o700);
  try {
    const before = [tasks.changeToken(), memory.changeToken()];
    const taskFile = join(dir, "tasks.enc"),
      memoryFile = join(dir, "memory.enc");
    await encryptedBackup(tasks, vault, taskFile);
    await encryptedMemoryBackup(memory, vault, memoryFile);
    const taskBytes = await readFile(taskFile),
      memoryBytes = await readFile(memoryFile);
    if (
      taskBytes.length > maxSnapshotBytes ||
      memoryBytes.length > maxSnapshotBytes
    )
      throw Error("Backup exceeds pilot size limit");
    if (before[0] !== tasks.changeToken() || before[1] !== memory.changeToken())
      throw new StoreError("CONFLICT");
    const createdAt = new Date().toISOString();
    const bytes = vault.seal(
      {
        version: 1,
        kind: "task-and-memory",
        createdAt,
        tasks: taskBytes.toString("base64"),
        memory: memoryBytes.toString("base64"),
      },
      purpose,
    );
    if (bytes.length > maxBundleBytes)
      throw Error("Backup exceeds pilot size limit");
    const staged = join(dir, "content.aib");
    await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
    const handle = await open(staged, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Publish one complete authenticated pair, never a partial destination or overwrite.
    await link(staged, destination);
    return { createdAt, bytes: bytes.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function restoreContentBackup(
  source: string,
  vault: Vault,
  parentDirectory: string,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of createReadStream(source)) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > maxBundleBytes) throw Error("Backup exceeds pilot size limit");
    chunks.push(chunk);
  }
  const bundle = vault.open<{
    version: number;
    kind: string;
    createdAt: string;
    tasks: string;
    memory: string;
  }>(Buffer.concat(chunks), purpose);
  if (
    bundle.version !== 1 ||
    bundle.kind !== "task-and-memory" ||
    typeof bundle.createdAt !== "string" ||
    !Number.isFinite(Date.parse(bundle.createdAt)) ||
    typeof bundle.tasks !== "string" ||
    typeof bundle.memory !== "string"
  )
    throw Error("Unsupported content backup");
  const tasks = Buffer.from(bundle.tasks, "base64"),
    memory = Buffer.from(bundle.memory, "base64");
  if (tasks.length > maxSnapshotBytes || memory.length > maxSnapshotBytes)
    throw Error("Backup exceeds pilot size limit");
  // Always allocate a new private directory. Never restore over running application data.
  const dir = await mkdtemp(join(parentDirectory, "bittrees-ai-recovered-"));
  await chmod(dir, 0o700);
  let complete = false;
  try {
    const taskFile = join(dir, ".tasks.enc"),
      memoryFile = join(dir, ".memory.enc");
    await writeFile(taskFile, tasks, { mode: 0o600, flag: "wx" });
    await writeFile(memoryFile, memory, { mode: 0o600, flag: "wx" });
    await restoreBackup(taskFile, vault, join(dir, "tasks.db"));
    await restoreMemoryBackup(memoryFile, vault, join(dir, "memory.db"));
    await rm(taskFile);
    await rm(memoryFile);
    await writeFile(
      join(dir, "RECOVERY.json"),
      JSON.stringify(
        {
          version: 1,
          sourceCreatedAt: bundle.createdAt,
          stores: ["tasks.db", "memory.db"],
          remoteConsentRestored: false,
          requiresCurrentSourceAuthorization: true,
          excludes: [
            "storage key",
            "connector credentials",
            "model files",
            "model import jobs",
          ],
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    complete = true;
    return dir;
  } finally {
    if (!complete) await rm(dir, { recursive: true, force: true });
  }
}
