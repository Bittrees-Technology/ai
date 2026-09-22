import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
import { localApi } from "../apps/companion/http.js";

for (const change of ["delete-all", "edit-memory", "new-task"] as const) {
  test(`local export refuses mixed snapshots during ${change}`, async () => {
    const owner = { userId: "export-owner", tenantId: "personal" },
      vault = new Vault(randomBytes(32));
    const store = new Store(":memory:", vault),
      access = localMemoryAccess(store);
    let armed = false,
      entered!: () => void,
      release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      hold = new Promise<void>((r) => (release = r));
    const memory = new MemoryStore(":memory:", vault, async (o, s) => {
      if (armed) {
        armed = false;
        entered();
        await hold;
      }
      return access(o, s);
    });
    const task = store.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "PRIVATE EXPORT SENTINEL",
        modelProfileId: "p",
      },
      "original",
    );
    const claim = store.claim(owner, "seed")!;
    const completed = store.complete(owner, task.id, "seed", claim.generation, {
      text: "PRIVATE RESULT SENTINEL",
    });
    const item = await memory.add(owner, {
      type: "fact",
      text: "PRIVATE MEMORY SENTINEL",
      origin: "user",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: task.id,
          revision: String(completed.revision),
        },
      ],
    });
    const server = createServer(),
      token = randomBytes(32).toString("hex");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    server.on("request", localApi({ store, memory, owner, port, token }));
    const url = `http://127.0.0.1:${port}`,
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
    try {
      const ordinary = await fetch(url + "/v1/export", { headers });
      assert.equal(ordinary.status, 200);
      assert.equal((await ordinary.json()).memories.length, 1);
      armed = true;
      const pending = fetch(url + "/v1/export", { headers });
      await started;
      if (change === "delete-all") {
        const deleted = await fetch(url + "/v1/data", {
          method: "DELETE",
          headers: { ...headers, "X-Confirm-Delete": "all-local-task-data" },
        });
        assert.equal(deleted.status, 204);
      } else if (change === "edit-memory") {
        const edited = await fetch(url + "/v1/memories/" + item.id, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ revision: 1, text: "CHANGED MEMORY" }),
        });
        assert.equal(edited.status, 200);
      } else
        store.create(
          owner,
          {
            conversationId: "new",
            kind: "query",
            prompt: "NEW TASK",
            modelProfileId: "p",
          },
          "new",
        );
      release();
      const response = await pending;
      assert.equal(response.status, 409);
      const text = await response.text();
      assert.ok(!text.includes("SENTINEL"));
      assert.equal(JSON.parse(text).error, "CONFLICT");
      const retry = await fetch(url + "/v1/export", { headers });
      assert.equal(retry.status, 200);
      const data = await retry.json();
      if (change === "delete-all") {
        assert.deepEqual(data.tasks, []);
        assert.deepEqual(data.memories, []);
        assert.deepEqual(data.memoryExtractions, []);
      }
      if (change === "edit-memory")
        assert.equal(data.memories[0].text, "CHANGED MEMORY");
      if (change === "new-task") assert.equal(data.tasks.length, 2);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      memory.close();
      store.close();
    }
  });
}

test("change tokens detect writes through a second SQLite connection and remain stable on reads", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "export-token-")),
    path = join(dir, "store.db"),
    vault = new Vault(randomBytes(32));
  const one = new Store(path, vault),
    two = new Store(path, vault),
    owner = { userId: "a", tenantId: "t" };
  try {
    const before = one.changeToken();
    one.export(owner);
    assert.equal(one.changeToken(), before);
    two.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "external write",
        modelProfileId: "p",
      },
      "external",
    );
    assert.notEqual(one.changeToken(), before);
    const after = one.changeToken();
    one.export(owner);
    assert.equal(one.changeToken(), after);
    one.deleteAll(owner);
    assert.notEqual(one.changeToken(), after);
  } finally {
    two.close();
    one.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
