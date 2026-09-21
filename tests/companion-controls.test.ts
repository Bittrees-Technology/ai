import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "alice", tenantId: "home" };
const profile = {
  id: "p",
  runtime: "ollama" as const,
  model: "local",
  contextTokens: 4096,
  maxOutputTokens: 100,
  temperature: 0,
};
function fixture() {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    localMemoryAccess(store),
  );
  const source = store.create(
    owner,
    {
      conversationId: "source",
      kind: "query",
      prompt: "synthetic",
      modelProfileId: "p",
    },
    "source",
  );
  const claim = store.claim(owner, "fixture")!;
  store.complete(owner, source.id, "fixture", claim.generation, {
    text: "synthetic",
  });
  return {
    store,
    memory,
    source: store.get(owner, source.id),
    close() {
      memory.close();
      store.close();
    },
  };
}
test("authenticated controls create reviewed local memories, switch profiles and export/delete the owner data", async () => {
  const f = fixture(),
    token = randomBytes(32).toString("hex"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const cancelled: string[] = [];
  server.on(
    "request",
    localApi({
      store: f.store,
      memory: f.memory,
      owner,
      token,
      port,
      cancelRun: (id) => cancelled.push(id),
      runtime: {
        listModels: async () => [
          { name: "local", digest: "a".repeat(64), size: 10 },
        ],
        pin: async () => ({ profile, digest: "a".repeat(64) }),
      },
    }),
  );
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await call("/v1/profiles", "POST", profile)).status, 201);
    assert.equal(
      (await call("/v1/profiles/default", "PUT", { profileId: "p" })).status,
      204,
    );
    assert.equal(
      ((await (await call("/v1/profiles")).json()) as any).defaultProfile.id,
      "p",
    );
    assert.equal(
      (
        await call(`/v1/requests/${f.source.id}/memories`, "POST", {
          text: "Use concise summaries",
          type: "preference",
          sources: [],
        })
      ).status,
      400,
    );
    const created = await call(`/v1/requests/${f.source.id}/memories`, "POST", {
      text: "Use concise summaries",
      type: "preference",
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    assert.equal(
      (
        (await (
          await call("/v1/memories/search", "POST", { query: "concise" })
        ).json()) as any
      ).items.length,
      0,
    );
    assert.equal(
      (
        await call("/v1/memories/" + id, "PATCH", {
          revision: 1,
          approve: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/v1/memories/" + id, "PATCH", { revision: 1, pinned: true }))
        .status,
      409,
    );
    assert.equal(
      (
        (await (
          await call("/v1/memories/search", "POST", { query: "concise" })
        ).json()) as any
      ).items.length,
      1,
    );
    const task = f.store.create(
      owner,
      {
        conversationId: "new",
        kind: "query",
        prompt: "test",
        modelProfileId: "p",
      },
      "new",
    );
    assert.equal(
      (
        await call(`/v1/requests/${task.id}/model`, "POST", {
          profileId: "p",
          expectedRevision: task.revision,
        })
      ).status,
      200,
    );
    assert.deepEqual(cancelled, [task.id]);
    assert.equal((await call(`/v1/requests/${f.source.id}/runs`)).status, 200);
    const exported = (await (await call("/v1/export")).json()) as any;
    assert.equal(exported.memories.length, 1);
    assert.equal(exported.profiles.length, 1);
    assert.equal((await call("/v1/data", "DELETE")).status, 400);
    assert.equal(
      (
        await call("/v1/data", "DELETE", undefined, {
          "X-Confirm-Delete": "all-local-task-data",
        })
      ).status,
      204,
    );
    assert.deepEqual(await f.memory.export(owner), []);
    assert.deepEqual(f.store.profiles(owner), []);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    f.close();
  }
});
test("selected reviewed memory enters the local prompt and changed memory prevents result persistence", async () => {
  const f = fixture();
  let generations = 0;
  try {
    const candidate = await f.memory.add(owner, {
      text: "Concise summaries",
      type: "preference",
      origin: "user",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: f.source.id,
          revision: String(f.source.revision),
        },
      ],
    });
    const make = (key: string) =>
      f.store.create(
        owner,
        {
          conversationId: key,
          kind: "query",
          prompt: "Summarize",
          modelProfileId: "p",
          memoryIds: [candidate.id],
        },
        key,
      );
    const runtime = {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async (_model: unknown, prompt: string) => {
        generations++;
        assert.match(prompt, /Concise summaries/);
        if (generations === 2)
          await f.memory.review(owner, candidate.id, 2, { approve: false });
        return "draft";
      },
    };
    const worker = new LocalWorker(
      f.store,
      owner,
      runtime,
      () => profile,
      "worker",
      f.memory,
    );
    const denied = make("unreviewed");
    await worker.runOnce();
    assert.equal(f.store.get(owner, denied.id).status, "failed");
    assert.equal(generations, 0);
    await f.memory.review(owner, candidate.id, 1, { approve: true });
    const accepted = make("approved");
    await worker.runOnce();
    assert.equal(f.store.get(owner, accepted.id).status, "completed");
    assert.equal(
      (f.store.get(owner, accepted.id).result as any).memories[0].id,
      candidate.id,
    );
    const changed = make("changed");
    await worker.runOnce();
    assert.equal(f.store.get(owner, changed.id).status, "failed");
    assert.equal(f.store.get(owner, changed.id).result, null);
    assert.equal(
      await localMemoryAccess(f.store)({ ...owner, userId: "bob" }, [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: f.source.id,
          revision: String(f.source.revision),
        },
      ]),
      false,
    );
    f.store.deleteAll(owner);
    assert.deepEqual(await f.memory.export(owner), []);
  } finally {
    f.close();
  }
});
