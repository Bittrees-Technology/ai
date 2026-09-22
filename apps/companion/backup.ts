import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentBackup } from "../../modules/storage/content-backup.js";
import { Store, StoreError } from "../../modules/storage/store.js";
import { MemoryStore } from "../../modules/memory/store.js";
import { Vault } from "../../modules/storage/vault.js";
export function localBackupDownload(
  store: Store,
  memory: MemoryStore,
  vault: Vault,
) {
  let busy = false;
  return async () => {
    if (busy) throw new StoreError("CONFLICT");
    busy = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "bittrees-ai-download-"));
      await chmod(directory, 0o700);
      const file = join(directory, "content.aib");
      await createContentBackup(store, memory, vault, file);
      return await readFile(file);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        busy = false;
      }
    }
  };
}
