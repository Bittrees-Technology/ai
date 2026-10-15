import Database from "better-sqlite3";
import { readFile, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../modules/storage/keychain.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalRunStore } from "../modules/coordinator/local-store.js";
import { MarketplaceCoordinator } from "../modules/coordinator/workflow.js";
import { syncLocalStatus } from "../modules/coordinator/status-sync.js";
process.umask(0o077);
const dir = join(
  homedir(),
  "Library",
  "Application Support",
  "Bittrees AI",
  "marketplace",
);
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, "runs.sqlite");
const key = await loadStorageKey(
  macKeychainEntry("marketplace-coordinator"),
  await stat(file).then(
    () => true,
    () => false,
  ),
);
const vault = new Vault(key);
const settings = vault.open<{
  ownerId: string;
  mcpToken: string;
  syncToken: string;
  expiresAt: number;
}>(await readFile(join(dir, "connection.enc")), "marketplace-connection");
const db = new Database(file);
await chmod(file, 0o600);
try {
  const store = new LocalRunStore(db, vault);
  const coordinator = new MarketplaceCoordinator(store, [
    {
      ownerId: settings.ownerId,
      token: settings.mcpToken,
      expiresAt: settings.expiresAt,
    },
  ]);
  const [command, path] = process.argv.slice(2);
  if (command === "create" && path) {
    const input = JSON.parse(await readFile(path, "utf8"));
    console.log(
      JSON.stringify(await coordinator.create(settings.ownerId, input)),
    );
  } else if (command === "advance") {
    for (const id of store.ids(settings.ownerId)) {
      const run = await coordinator.get(settings.ownerId, id);
      if (run.steps.some((s) => s.state !== "decided"))
        console.log(
          JSON.stringify(await coordinator.advance(settings.ownerId, id)),
        );
    }
  } else if (command !== "sync")
    throw Error("Use create <batch.json>, advance, or sync");
  await syncLocalStatus(store, settings.ownerId, settings.syncToken);
} finally {
  db.close();
  key.fill(0);
}
