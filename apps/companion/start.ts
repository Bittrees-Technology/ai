import { CrmTasks } from "../../modules/connectors/crm-tasks.js";
import {
  CrmConnector,
  crmKeychainEntry,
} from "../../modules/connectors/crm.js";
import { createServer } from "node:http";
import { mkdir, stat, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../../modules/storage/store.js";
import { Vault } from "../../modules/storage/vault.js";
import { MemoryStore } from "../../modules/memory/store.js";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../../modules/storage/keychain.js";
import { Ollama } from "../../modules/models/ollama.js";
import { localMemoryAccess } from "./memory.js";
import { LocalWorker } from "./worker.js";
import { dashboardServer } from "./dashboard-server.js";
const directory = join(
  homedir(),
  "Library",
  "Application Support",
  "Bittrees AI",
);
await stat(resolve("dist/dashboard/index.html"));
const port = 43127,
  server = createServer();
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
} catch {
  console.error(
    "Companion is already running or its local port is unavailable.",
  );
  process.exit(1);
}

await mkdir(directory, { recursive: true, mode: 0o700 });
const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
const key = await loadStorageKey(
  macKeychainEntry("personal"),
  (await exists(join(directory, "tasks.db"))) ||
    (await exists(join(directory, "memory.db"))),
);
const store = new Store(join(directory, "tasks.db"), new Vault(key)),
  owner = { userId: "local-owner", tenantId: "personal" };
const memory = new MemoryStore(
  join(directory, "memory.db"),
  new Vault(key),
  localMemoryAccess(store),
);
const crm = new CrmConnector(
    JSON.stringify(owner),
    crmKeychainEntry("personal"),
  ),
  sources = new CrmTasks(crm, owner, "personal"),
  runtime = new Ollama(),
  worker = new LocalWorker(
    store,
    owner,
    runtime,
    (id) => store.profile(owner, id),
    "personal",
    memory,
    sources,
  );
const token = randomBytes(32).toString("hex"),
  pairCode = randomBytes(12).toString("hex");
const codePath = join(directory, "pairing-code.txt");
server.on(
  "request",
  dashboardServer({
    store,
    memory,
    owner,
    crm,
    sources,
    runtime,
    port,
    token,
    pairCode,
    assets: resolve("dist/dashboard"),
    cancelRun: (id) => worker.cancel(id),
    cancelSourceRun: () => worker.cancelSource(),
  }),
);
let stopping = false,
  started = false,
  running: Promise<boolean> | undefined;
server.on("error", () => {
  console.error(
    "Companion could not start. Check whether another copy is already running.",
  );
  process.exitCode = 1;
  void stop();
});
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  worker.stop();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await running?.catch(() => {});
  await closed;
  memory.close();
  store.close();
  if (started) await rm(codePath, { force: true });
}
const timer = setInterval(() => {
  if (started && !stopping && !running) {
    running = worker
      .runOnce()
      .catch(() => {
        console.error("Local work paused after an internal error.");
        return false;
      })
      .finally(() => {
        running = undefined;
      });
  }
}, 500);
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
{
  started = true;
  await writeFile(codePath, pairCode + "\n", { mode: 0o600 });
  console.log(
    `Bittrees AI: http://127.0.0.1:${port}\nPairing code (valid for 10 minutes): ${codePath}\nStop with Ctrl+C. Restart to pair another browser session.`,
  );
}
