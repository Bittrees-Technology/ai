import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Never replace an existing database. Restoring app grants is intentionally unsupported.
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  // Restored receipts are history, but restored consent must not enable delivery.
  let restored: Store | undefined;
  try {
    restored = new Store(destination, vault);
    restored.db.prepare("DELETE FROM remote_control_bindings").run();
    restored.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    restored?.close();
    restored = undefined;
    await rm(destination, { force: true });
    throw error;
  } finally {
    restored?.close();
  }
}
