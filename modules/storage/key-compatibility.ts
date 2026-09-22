import Database from "better-sqlite3";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Vault } from "./vault.js";
async function exists(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error("Invalid store");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Read-only ownership check; does not migrate, initialize or claim full data integrity. */
export async function verifyStoredKey(
  content: string,
  imports: string,
  vault: Vault,
) {
  for (const [file, table, purpose, expected] of [
    ["tasks.db", "vault_meta", "vault-verifier", "bittrees-ai"],
    ["memory.db", "memory_meta", "memory-key", "bittrees-ai-memory"],
  ] as const) {
    const path = join(content, file);
    if (!(await exists(path))) continue;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(`SELECT verifier FROM ${table} WHERE id=1`)
        .get() as { verifier: Buffer } | undefined;
      if (!row || vault.open(row.verifier, purpose) !== expected)
        throw Error("Storage key mismatch");
    } finally {
      db.close();
    }
  }
  const path = join(imports, "jobs.db");
  if (!(await exists(path))) return;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    let count = 0;
    for (const raw of db.prepare("SELECT id,payload FROM jobs").iterate()) {
      const row = raw as { id: string; payload: Buffer };
      if (++count > 10000 || row.payload.length > 1024 * 1024)
        throw Error("Import verification bound");
      vault.open(row.payload, "import-job:" + row.id);
    }
  } finally {
    db.close();
  }
}
