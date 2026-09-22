import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySearchController } from "../apps/dashboard/memory-state.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
import { localApi } from "../apps/companion/http.js";
test("memory search clears results on edits and suppresses late results after focus loss", async () => {
  let resolve!: (result: any) => void;
  const calls: any[] = [];
  const c = new MemorySearchController(async (path, method, body) => {
    calls.push({ path, method, body });
    return new Promise((r) => {
      resolve = r;
    });
  });
  c.edit(" ");
  await c.search();
  assert.equal(calls.length, 0);
  c.edit("x".repeat(513));
  await c.search();
  assert.equal(calls.length, 0);
  c.edit(" source citations ");
  const first = c.search();
  assert.deepEqual(calls[0], {
    path: "/v1/memories/search",
    method: "POST",
    body: { query: "source citations" },
  });
  c.edit("new words");
  resolve({ items: [{ text: "old private memory" }] });
  await first;
  assert.deepEqual(c.results, []);
  assert.equal(c.searched, false);
  const next = c.search();
  c.hide();
  resolve({ items: [{ text: "hidden private memory" }] });
  await next;
  assert.equal(c.query, "");
  assert.deepEqual(c.results, []);
  assert.equal(c.busy, false);
});
test("memory search hides delayed failures and never retries or writes automatically", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const c = new MemorySearchController(async () => {
    calls++;
    return new Promise((_r, fail) => {
      reject = fail;
    });
  });
  c.edit("citations");
  const work = c.search();
  await c.search();
  assert.equal(calls, 1);
  c.hide();
  reject(Error("UNAVAILABLE"));
  await work;
  assert.equal(c.busy, false);
  assert.equal(calls, 1);
  c.edit("citations");
  const failure = c.search();
  reject(Error("UNAVAILABLE"));
  await assert.rejects(failure, /UNAVAILABLE/);
  assert.deepEqual(c.results, []);
  assert.equal(calls, 2);
});
test("actual memory panel transport preserves types, review, source versions and access-gated explanations", async () => {
  const owner = { userId: "memory-panel", tenantId: "personal" },
    vault = new Vault(randomBytes(32));
  const store = new Store(":memory:", vault),
    memory = new MemoryStore(":memory:", vault, localMemoryAccess(store));
  const task = store.create(
    owner,
    {
      conversationId: "c",
      kind: "query",
      prompt: "Synthetic",
      modelProfileId: "p",
    },
    "memory-panel-task",
  );
  const claim = store.claim(owner, "worker")!;
  const completed = store.complete(owner, task.id, "worker", claim.generation, {
    text: "Synthetic result",
  });
  const server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, memory, owner, port, token }));
  const api = async (path: string, method: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}` + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  try {
    for (const type of [
      "preference",
      "fact",
      "decision",
      "outcome",
      "procedure",
    ]) {
      const added = await api(`/v1/requests/${task.id}/memories`, "POST", {
        type,
        text: `Citations ${type}`,
      });
      if (type !== "fact")
        await api(`/v1/memories/${added.id}`, "PATCH", {
          revision: 1,
          approve: true,
        });
    }
    const c = new MemorySearchController(api);
    c.edit("citations");
    await c.search();
    assert.equal(c.results.length, 4);
    assert.deepEqual(
      new Set(c.results.map((r) => r.type)),
      new Set(["preference", "decision", "outcome", "procedure"]),
    );
    for (const result of c.results) {
      assert.equal(result.verified, false);
      assert.equal(result.why.reviewed, true);
      assert.equal(result.why.provenance, "user");
      assert.equal(result.sources[0]!.revision, String(completed.revision));
    }
    const usefulness = c.results.map((r) => r.why.usefulness);
    await c.search();
    assert.deepEqual(
      c.results.map((r) => r.why.usefulness),
      usefulness,
    );
    store.deleteAll(owner);
    await c.search();
    assert.deepEqual(c.results, []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    memory.close();
    store.close();
  }
});
