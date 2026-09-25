import { LocalWorker } from "../apps/companion/worker.js";
import { Ollama } from "../modules/models/ollama.js";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { privateEndpoints } from "../tests/helpers/private-endpoints.js";
import { CompanionPrivateKeys } from "../apps/companion/private-keys.js";
import { localApi } from "../apps/companion/http.js";
import { resumeTaskAccess } from "../apps/companion/resume-access.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const profile = {
  id: "synthetic-resume-model",
  runtime: "ollama" as const,
  model: "qwen3.5:9b",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
async function fixture(enabled = true, questions = false) {
  const runtime = new Ollama("http://127.0.0.1:11434", 120000);
  const pinned = await runtime.pin(profile);
  assert.equal(
    pinned.digest,
    "6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7",
  );
  const f = await privateEndpoints(true, false, true),
    e = f.b;
  e.store.addProfile(e.owner, profile);
  let task = e.store.create(
    e.owner,
    {
      conversationId: randomUUID(),
      kind: "query",
      prompt:
        "Synthetic task: The blue crate contains 3 apples and the green crate contains 4 apples. How many apples are there in total? Answer with only the number.",
      modelProfileId: profile.id,
      allowQuestions: questions,
    },
    randomUUID(),
  );
  task = e.store.command(e.owner, task.id, {
    command: "pause",
    expectedRevision: task.revision,
  });
  const controls = new CompanionPrivateKeys(
    e.store,
    e.vault,
    e.owner,
    e.entries,
    e.remote,
    true,
    f.clock,
    true,
    {},
    {
      enabled,
      runtime,
      taskAccess: resumeTaskAccess(
        e.store,
        e.owner,
        new SourceTasks(),
        runtime,
        undefined,
        f.clock,
      ),
    },
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = randomBytes(32).toString("hex");
  server.on(
    "request",
    localApi({
      store: e.store,
      owner: e.owner,
      privateKeys: controls,
      token,
      port,
    }),
  );
  const call = (path = "", body?: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/private-resume${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async (path = "", body?: unknown) => {
    const response = await call(path, body),
      value = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const request = () => {
    const s = controls.resumePermissionStatus();
    return {
      action: "grant",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      expectedPeerRevision: s.peerRevision,
      peerId: f.a.grant.deviceId,
      peerKeyEpoch: 1,
      taskId: task.id,
      taskRevision: task.revision,
      minutes: 15,
    };
  };
  const approve = async () => {
    const r = await ok("/prepare", request());
    return ok("/confirm", {
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
  };
  return {
    ...f,
    e,
    task,
    controls,
    call,
    ok,
    request,
    approve,
    runtime,
    pinned,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r, j) =>
        server.close((error) => (error ? j(error) : r())),
      );
      f.close();
    },
  };
}
async function approvedCommand(f: Awaited<ReturnType<typeof fixture>>) {
  const saved = await f.approve(),
    permissionId = saved.grants[0].id;
  const key = await f.e.remote.withVerifiedDevice(async (scope) =>
    f.e.keys(scope.current).resolve(),
  );
  const sender = await f.a.remote.withVerifiedDevice(async (scope) =>
    f.a.keys(scope.current).resolve(),
  );
  const now = f.clock(),
    cmd = {
      version: 1,
      id: randomUUID(),
      deviceId: f.e.grant.deviceId,
      permissionId,
      taskId: f.task.id,
      expectedRevision: f.task.revision,
      command: "resume",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    };
  const h = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: f.e.grant.ownerId,
    senderId: f.a.grant.deviceId,
    recipientId: f.e.grant.deviceId,
    senderKeyEpoch: sender.proof.keyEpoch,
    recipientKeyEpoch: key.proof.keyEpoch,
    messageId: randomUUID(),
    operationId: cmd.id,
    sequence: 900,
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const envelope = await sealPrivateEnvelope(
    h,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, type: "task.resume", command: cmd }),
    ),
    { senderKey: sender.pair, recipientPublicKey: key.pair.publicKey },
    f.clock,
  );
  const input = { permissionId, envelope, confirmed: true };
  return { permissionId, key, sender, cmd, input };
}

if (process.platform !== "darwin") throw Error("Mac-only; Acer excluded");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (
  execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "scripts/mac-resume-model.ts",
      "tests/helpers/private-endpoints.ts",
      "apps",
      "modules",
    ],
    { encoding: "utf8" },
  ).trim()
)
  throw Error("Commit the fixed check and production sources first");
const startedAt = new Date().toISOString();
const f = await fixture();
try {
  const { input } = await approvedCommand(f);
  const accepted = await f.ok("/receive", input);
  assert.equal(accepted.duplicate, false);
  assert.equal(f.e.store.get(f.e.owner, f.task.id).status, "queued");
  let generations = 0;
  const worker = new LocalWorker(
    f.e.store,
    f.e.owner,
    {
      pin: f.runtime.pin.bind(f.runtime),
      generate: async (...args: Parameters<Ollama["generate"]>) => {
        generations++;
        return f.runtime.generate(...args);
      },
    },
    () => profile,
    "synthetic-resume-model",
    undefined,
    undefined,
    undefined,
    undefined,
    (id, model, action) => f.controls.withResumeExecution(id, model, action),
  );
  assert.equal(await worker.runOnce(), true);
  const completed = f.e.store.get(f.e.owner, f.task.id);
  console.log(
    JSON.stringify({
      event: "model-result",
      sourceHead,
      startedAt,
      finishedAt: new Date().toISOString(),
      pinned: f.pinned,
      status: completed.status,
      result: completed.result,
      generations,
    }),
  );
  assert.equal(completed.status, "completed");
  assert.equal((completed.result as { text: string }).text.trim(), "7");
  assert.equal(generations, 1);
  assert.equal((await f.ok("/receive", input)).duplicate, true);
  await worker.runOnce();
  assert.equal(generations, 1);
  console.log(
    JSON.stringify({
      event: "acceptance",
      status: "passed",
      sourceHead,
      exactDuplicateDidNotRegenerate: true,
      personalDataUsed: false,
      personalKeychainAccessed: false,
      limits:
        "One synthetic arithmetic task through real encrypted local API and LocalWorker with installed Mac Ollama. Synthetic identity/peer and memory key slots; no browser/native shell/live relay or general model quality claim.",
    }),
  );
} finally {
  await f.close();
}
