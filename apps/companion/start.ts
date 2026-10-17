import { CryptoDirectoryResearch } from "../../modules/research/crypto-directory.js";
import { researchWorkflowProgress } from "../../modules/research/workflow-progress.js";
import { QualificationResearch } from "../../modules/research/qualification.js";
import { LocalModelTurns } from "../../modules/models/local-turns.js";
import { ProjectWork } from "../../modules/research/project-work.js";
import { InvestorResearch } from "../../modules/research/investors.js";
import {
  CrmDatasetConnector,
  datasetKeychainEntry,
} from "../../modules/connectors/crm-dataset.js";
import { localWorkflows } from "./workflows.js";
import {
  AutoNoteApprovalConnector,
  autonoteApprovalKeychainEntry,
} from "../../modules/connectors/autonote-approval.js";
import { resumeTaskAccess } from "./resume-access.js";
import { conversationTaskAccess } from "./conversation-access.js";
import { CompanionPrivateRelay } from "./private-relay.js";
import { macPrivateRelayEntries } from "./private-relay-entry.js";
import {
  MailSendConnector,
  mailSendKeychainEntry,
} from "../../modules/connectors/mail-send.js";
import {
  NewsConnector,
  newsKeychainEntry,
} from "../../modules/connectors/news.js";
import { ExecutionControls } from "./execution-limits.js";
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
import { sourceMemoryAccess } from "./source-memory.js";
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
const executionControls = new ExecutionControls(
  join(directory, "execution-limits.json"),
);
const importDirectory = join(directory, "model-imports");
await mkdir(importDirectory, { recursive: true, mode: 0o700 });
const imports = new ImportJobs(importDirectory, new Vault(key), pickModelFiles);
await imports.maintain();
const dataset = new CrmDatasetConnector(
  JSON.stringify(owner),
  datasetKeychainEntry("personal"),
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
  autonoteApproval = new AutoNoteApprovalConnector(
    JSON.stringify(owner),
    autonoteApprovalKeychainEntry("personal"),
    autonote,
  ),
  autonoteSources = new AutoNoteTasks(autonote, owner, "personal"),
  mail = new MailConnector(
    JSON.stringify(owner),
    mailKeychainEntry("personal"),
  ),
  mailSend = new MailSendConnector(
    JSON.stringify(owner),
    mailSendKeychainEntry("personal"),
    store.mailSends.forOwner(owner),
  ),
  mailSources = new MailTasks(mail, owner, "personal"),
  news = new NewsConnector(
    JSON.stringify(owner),
    newsKeychainEntry("personal"),
    fetch,
    Date.now,
    store.newsPublications.forOwner(owner),
  ),
  runtime = new Ollama(),
  memory: MemoryStore = new MemoryStore(
    join(content.directory, "memory.db"),
    new Vault(key),
    sourceMemoryAccess(
      store,
      new SourceTasks(sources, autonoteSources, mailSources),
      () => memory,
    ),
  ),
  worker = new LocalWorker(
    store,
    owner,
    new Ollama("http://127.0.0.1:11434", 1800_000),
    (id) => store.profile(owner, id),
    "personal",
    memory,
    new SourceTasks(sources, autonoteSources, mailSources),
    executionControls,
    undefined,
    async (taskId, model, action) => {
      if (privateKeys)
        return privateKeys.withResumeExecution(taskId, model, action);
      return action(() => {
        throw new Error("Private resume authority unavailable");
      });
    },
  );
const modelTurns = new LocalModelTurns();
const investorResearch = new InvestorResearch(
  join(content.directory, "investor-research.db"),
  new Vault(key),
  dataset,
  new Ollama("http://127.0.0.1:11434", 1800_000),
  (id) => store.profile(owner, id),
  () => {
    const a = executionControls.admission(worker.activeTasks);
    return {
      reason: a.reason,
      seconds: a.limits.maxTaskSeconds,
    };
  },
  undefined,
  modelTurns.run,
);
const projectWork = new ProjectWork(
  join(content.directory, "project-work.db"),
  new Vault(key),
  dataset,
  new Ollama("http://127.0.0.1:11434", 1800_000),
  (id) => store.profile(owner, id),
  () => {
    const a = executionControls.admission(worker.activeTasks);
    return {
      reason: a.reason,
      seconds: a.limits.maxTaskSeconds,
    };
  },
  modelTurns.run,
);
const qualificationResearch = new QualificationResearch(
  join(content.directory, "qualification-research.db"),
  new Vault(key),
  dataset,
  new Ollama("http://127.0.0.1:11434", 1800_000),
  (id) => store.profile(owner, id),
  () => {
    const a = executionControls.admission(worker.activeTasks);
    return { reason: a.reason, seconds: a.limits.maxTaskSeconds };
  },
  undefined,
  modelTurns.run,
);
const directoryResearch = new CryptoDirectoryResearch(
  join(content.directory, "crypto-directory.db"),
  new Vault(key),
  new Ollama("http://127.0.0.1:11434", 1800_000),
  (id) => store.profile(owner, id),
  () => {
    const a = executionControls.admission(worker.activeTasks);
    return { reason: a.reason, seconds: a.limits.maxTaskSeconds };
  },
  modelTurns.run,
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
        Date.now,
        process.env.BITTREES_PRIVATE_TASKS === "1",
        {
          enabled: process.env.BITTREES_PRIVATE_CONVERSATIONS === "1",
          taskAccess: conversationTaskAccess(
            store,
            owner,
            new SourceTasks(sources, autonoteSources, mailSources),
            memory,
          ),
        },
        {
          enabled: process.env.BITTREES_PRIVATE_RESUME === "1",
          runtime,
          taskAccess: resumeTaskAccess(
            store,
            owner,
            new SourceTasks(sources, autonoteSources, mailSources),
            runtime,
            memory,
          ),
        },
        {
          enabled: process.env.BITTREES_PRIVATE_AUTONOTE_APPROVAL === "1",
          approval: autonoteApproval,
          sources: autonoteSources,
          source: autonote,
        },
      )
    : undefined;
const privateRelay =
  process.platform === "darwin" && (await exists(privateKeyHelper))
    ? new CompanionPrivateRelay(
        store,
        new Vault(key),
        owner,
        macPrivateRelayEntries(privateKeyHelper, "personal"),
        remote,
        process.env.BITTREES_PRIVATE_RELAY === "1",
      )
    : undefined;
const templateReceiver = remote
  ? new RemoteTemplateReceiver(remote)
  : undefined;
const token = randomBytes(32).toString("hex"),
  pairCode = randomBytes(12).toString("hex");
const codePath = join(directory, "pairing-code.txt");
const workflows = localWorkflows(
  directory,
  new Vault(key),
  () => store.profiles(owner).map((p) => p.model),
  async () => [
    ...store.templates(owner),
    ...directoryResearch.entries(),
    ...projectWork.status().map((job) => ({
      id: job.id,
      revision: Math.max(1, Date.parse(job.updatedAt)),
      definition: {
        kind: job.input.mode === "plan" ? "crm-task-planning" : "crm-task-work",
      },
      state: job.state === "waiting" ? "ready" : job.state,
    })),
    ...qualificationResearch.status().map((job) => ({
      id: job.id,
      revision: Math.max(1, Date.parse(job.updatedAt)),
      definition: { kind: "investor-qualification" },
      state: job.state,
    })),
    ...(await investorResearch.workflowEntries()).map((job) => ({
      progress: researchWorkflowProgress(job),
      id: job.id,
      revision: Math.max(1, Date.parse(job.updatedAt)),
      definition: { kind: "investor-research" },
      state: job.state,
    })),
  ],
);
server.on(
  "request",
  dashboardServer({
    privateKeys,
    privateRelay,
    retainedCopies: retainedContent(directory, content.directory),
    backupDownload: localBackupDownload(store, memory, new Vault(key)),
    workflows,
    deviceStatus: () =>
      deviceStatus(directory, executionControls.admission(worker.activeTasks)),
    executionControls,
    activeTasks: () => worker.activeTasks,
    imports,
    remote,
    receiver,
    templateReceiver,
    store,
    memory,
    owner,
    crm,
    dataset,
    investorResearch,
    directoryResearch,
    qualificationResearch,
    projectWork,
    sources,
    autonote,
    autonoteApproval,
    roles,
    news,
    mail,
    mailSend,
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
  clearInterval(automaticProjectWork);
  clearInterval(importMaintenance);
  clearInterval(workflowSync);
  clearInterval(directoryTimer);
  await directoryResearch.close();
  worker.stop();
  await investorResearch.close();
  await qualificationResearch.close();
  await projectWork.close();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await Promise.all([receiver?.shutdown(), templateReceiver?.shutdown()]);
  await imports.shutdown();
  await Promise.all([...runs]);
  await closed;
  imports.close();
  memory.close();
  store.close();
  await pairingWrite?.catch(() => {});
  await rm(codePath, { force: true });
}
const runs = new Set<Promise<unknown>>();
const timer = setInterval(() => {
  if (
    started &&
    !stopping &&
    !investorResearch.isRunning &&
    !qualificationResearch.isRunning &&
    !projectWork.isRunning &&
    !directoryResearch.isRunning
  ) {
    const running = worker
      .runOnce()
      .catch(() => {
        console.error("Local work paused after an internal error.");
        return false;
      })
      .finally(() => {
        runs.delete(running);
      });
    runs.add(running);
  }
}, 500);
let automaticErrorReported = false;
const automaticProjectWork = setInterval(() => {
  if (started && !stopping)
    void projectWork
      .tickAutomatic()
      .then(() => {
        automaticErrorReported = false;
      })
      .catch(() => {
        if (!automaticErrorReported)
          console.error("Automatic CRM task check could not start.");
        automaticErrorReported = true;
      });
}, 10000);
const importMaintenance = setInterval(() => {
  if (started && !stopping)
    void imports.maintain().catch(() => {
      console.error(
        "Temporary model files could not be cleaned up. Import history is retained.",
      );
    });
}, 60000);
const directoryTimer = setInterval(() => {
  if (started && !stopping)
    void directoryResearch
      .tick()
      .catch(() => console.error("Directory workflow check failed"));
}, 30000);
const workflowSync = setInterval(() => {
  if (started && !stopping) void workflows.sync().catch(() => {});
}, 60000);
const requestShutdown = bindProcessLifetime(stop);
{
  pairingWrite = writeFile(codePath, pairCode + "\n", { mode: 0o600 });
  await pairingWrite;
  // A parent exit or signal during the write must not announce a stopped server.
  if (!stopping) {
    started = true;
    void workflows.sync().catch(() => {});
    receiver?.start();
    templateReceiver?.start();
    console.log(
      `Bittrees AI: http://127.0.0.1:${port}\nPairing code (valid for 10 minutes): ${codePath}\nStop with Ctrl+C. Restart to pair another browser session.`,
    );
  }
}
