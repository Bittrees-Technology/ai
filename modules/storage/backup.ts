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
// Pilot bound keeps whole-file authenticated encryption out of unbounded memory use.
const maxBytes = 32 * 1024 * 1024;
export async function encryptedBackup(
  store: Pick<Store, "backup">,
  vault: Vault,
  destination: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "bittrees-ai-backup-"));
  await chmod(dir, 0o700);
  try {
    const file = join(dir, "snapshot.db");
    await store.backup(file);
    if ((await stat(file)).size > maxBytes)
      throw new Error("Backup exceeds pilot size limit");
    const envelope = vault.seal(
      { version: 1, sqlite: (await readFile(file)).toString("base64") },
      "backup:v1",
    );
    await writeFile(destination, envelope, { mode: 0o600, flag: "wx" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function restoreBackup(
  source: string,
  vault: Vault,
  destination: string,
) {
  if ((await stat(source)).size > maxBytes * 1.5)
    throw new Error("Backup exceeds pilot size limit");
  const envelope = vault.open<{ version: number; sqlite: string }>(
    await readFile(source),
    "backup:v1",
  );
  if (envelope.version !== 1 || typeof envelope.sqlite !== "string")
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
  // The destination never contains restored consent, even if preparation stops.
  const dir = await mkdtemp(
    join(dirname(destination), ".bittrees-ai-restore-"),
  );
  let restored: Store | undefined;
  try {
    await chmod(dir, 0o700);
    const staged = join(dir, "snapshot.db");
    await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
    restored = new Store(staged, vault);
    restored.db.prepare("DELETE FROM remote_control_bindings").run();
    restored.db
      .prepare("UPDATE remote_template_permissions SET payload=NULL")
      .run();
    restored.db.pragma("wal_checkpoint(TRUNCATE)");
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
