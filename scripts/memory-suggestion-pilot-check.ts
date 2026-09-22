import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Ollama } from "../modules/models/ollama.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
import { localApi } from "../apps/companion/http.js";
import { MemorySuggestionController } from "../apps/dashboard/memory-suggestion-state.js";
// Synthetic, isolated Mac-only probe. No installed app data, credential store or defaults.
if (process.platform !== "darwin") throw Error("Run this pilot on the Mac.");
const owner = { userId: "synthetic-pilot", tenantId: "synthetic" };
const vault = new Vault(randomBytes(32));
const store = new Store(":memory:", vault);
const memory = new MemoryStore(":memory:", vault, localMemoryAccess(store));
const runtime = new Ollama("http://127.0.0.1:11434", 180000);
const profile = store.addProfile(owner, {
  id: "pilot-original-9b",
  runtime: "ollama",
  model: "qwen3.5:9b",
  contextTokens: 8192,
  maxOutputTokens: 2048,
  temperature: 0,
});
const source = {
  requestText:
    "I prefer short summaries with source links. Remember that preference when preparing future summaries.",
  resultText:
    "Understood. I will keep summaries short and include source links.",
};
const task = store.create(
  owner,
  {
    conversationId: "pilot-parent",
    kind: "query",
    prompt: source.requestText,
    modelProfileId: profile.id,
  },
  "pilot-parent",
);
const claim = store.claim(owner, "fixture")!;
const parent = store.complete(owner, task.id, "fixture", claim.generation, {
  text: source.resultText,
});
const server = createServer(),
  token = randomBytes(32).toString("hex");
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
server.on("request", localApi({ store, memory, owner, port, token }));
const api = async (path: string, method: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}` + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
};
let raw = "";
const started = performance.now();
try {
  const controller = new MemorySuggestionController(
    api,
    parent.id,
    parent.revision,
  );
  controller.prepare(profile.id);
  await controller.request();
  const worker = new LocalWorker(
    store,
    owner,
    {
      pin: (p, signal) => runtime.pin(p, signal),
      generate: async (p, prompt, signal) => {
        raw = await runtime.generate(p, prompt, signal);
        return raw;
      },
    },
    (id) => store.profile(owner, id),
  );
  await worker.runOnce();
  const extraction = store.get(owner, controller.queuedId);
  const elapsedMs = Math.round(performance.now() - started);
  const evidence: Record<string, unknown> = {
    format: 1,
    checkedAt: new Date().toISOString(),
    fixture: "explicit-preference",
    scope:
      "Synthetic original-9B Mac loopback controller/API/queue/worker/memory smoke; not native UI or model-quality acceptance",
    source,
    prompt: extraction.input.prompt,
    raw,
    elapsedMs,
    status: extraction.status,
    runs: store.runHistory(owner, extraction.id),
    result: extraction.result,
  };
  if (extraction.status === "completed") {
    const review = new MemorySuggestionController(
      api,
      extraction.id,
      extraction.revision,
    );
    await review.load();
    evidence.review = review.review;
    assert.equal((await memory.export(owner)).length, 0);
    if (review.review!.candidates.length) {
      // Exercise selection mechanically; this is not a human endorsement of its content.
      await review.save(0);
      await review.load();
      await review.save(0);
      const saved = await memory.export(owner);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.origin, "model");
      assert.equal(saved[0]!.state, "candidate");
      assert.equal((await memory.search(owner, "summaries")).length, 0);
      evidence.savedCandidate = saved[0];
      evidence.repeatSaveCount = saved.length;
      evidence.unapprovedSearchCount = 0;
      await api(`/v1/memories/${saved[0]!.id}`, "DELETE");
      assert.equal((await memory.export(owner)).length, 0);
      evidence.deletionVerified = true;
    }
  }
  mkdirSync("docs/evidence/memory-candidates", { recursive: true });
  writeFileSync(
    "docs/evidence/memory-candidates/mac-original-9b-queued-pilot.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: extraction.status,
      elapsedMs,
      candidateCount: (evidence.review as any)?.candidates.length ?? 0,
    }),
  );
  assert.equal(
    extraction.status,
    "completed",
    "Read the recorded failed pilot evidence.",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  memory.close();
  store.close();
}
