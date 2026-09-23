import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySuggestionController } from "../apps/dashboard/memory-suggestion-state.js";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
import { LocalWorker } from "../apps/companion/worker.js";

test("review controller requires explicit preparation, retries fixed intent and hides late responses", async () => {
  const calls: any[] = [];
  let fail = true;
  let resolve!: (value: any) => void;
  const c = new MemorySuggestionController(
    async (path, method, body) => {
      calls.push({ path, method, body });
      if (fail) throw Error("UNAVAILABLE");
      return new Promise((r) => {
        resolve = r;
      });
    },
    "parent",
    4,
    () => {},
    () => "00000000-0000-4000-8000-000000000001",
  );
  await c.request();
  assert.equal(calls.length, 0);
  c.prepare("profile");
  await assert.rejects(c.request(), /UNAVAILABLE/);
  fail = false;
  const retry = c.request();
  assert.deepEqual(calls[0], calls[1]);
  await c.request();
  assert.equal(calls.length, 2);
  c.hide();
  resolve({ id: "late-task" });
  await retry;
  assert.equal(c.queuedId, "");
  assert.equal(c.prepared, false);
  c.prepare("profile");
  const again = c.request();
  resolve({ id: "same-task" });
  await again;
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(c.queuedId, "same-task");
  const loading = c.load();
  c.hide();
  resolve({ candidates: [{ text: "hidden" }] });
  await loading;
  assert.equal(c.review, null);
  await c.save(0);
  assert.equal(calls.length, 4);
});

test("actual authenticated request, worker, review and selected save preserve model provenance and separate approval", async () => {
  const owner = { userId: "review", tenantId: "personal" },
    vault = new Vault(randomBytes(32));
  const store = new Store(":memory:", vault);
  const access = localMemoryAccess(store);
  let changeDuringAccess = false;
  let parentId = "";
  const memory = new MemoryStore(":memory:", vault, async (o, sources) => {
    const allowed = await access(o, sources);
    if (changeDuringAccess) {
      store.db
        .prepare("UPDATE tasks SET revision=revision+1 WHERE id=?")
        .run(parentId);
      changeDuringAccess = false;
    }
    return allowed;
  });
  const profile = store.addProfile(owner, {
    id: "model",
    runtime: "ollama",
    model: "local",
    contextTokens: 8192,
    maxOutputTokens: 2048,
    temperature: 0,
  });
  const quote = "I prefer concise summaries.";
  const parent = store.create(
    owner,
    {
      conversationId: "c",
      kind: "query",
      prompt: quote,
      modelProfileId: profile.id,
    },
    "parent",
  );
  parentId = parent.id;
  const claim = store.claim(owner, "seed")!;
  const completed = store.complete(owner, parent.id, "seed", claim.generation, {
    text: "Noted for the next summary.",
  });
  const server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, memory, owner, port, token }));
  const request = (path: string, method: string, body?: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${port}` + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const api = async (path: string, method: string, body?: unknown) => {
    const response = await request(path, method, body);
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  };
  try {
    const path = `/v1/requests/${parent.id}/memory-suggestions`;
    assert.equal((await request(path, "POST", {}, false)).status, 401);
    assert.equal(
      (
        await request(path, "POST", {
          expectedRevision: completed.revision,
          modelProfileId: profile.id,
          invocationId: randomUUID(),
        })
      ).status,
      400,
    );
    const c = new MemorySuggestionController(
      api,
      parent.id,
      completed.revision,
    );
    c.prepare(profile.id);
    await c.request();
    assert.ok(c.queuedId);
    const pendingExport = await api("/v1/export", "GET");
    assert.equal(pendingExport.memoryExtractions.length, 1);
    assert.equal(pendingExport.memoryExtractions[0].taskId, c.queuedId);
    assert.equal(pendingExport.memoryExtractions[0].parentId, parent.id);
    assert.equal(pendingExport.memoryExtractions[0].runs.length, 0);
    const w = new LocalWorker(
      store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () =>
          JSON.stringify({
            version: 1,
            candidates: [
              {
                type: "preference",
                text: quote,
                evidence: [{ source: "request", quote }],
              },
            ],
          }),
      },
      (id) => store.profile(owner, id),
    );
    await w.runOnce();
    const extraction = store.get(owner, c.queuedId);
    const completedExport = await api("/v1/export", "GET");
    assert.equal(
      completedExport.memoryExtractions[0].runs[0].model.profile.id,
      profile.id,
    );
    assert.equal(
      completedExport.memoryExtractions[0].runs[0].outcome,
      "completed",
    );
    const review = new MemorySuggestionController(
      api,
      extraction.id,
      extraction.revision,
    );
    await review.save(0);
    assert.equal((await memory.export(owner)).length, 0);
    await review.load();
    assert.equal(review.review!.candidates[0]!.evidence[0]!.quote, quote);
    const savePath = `/v1/requests/${extraction.id}/memory-suggestions/save`;
    assert.equal(
      (
        await request(savePath, "POST", {
          expectedRevision: extraction.revision,
          index: 0,
          confirmed: true,
          text: "forged",
          origin: "user",
        })
      ).status,
      400,
    );
    await assert.rejects(
      api(savePath, "POST", { expectedRevision: 1, index: 0, confirmed: true }),
      /CONFLICT/,
    );
    await assert.rejects(
      api(savePath, "POST", {
        expectedRevision: extraction.revision,
        index: 7,
        confirmed: true,
      }),
      /CONFLICT/,
    );
    await review.save(0);
    const saved = (await memory.export(owner))[0]!;
    assert.equal(saved.origin, "model");
    assert.equal(saved.state, "candidate");
    assert.equal(saved.verified, false);
    assert.equal(saved.sources[0]!.resourceId, parent.id);
    assert.equal(saved.sources[0]!.revision, String(completed.revision));
    assert.equal(saved.expiresAt, null);
    assert.equal((await memory.search(owner, "concise")).length, 0);
    await review.load();
    await review.save(0);
    assert.equal((await memory.export(owner)).length, 1);
    await api(`/v1/memories/${saved.id}`, "PATCH", {
      revision: saved.revision,
      approve: true,
    });
    assert.equal((await memory.search(owner, "concise")).length, 1);
    memory.forget(owner, saved.id);
    changeDuringAccess = true;
    await assert.rejects(
      api(savePath, "POST", {
        expectedRevision: extraction.revision,
        index: 0,
        confirmed: true,
      }),
      /NOT_FOUND/,
    );
    await assert.rejects(review.load(), /NOT_FOUND/);
    assert.equal(review.review, null);
    store.db
      .prepare("UPDATE tasks SET revision=? WHERE id=?")
      .run(completed.revision, parent.id);
    assert.equal((await memory.export(owner)).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    memory.close();
    store.close();
  }
});
