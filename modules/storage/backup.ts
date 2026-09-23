import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  rm,
  stat,
  lstat,
  link,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Vault } from "./vault.js";
import { Store } from "./store.js";
import Database from "better-sqlite3";
import { MemoryStore } from "../memory/store.js";
// Pilot bound keeps whole-file authenticated encryption out of unbounded memory use.
const maxBytes = 32 * 1024 * 1024;
async function writeSnapshot(
  store: Pick<Store, "backup">,
  vault: Vault,
  destination: string,
  kind: "tasks" | "memory",
) {
  const dir = await mkdtemp(join(tmpdir(), "bittrees-ai-backup-"));
  await chmod(dir, 0o700);
  try {
    const file = join(dir, "snapshot.db");
    await store.backup(file);
    if ((await stat(file)).size > maxBytes)
      throw new Error("Backup exceeds pilot size limit");
    const envelope = vault.seal(
      {
        version: kind === "tasks" ? 1 : 2,
        ...(kind === "memory" ? { kind } : {}),
        sqlite: (await readFile(file)).toString("base64"),
      },
      "backup:v1",
    );
    await writeFile(destination, envelope, { mode: 0o600, flag: "wx" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function encryptedBackup(
  store: Pick<Store, "backup">,
  vault: Vault,
  destination: string,
) {
  return writeSnapshot(store, vault, destination, "tasks");
}
export async function encryptedMemoryBackup(
  store: Pick<MemoryStore, "backup">,
  vault: Vault,
  destination: string,
) {
  return writeSnapshot(store, vault, destination, "memory");
}
export async function restoreBackup(
  source: string,
  vault: Vault,
  destination: string,
) {
  return restoreSnapshot(source, vault, destination, "tasks");
}
export async function restoreMemoryBackup(
  source: string,
  vault: Vault,
  destination: string,
) {
  return restoreSnapshot(source, vault, destination, "memory");
}
async function restoreSnapshot(
  source: string,
  vault: Vault,
  destination: string,
  kind: "tasks" | "memory",
) {
  if ((await stat(source)).size > maxBytes * 1.5)
    throw new Error("Backup exceeds pilot size limit");
  const envelope = vault.open<{
    version: number;
    kind?: string;
    sqlite: string;
  }>(await readFile(source), "backup:v1");
  if (
    (kind === "tasks"
      ? envelope.version !== 1 || envelope.kind !== undefined
      : envelope.version !== 2 || envelope.kind !== "memory") ||
    typeof envelope.sqlite !== "string"
  )
    throw new Error("Unsupported backup");
  const bytes = Buffer.from(envelope.sqlite, "base64");
  if (
    bytes.length > maxBytes ||
    bytes.subarray(0, 16).toString() !== "SQLite format 3\0"
  )
    throw new Error("Invalid backup");
  // Restore offline into a new path. SQLite sidecars must not belong to an
  // earlier database at that path. lstat also rejects dangling symlinks.
  for (const path of [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
    `${destination}-journal`,
  ]) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("EEXIST: restore destination or SQLite sidecar exists");
  }
  // A sibling staging directory keeps publication on the same filesystem.
  // Task control consent is removed before publication, even if preparation stops.
  const dir = await mkdtemp(
    join(dirname(destination), ".bittrees-ai-restore-"),
  );
  let restored: Store | MemoryStore | undefined;
  try {
    await chmod(dir, 0o700);
    const staged = join(dir, "snapshot.db");
    await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
    const inspection = new Database(staged, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const has = (table: string) =>
        !!inspection
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
      if (
        kind === "memory"
          ? !has("memory_meta") || !has("memory") || has("tasks")
          : !has("tasks") || has("memory_meta")
      )
        throw new Error("Backup store kind mismatch");
    } finally {
      inspection.close();
    }
    if (kind === "tasks") {
      const tasks = new Store(staged, vault);
      restored = tasks;
      tasks.db.prepare("DELETE FROM remote_control_bindings").run();
      tasks.db
        .prepare("UPDATE private_peer_checks SET locked=1,revision=revision+1")
        .run();
      tasks.db
        .prepare(
          "UPDATE private_task_consents SET locked=1,revision=revision+1",
        )
        .run();
      tasks.db
        .prepare(
          "UPDATE private_key_lifecycle SET locked=1,revision=revision+1",
        )
        .run();
      tasks.db
        .prepare(
          "UPDATE private_task_responses SET locked=1,revision=revision+1",
        )
        .run();
      tasks.db
        .prepare("UPDATE private_task_outbox SET locked=1,revision=revision+1")
        .run();
      tasks.db
        .prepare("UPDATE private_peer_states SET locked=1,revision=revision+1")
        .run();
      tasks.db
        .prepare("UPDATE remote_template_permissions SET payload=NULL")
        .run();
      tasks.db.pragma("wal_checkpoint(TRUNCATE)");
    } else {
      // Recovery does not grant source access; the application must supply its
      // current source validator when opening the published memory database.
      restored = new MemoryStore(staged, vault, async () => false);
    }
    restored.close();
    restored = undefined;
    const file = await open(staged, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic no-replace publication: unlike rename, link cannot overwrite a
    // destination created while preparation was underway.
    await link(staged, destination);
  } finally {
    try {
      restored?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
