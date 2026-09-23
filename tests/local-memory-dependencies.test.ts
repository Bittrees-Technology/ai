import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  localMemoryAccess,
  localTaskDependencies,
} from "../apps/companion/memory.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "alice", tenantId: "home" };
const profile = {
  id: "p",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 8192,
  maxOutputTokens: 1000,
  temperature: 0,
};
function fixture() {
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  let now = 1000;
  const memory: MemoryStore = new MemoryStore(
    ":memory:",
    vault,
    localMemoryAccess(store, () => memory),
    () => now,
  );
  store.addProfile(owner, profile);
  const worker = (
    generate: () => Promise<string> = async () => "PRIVATE_DERIVED_RESULT",
  ) =>
    new LocalWorker(
      store,
      owner,
      {
        pin: async () => ({
          profile: store.profile(owner, "p"),
          digest: "a".repeat(64),
        }),
        generate,
      },
      () => store.profile(owner, "p"),
      "worker",
      memory,
    );
  const create = (memoryIds: string[] = []) =>
    store.create(
      owner,
      {
        conversationId: randomUUID(),
        kind: "query",
        prompt: "Synthetic request",
        modelProfileId: "p",
        memoryIds,
      },
      randomUUID(),
    );
  const complete = async (memoryIds: string[] = []) => {
    const task = create(memoryIds),
      w = worker();
    await w.runOnce();
    await w.stop();
    assert.equal(store.get(owner, task.id).status, "completed");
    return store.get(owner, task.id);
  };
  const add = async (
    task: ReturnType<Store["get"]>,
    expiresAt: number | null = null,
  ) => {
    const m = await memory.add(owner, {
      type: "fact",
      origin: "model",
      text: "PRIVATE_RETAINED_MEMORY",
      expiresAt,
      sources: [
        {
          app: "local",
          tenantId: "home",
          resourceId: task.id,
          revision: String(task.revision),
        },
      ],
    });
    return memory.review(owner, m.id, 1, { approve: true });
  };
  const current = (id: string) =>
    localTaskDependencies(store, owner, id, memory);
  return {
    vault,
    store,
    memory,
    worker,
    create,
    complete,
    add,
    current,
    setNow: (value: number) => {
      now = value;
    },
    close: () => {
      memory.close();
      store.close();
    },
  };
}
test("local dependency chains invalidate after forgetting, editing, unreviewing, expiry or deleting an ancestor; data stays retained", async () => {
  for (const change of [
    "forget",
    "edit",
    "unapprove",
    "expire",
    "delete-source",
  ] as const) {
    const f = fixture();
    try {
      const source = await f.complete(),
        first = await f.add(source, change === "expire" ? 1100 : null),
        derived = await f.complete([first.id]),
        second = await f.add(derived),
        child = await f.complete([second.id]);
      assert.equal(f.current(child.id), true);
      if (change === "forget") f.memory.forget(owner, first.id);
      if (change === "edit")
        await f.memory.review(owner, first.id, first.revision, {
          text: "Changed reference",
          approve: true,
        });
      if (change === "unapprove")
        await f.memory.review(owner, first.id, first.revision, {
          approve: false,
        });
      if (change === "expire") f.setNow(1101);
      if (change === "delete-source")
        f.store.db.prepare("DELETE FROM tasks WHERE id=?").run(source.id);
      assert.equal(f.current(derived.id), false, change);
      assert.equal(f.current(child.id), false, change);
      await assert.rejects(f.memory.get(owner, second.id), /NOT_FOUND/);
      assert.equal(
        (await f.memory.export(owner)).some((m) => m.id === second.id),
        false,
      );
      assert.equal(
        JSON.stringify(f.store.get(owner, child.id).result).includes(
          "PRIVATE_DERIVED_RESULT",
        ),
        true,
      );
    } finally {
      f.close();
    }
  }
});
test("recorded exact versions, ownership, missing store, malformed provenance, cycles and depth bounds fail closed", async () => {
  const f = fixture();
  try {
    const source = await f.complete(),
      m = await f.add(source),
      derived = await f.complete([m.id]);
    assert.equal(localTaskDependencies(f.store, owner, derived.id), false);
    assert.equal(
      localTaskDependencies(
        f.store,
        { ...owner, userId: "bob" },
        derived.id,
        f.memory,
      ),
      false,
    );
    assert.equal(
      localTaskDependencies(
        f.store,
        { ...owner, tenantId: "other" },
        derived.id,
        f.memory,
      ),
      false,
    );
    const run = f.store.runHistory(owner, derived.id).at(-1)!;
    const original = run.model;
    const row = f.store.db
      .prepare("SELECT model_snapshot FROM runs WHERE id=?")
      .get(run.id) as { model_snapshot: Buffer };
    assert.ok(original);
    f.store.db
      .prepare("UPDATE runs SET model_snapshot=NULL WHERE id=?")
      .run(run.id);
    assert.equal(f.current(derived.id), false);
    f.store.db
      .prepare("UPDATE runs SET model_snapshot=? WHERE id=?")
      .run(row.model_snapshot, run.id);
    assert.equal(f.current(derived.id), true);
    for (const memories of [
      [],
      [{ id: m.id, revision: m.revision + 1 }],
      [{ id: "forged", revision: 1 }],
      [
        { id: m.id, revision: m.revision },
        { id: m.id, revision: m.revision },
      ],
    ]) {
      f.store.db
        .prepare("UPDATE runs SET model_snapshot=? WHERE id=?")
        .run(
          f.vault.seal(
            { memories },
            "run:" + derived.id + ":" + run.generation,
          ),
          run.id,
        );
      assert.equal(f.current(derived.id), false);
    }
    f.store.db
      .prepare("UPDATE runs SET model_snapshot=? WHERE id=?")
      .run(row.model_snapshot, run.id);
    await f.memory.review(owner, m.id, m.revision, { pinned: true });
    assert.equal(f.current(derived.id), false); // exact reviewed revision, even pin-only changes
    // Bound an extraction chain using authenticated synthetic bindings, without exposing data.
    const leaf = await f.complete();
    let parent = leaf;
    for (let i = 0; i < 66; i++) {
      const task = await f.complete();
      const binding = {
        parentId: parent.id,
        parentRevision: parent.revision,
        sourceHash: "a".repeat(64),
        promptVersion: 1,
      };
      f.store.db
        .prepare("INSERT INTO memory_extractions VALUES(?,?)")
        .run(
          task.id,
          f.vault.seal(
            binding,
            JSON.stringify([
              "memory-extraction",
              owner.tenantId,
              owner.userId,
              task.id,
            ]),
          ),
        );
      parent = task;
    }
    assert.equal(f.current(parent.id), false);
    f.store.db.prepare("INSERT INTO memory_extractions VALUES(?,?)").run(
      leaf.id,
      f.vault.seal(
        {
          parentId: parent.id,
          parentRevision: parent.revision,
          sourceHash: "a".repeat(64),
          promptVersion: 1,
        },
        JSON.stringify([
          "memory-extraction",
          owner.tenantId,
          owner.userId,
          leaf.id,
        ]),
      ),
    );
    assert.equal(f.current(leaf.id), false);
  } finally {
    f.close();
  }
});
test("worker will neither consume nor save content after transitive dependency loss, including suggestion prompts", async () => {
  const f = fixture();
  try {
    const source = await f.complete(),
      m = await f.add(source),
      derived = await f.complete([m.id]);
    const extraction = f.store.memoryExtractions.create(owner, derived.id, {
      expectedRevision: derived.revision,
      modelProfileId: "p",
      invocationId: randomUUID(),
      confirmed: true,
    });
    f.memory.forget(owner, m.id);
    let calls = 0;
    const w = f.worker(async () => {
      calls++;
      return "SHOULD_NOT_RUN";
    });
    await w.runOnce();
    await w.stop();
    assert.equal(calls, 0);
    assert.equal(f.store.get(owner, extraction.id).status, "failed");
    const m2 = await f.add(source),
      pending = f.create([m2.id]);
    const w2 = f.worker(async () => {
      f.memory.forget(owner, m2.id);
      return "MUST_NOT_SAVE";
    });
    await w2.runOnce();
    await w2.stop();
    assert.equal(f.store.get(owner, pending.id).status, "failed");
    assert.equal(
      JSON.stringify(f.store.get(owner, pending.id).result).includes(
        "MUST_NOT_SAVE",
      ),
      false,
    );
  } finally {
    f.close();
  }
});
test("authenticated reads, bulk/task exports, runs, reviews and suggestion operations conceal invalid local dependencies", async () => {
  const f = fixture(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({ store: f.store, memory: f.memory, owner, token, port }),
  );
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    authorized = true,
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + (authorized ? token : "bad"),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const source = await f.complete(),
      m = await f.add(source),
      derived = await f.complete([m.id]),
      m2 = await f.add(derived);
    const extracted = f.store.memoryExtractions.create(owner, derived.id, {
      expectedRevision: derived.revision,
      modelProfileId: "p",
      invocationId: randomUUID(),
      confirmed: true,
    });
    const feedback = f.store.taskFeedback.read(owner, derived.id);
    const review = {
      expectedTaskRevision: feedback.taskRevision,
      runId: feedback.runId,
      expectedReviewRevision: 0,
      operationId: randomUUID(),
      confirmed: true,
      review: { outcome: "accepted", note: "PRIVATE_REVIEW_NOTE" },
    };
    assert.equal(
      (await call(`/v1/requests/${derived.id}/quality-review`, "PUT", review))
        .status,
      200,
    );
    assert.equal((await call(`/v1/requests/${derived.id}/export`)).status, 200);
    f.memory.forget(owner, m.id);
    assert.equal(
      (await call("/v1/requests", "GET", undefined, false)).status,
      401,
    );
    for (const id of [derived.id, extracted.id]) {
      const task = (await (await call("/v1/requests/" + id)).json()) as any;
      assert.equal(task.dependencyAccess, "unavailable");
      assert.equal(task.result, null);
      assert.equal(task.input.prompt, "Local reference unavailable");
      assert.deepEqual(
        ((await (await call("/v1/requests/" + id + "/runs")).json()) as any)
          .items,
        [],
      );
      assert.equal((await call("/v1/requests/" + id + "/export")).status, 400);
      assert.equal(
        (await call("/v1/requests/" + id + "/quality-review")).status,
        404,
      );
      assert.equal(
        (await call("/v1/requests/" + id + "/memory-suggestions")).status,
        404,
      );
    }
    assert.equal(
      (await call(`/v1/requests/${derived.id}/quality-review`, "PUT", review))
        .status,
      404,
    );
    assert.equal(
      (await call(`/v1/requests/${derived.id}/memory-suggestions`, "POST", {}))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          `/v1/requests/${extracted.id}/memory-suggestions/save`,
          "POST",
          {},
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(`/v1/requests/${derived.id}/memories`, "POST", {
          text: "new",
          type: "fact",
        })
      ).status,
      404,
    );
    const exported = (await (await call("/v1/export")).json()) as any;
    assert.equal(
      exported.tasks.find((t: any) => t.id === derived.id).result,
      null,
    );
    assert.equal(
      exported.tasks.find((t: any) => t.id === extracted.id).input.prompt,
      "Local reference unavailable",
    );
    assert.equal(exported.qualityReviews.length, 0);
    assert.equal(exported.memoryExtractions.length, 0);
    assert.equal(
      exported.memories.some((v: any) => v.id === m2.id),
      false,
    );
    const listed = (await (await call("/v1/requests")).json()) as any;
    assert.equal(
      listed.items.find((t: any) => t.id === derived.id).result,
      null,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("local memory final fences catch ancestor deletion after an asynchronous access check", async () => {
  const f = fixture();
  try {
    const source = await f.complete(),
      m = await f.add(source),
      derived = await f.complete([m.id]);
    // The access function has already resolved true; deletion lands before get resumes.
    const next = await f.add(derived);
    const read = f.memory.get(owner, next.id);
    f.memory.forget(owner, m.id);
    await assert.rejects(read, /NOT_FOUND/);
    const m2 = await f.add(source),
      derived2 = await f.complete([m2.id]);
    const saving = f.add(derived2);
    f.memory.forget(owner, m2.id);
    await assert.rejects(saving, /NOT_FOUND/);
  } finally {
    f.close();
  }
});
