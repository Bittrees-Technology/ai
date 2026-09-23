import { retainedContent } from "./retained-content.js";
import { CompanionPrivateKeys } from "./private-keys.js";
import { macPrivateKeyEntries } from "./private-key-entry.js";
import { endpointKeyOwner } from "../../modules/remote/private-key-lifecycle.js";
import { resolveActiveContent } from "./active-content.js";
import { localBackupDownload } from "./backup.js";
import { RemoteTemplateReceiver } from "../../modules/remote/template-receiver.js";
import { RemoteReceiver } from "../../modules/remote/receiver.js";
import {
  RemoteClient,
  remoteKeychainEntry,
} from "../../modules/remote/client.js";
import { bindProcessLifetime } from "./lifetime.js";
import {
  MailConnector,
  mailKeychainEntry,
} from "../../modules/connectors/mail.js";
import { MailTasks } from "../../modules/connectors/mail-tasks.js";
import {
  RolesConnector,
  rolesKeychainEntry,
} from "../../modules/connectors/roles.js";
import {
  AutoNoteConnector,
  autonoteKeychainEntry,
} from "../../modules/connectors/autonote.js";
import { AutoNoteTasks } from "../../modules/connectors/autonote-tasks.js";
import { SourceTasks } from "../../modules/connectors/source-tasks.js";
import { ImportJobs } from "../../modules/models/jobs.js";
import { pickModelFiles } from "./model-picker.js";
import { deviceStatus } from "./device.js";
import { CrmTasks } from "../../modules/connectors/crm-tasks.js";
import {
  CrmConnector,
  crmKeychainEntry,
} from "../../modules/connectors/crm.js";
import { createServer } from "node:http";
import { mkdir, stat, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const content = await resolveActiveContent(directory);
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
  (await exists(join(content.directory, "tasks.db"))) ||
    (await exists(join(content.directory, "memory.db"))) ||
    (await exists(join(directory, "model-imports", "jobs.db"))),
);
const store = new Store(join(content.directory, "tasks.db"), new Vault(key)),
  owner = { userId: "local-owner", tenantId: "personal" };
const importDirectory = join(directory, "model-imports");
await mkdir(importDirectory, { recursive: true, mode: 0o700 });
const imports = new ImportJobs(importDirectory, new Vault(key), pickModelFiles);
const memory = new MemoryStore(
  join(content.directory, "memory.db"),
  new Vault(key),
  localMemoryAccess(store),
);
const crm = new CrmConnector(
    JSON.stringify(owner),
    crmKeychainEntry("personal"),
  ),
  sources = new CrmTasks(crm, owner, "personal"),
  roles = new RolesConnector(
    JSON.stringify(owner),
    rolesKeychainEntry("personal"),
  ),
  autonote = new AutoNoteConnector(
    JSON.stringify(owner),
    autonoteKeychainEntry("personal"),
  ),
  autonoteSources = new AutoNoteTasks(autonote, owner, "personal"),
  mail = new MailConnector(
    JSON.stringify(owner),
    mailKeychainEntry("personal"),
  ),
  mailSources = new MailTasks(mail, owner, "personal"),
  runtime = new Ollama(),
  worker = new LocalWorker(
    store,
    owner,
    runtime,
    (id) => store.profile(owner, id),
    "personal",
    memory,
    new SourceTasks(sources, autonoteSources, mailSources),
  );
const remote =
  process.env.BITTREES_REMOTE_STATUS === "1"
    ? new RemoteClient(
        JSON.stringify(owner),
        remoteKeychainEntry("personal"),
        fetch,
        Date.now,
        {
          allow: (binding) => store.allowRemoteControls(owner, binding),
          allowed: (identity) => store.remoteControlsAllowed(owner, identity),
          revoke: (deviceId) => store.revokeRemoteControls(owner, deviceId),
          execute: (identity, command) =>
            store.executeRemoteControl(owner, identity, command),
          interrupt: (id) => worker.cancel(id),
        },
        {
          approve: (raw) => store.remoteTemplates.approve(owner, raw),
          allowed: (raw) => store.remoteTemplates.allowed(owner, raw),
          revoke: (deviceId, templateId) => {
            for (const id of store.remoteTemplates.revoke(
              owner,
              deviceId,
              templateId,
            ))
              worker.cancel(id);
          },
          execute: (identity, command) =>
            store.remoteTemplates.execute(owner, identity, command),
        },
      )
    : undefined;
const receiver = remote ? new RemoteReceiver(remote) : undefined;
// Only the packaged sibling helper can access its own native key items. Merely
// constructing controls performs no native read/write or network request.
const privateKeyHelper = join(dirname(process.execPath), "PrivateKeyInstall");
const privateKeys =
  process.platform === "darwin" && (await exists(privateKeyHelper))
    ? new CompanionPrivateKeys(
        store,
        new Vault(key),
        owner,
        (id) =>
          macPrivateKeyEntries(
            privateKeyHelper,
            "personal",
            endpointKeyOwner(owner),
            id,
          ),
        remote,
        process.env.BITTREES_PRIVATE_KEYS === "1",
      )
    : undefined;
const templateReceiver = remote
  ? new RemoteTemplateReceiver(remote)
  : undefined;
const token = randomBytes(32).toString("hex"),
  pairCode = randomBytes(12).toString("hex");
const codePath = join(directory, "pairing-code.txt");
server.on(
  "request",
  dashboardServer({
    privateKeys,
    retainedCopies: retainedContent(directory, content.directory),
    backupDownload: localBackupDownload(store, memory, new Vault(key)),
    deviceStatus: () => deviceStatus(directory),
    imports,
    remote,
    receiver,
    templateReceiver,
    store,
    memory,
    owner,
    crm,
    sources,
    autonote,
    roles,
    mail,
    mailSources,
    autonoteSources,
    runtime,
    port,
    token,
    pairCode,
    assets: resolve("dist/dashboard"),
    cancelRun: (id) => worker.cancel(id),
    cancelSourceRun: (app) => worker.cancelSource(app),
  }),
);
let stopping = false,
  started = false,
  running: Promise<boolean> | undefined,
  pairingWrite: Promise<void> | undefined;
server.on("error", () => {
  console.error(
    "Companion could not start. Check whether another copy is already running.",
  );
  process.exitCode = 1;
  requestShutdown();
});
async function stop() {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  clearInterval(timer);
  worker.stop();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await Promise.all([receiver?.shutdown(), templateReceiver?.shutdown()]);
  await imports.shutdown();
  await running?.catch(() => {});
  await closed;
  imports.close();
  memory.close();
  store.close();
  await pairingWrite?.catch(() => {});
  await rm(codePath, { force: true });
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
const requestShutdown = bindProcessLifetime(stop);
{
  pairingWrite = writeFile(codePath, pairCode + "\n", { mode: 0o600 });
  await pairingWrite;
  // A parent exit or signal during the write must not announce a stopped server.
  if (!stopping) {
    started = true;
    receiver?.start();
    templateReceiver?.start();
    console.log(
      `Bittrees AI: http://127.0.0.1:${port}\nPairing code (valid for 10 minutes): ${codePath}\nStop with Ctrl+C. Restart to pair another browser session.`,
    );
  }
}
