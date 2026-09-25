import { LocalWorker } from "../apps/companion/worker.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { TemplateController } from "../apps/dashboard/template-state.js";
const owner = { userId: "alice", tenantId: "personal" };
const other = { userId: "bob", tenantId: "personal" };
const profile = {
  id: "model",
  runtime: "ollama",
  model: "local-model",
  contextTokens: 4096,
  maxOutputTokens: 1024,
  temperature: 0.2,
};
const definition = {
  name: "PRIVATE_NAME",
  kind: "query",
  prompt: "PRIVATE_PROMPT",
  modelProfileId: "model",
};
const save = () => ({
  id: randomUUID(),
  expectedRevision: 0,
  definition,
  confirmed: true as const,
});
const run = (expectedRevision = 1) => ({
  expectedRevision,
  invocationId: randomUUID(),
  confirmed: true as const,
});
function fixture() {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  store.addProfile(owner, profile);
  store.addProfile(other, profile);
  return store;
}
test("templates enforce exact versions, source-free definitions, encryption and owner isolation", () => {
  const store = fixture();
  try {
    const input = save();
    const item = store.saveTemplate(owner, input);
    assert.deepEqual(store.saveTemplate(owner, input), item);
    const row = store.db
      .prepare("SELECT payload FROM local_templates WHERE id=?")
      .get(item.id) as { payload: Buffer };
    assert.equal(row.payload.includes("PRIVATE"), false);
    assert.deepEqual(store.templates(other), []);
    assert.throws(() => store.runTemplate(other, item.id, run()), /NOT_FOUND/);
    assert.throws(() =>
      store.saveTemplate(owner, { ...input, confirmed: false }),
    );
    for (const field of [
      "sourceRefs",
      "memoryIds",
      "dependencies",
      "authority",
      "remoteApproved",
    ])
      assert.throws(() =>
        store.saveTemplate(owner, {
          ...save(),
          definition: { ...definition, [field]: [] },
        }),
      );
    assert.throws(
      () =>
        store.saveTemplate(owner, {
          ...save(),
          definition: { ...definition, modelProfileId: "missing" },
        }),
      /NOT_FOUND/,
    );
    const revised = store.saveTemplate(owner, {
      ...input,
      expectedRevision: 1,
      definition: { ...definition, prompt: "REVISED" },
    });
    assert.equal(revised.revision, 2);
    assert.throws(() => store.runTemplate(owner, item.id, run()), /CONFLICT/);
    assert.throws(
      () =>
        store.deleteTemplate(owner, item.id, {
          expectedRevision: 1,
          confirmed: true,
        }),
      /CONFLICT/,
    );
    const intent = run(2);
    const task = store.runTemplate(owner, item.id, intent);
    assert.equal(task.input.prompt, "REVISED");
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(task.input.memoryIds, undefined);
    assert.equal(store.runTemplate(owner, item.id, intent).id, task.id);
    assert.equal(store.list(owner).length, 1);
    const second = store.saveTemplate(owner, save());
    assert.throws(
      () =>
        store.runTemplate(owner, second.id, { ...intent, expectedRevision: 1 }),
      /CONFLICT/,
    );
    store.deleteTemplate(owner, item.id, {
      expectedRevision: 2,
      confirmed: true,
    });
    assert.throws(() => store.runTemplate(owner, item.id, intent), /NOT_FOUND/);
    assert.throws(() => store.saveTemplate(owner, input), /CONFLICT/);
    assert.equal(store.get(owner, task.id).input.prompt, "REVISED");
    assert.equal(
      (
        store.db
          .prepare("SELECT payload FROM local_templates WHERE id=?")
          .get(item.id) as { payload: unknown }
      ).payload,
      null,
    );
  } finally {
    store.close();
  }
});
test("template task creation rolls back on failure; active definitions are bounded and deletion frees capacity", () => {
  const store = fixture();
  try {
    const item = store.saveTemplate(owner, save());
    const intent = run();
    store.db.exec(
      "CREATE TRIGGER fail_template_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected event failure'); END",
    );
    assert.throws(
      () => store.runTemplate(owner, item.id, intent),
      /injected event failure/,
    );
    assert.equal(store.list(owner).length, 0);
    store.db.exec("DROP TRIGGER fail_template_event");
    assert.equal(store.runTemplate(owner, item.id, intent).status, "queued");
    for (let n = 1; n < 100; n++) store.saveTemplate(owner, save());
    assert.throws(() => store.saveTemplate(owner, save()), /CAPACITY/);
    store.deleteTemplate(owner, item.id, {
      expectedRevision: 1,
      confirmed: true,
    });
    store.saveTemplate(owner, save());
    assert.equal(store.templates(owner).length, 100);
    store.saveTemplate(other, save());
    store.deleteAll(owner);
    assert.equal(store.templates(owner).length, 0);
    assert.equal(store.templates(other).length, 1);
  } finally {
    store.close();
  }
});
test("schema-eight upgrade and encrypted restore preserve local template definitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-templates-"));
  const vault = new Vault(randomBytes(32)),
    path = join(dir, "source.db");
  let store = new Store(path, vault);
  let restored: Store | undefined;
  try {
    store.addProfile(owner, profile);
    const existing = store.create(
      owner,
      {
        conversationId: "old",
        kind: "query",
        prompt: "old",
        modelProfileId: "model",
      },
      "old",
    );
    store.db.exec("DROP TABLE local_templates; PRAGMA user_version=8");
    store.close();
    store = new Store(path, vault);
    assert.equal(store.db.pragma("user_version", { simple: true }), 39);
    assert.equal(store.get(owner, existing.id).input.prompt, "old");
    const item = store.saveTemplate(owner, save());
    await encryptedBackup(store, vault, join(dir, "backup.enc"));
    await restoreBackup(
      join(dir, "backup.enc"),
      vault,
      join(dir, "restore.db"),
    );
    restored = new Store(join(dir, "restore.db"), vault);
    assert.deepEqual(restored.template(owner, item.id), item);
    assert.equal(
      restored.runTemplate(owner, item.id, run()).input.prompt,
      definition.prompt,
    );
  } finally {
    restored?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("authenticated local HTTP supports template save, run, export and deletion without remote authority", async () => {
  const store = fixture(),
    token = randomBytes(32).toString("hex"),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, owner, token, port }));
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + "/v1/templates")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/templates", {
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const input = save();
    assert.equal(
      (await request("/v1/templates", "PUT", { ...input, confirmed: false }))
        .status,
      400,
    );
    const item = await (await request("/v1/templates", "PUT", input)).json();
    assert.equal(item.revision, 1);
    const intent = run();
    const replies = await Promise.all([
      request(`/v1/templates/${item.id}/run`, "POST", intent),
      request(`/v1/templates/${item.id}/run`, "POST", intent),
    ]);
    assert.deepEqual(
      replies.map((r) => r.status),
      [202, 202],
    );
    assert.equal((await replies[0]!.json()).id, (await replies[1]!.json()).id);
    assert.equal(
      (
        await request(`/v1/templates/${item.id}/run`, "POST", {
          ...intent,
          prompt: "override",
        })
      ).status,
      400,
    );
    assert.deepEqual((await (await request("/v1/export")).json()).templates, [
      item,
    ]);
    assert.equal(
      (
        await request(`/v1/templates/${item.id}`, "DELETE", {
          expectedRevision: 1,
          confirmed: true,
        })
      ).status,
      204,
    );
    assert.deepEqual((await (await request("/v1/templates")).json()).items, []);
    assert.deepEqual(
      (await (await request("/v1/export")).json()).templates,
      [],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
test("template review resets on edit; failed run retries the same intent; hidden late responses stay hidden", async () => {
  const item = {
    id: randomUUID(),
    revision: 1,
    definition: { ...definition, kind: "query" as const },
  };
  const calls: any[] = [];
  let fail = true;
  const controller = new TemplateController(async (path, method, body) => {
    if (!method) return { items: [item] };
    calls.push({ path, body });
    if (fail) throw Error("UNAVAILABLE");
    return { id: "task" };
  });
  await controller.load();
  controller.select(item);
  await assert.rejects(controller.run(), /INVALID_INPUT/);
  controller.confirm(true);
  controller.edit({ prompt: "edited" });
  assert.equal(controller.confirmed, false);
  controller.confirm(true);
  await assert.rejects(controller.run(), /INVALID_INPUT/);
  controller.select(item);
  controller.confirm(true);
  await assert.rejects(controller.run(), /UNAVAILABLE/);
  controller.hide();
  await controller.load();
  controller.select(item);
  controller.confirm(true);
  fail = false;
  assert.equal((await controller.run())?.id, "task");
  assert.deepEqual(calls[0], calls[1]);
  let finish!: (value: unknown) => void;
  const delayed = new TemplateController(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = delayed.load();
  delayed.hide();
  finish({ items: [item] });
  await loading;
  assert.deepEqual(delayed.items, []);
  assert.equal(delayed.draft, null);
});

test("template runs use their saved prompt and profile through the actual worker", async () => {
  const store = fixture();
  try {
    const item = store.saveTemplate(owner, save());
    const task = store.runTemplate(owner, item.id, run());
    store.saveTemplate(owner, {
      id: item.id,
      expectedRevision: 1,
      definition: { ...definition, prompt: "changed after queueing" },
      confirmed: true,
    });
    let generated = false;
    const worker = new LocalWorker(
      store,
      owner,
      {
        pin: async (raw) => {
          assert.deepEqual(raw, profile);
          return {
            profile: { ...profile, runtime: "ollama" as const },
            digest: "a".repeat(64),
          };
        },
        generate: async (_model, prompt) => {
          assert.ok(prompt.includes(definition.prompt));
          assert.equal(prompt.includes("changed after queueing"), false);
          generated = true;
          return "Synthetic draft";
        },
      },
      (id) => store.profile(owner, id),
    );
    await worker.runOnce();
    assert.equal(generated, true);
    assert.equal(store.get(owner, task.id).status, "completed");
    assert.equal(
      (store.get(owner, task.id).result as { kind: string }).kind,
      "unreviewed_draft",
    );
  } finally {
    store.close();
  }
});
