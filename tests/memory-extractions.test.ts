import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
const owner = { userId: "alice", tenantId: "home" };
const other = { ...owner, userId: "bob" };
const profile = {
  id: "model",
  runtime: "ollama",
  model: "local",
  contextTokens: 8192,
  maxOutputTokens: 2048,
  temperature: 0,
};
const quote = "I prefer concise summaries.";
const output = JSON.stringify({
  version: 1,
  candidates: [
    {
      type: "preference",
      text: quote,
      evidence: [{ source: "request", quote }],
    },
  ],
});
function fixture(path = ":memory:", vault = new Vault(randomBytes(32))) {
  const store = new Store(path, vault);
  store.addProfile(owner, profile);
  const task = store.create(
    owner,
    {
      conversationId: "parent",
      kind: "query",
      prompt: quote,
      modelProfileId: "model",
    },
    "parent",
  );
  const claim = store.claim(owner, "seed")!;
  const parent = store.complete(owner, task.id, "seed", claim.generation, {
    text: "The summary is ready.",
  });
  const request = () => ({
    expectedRevision: parent.revision,
    modelProfileId: "model",
    invocationId: randomUUID(),
    confirmed: true,
  });
  return { store, parent, request, vault };
}
function worker(store: Store, generate: () => Promise<string>) {
  return new LocalWorker(
    store,
    owner,
    {
      pin: async () => ({
        profile: store.profile(owner, "model"),
        digest: "a".repeat(64),
      }),
      generate,
    },
    (id) => store.profile(owner, id),
  );
}
test("extraction uses pinned queue inference and keeps output unverified, with exact retry and no recursive extraction", async () => {
  const f = fixture();
  try {
    const input = f.request();
    const task = f.store.memoryExtractions.create(owner, f.parent.id, input);
    assert.equal(
      f.store.memoryExtractions.create(owner, f.parent.id, input).id,
      task.id,
    );
    assert.throws(
      () => f.store.memoryExtractions.create(other, f.parent.id, input),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        f.store.memoryExtractions.create(owner, f.parent.id, {
          ...input,
          expectedRevision: 1,
        }),
      /CONFLICT/,
    );
    assert.throws(() =>
      f.store.memoryExtractions.create(owner, f.parent.id, {
        ...input,
        confirmed: false,
      }),
    );
    const w = worker(f.store, async () => {
      assert.equal(f.store.db.inTransaction, false);
      return output;
    });
    await w.runOnce();
    const completed = f.store.get(owner, task.id);
    assert.equal(completed.status, "completed");
    const result = completed.result as any;
    assert.equal(result.kind, "memory_candidates");
    assert.equal(result.text, undefined);
    assert.equal(result.sourceTaskId, f.parent.id);
    assert.equal(result.sourceRevision, f.parent.revision);
    assert.equal(result.candidates[0].state, "candidate");
    assert.equal(result.candidates[0].verified, false);
    assert.equal(result.candidates[0].origin, "model");
    assert.equal(
      (f.store.runHistory(owner, task.id)[0]!.model as any).extraction.parentId,
      f.parent.id,
    );
    assert.equal(
      f.store.memoryExtractions.create(owner, f.parent.id, input).id,
      task.id,
    );
    assert.throws(
      () =>
        f.store.memoryExtractions.create(owner, task.id, {
          ...f.request(),
          expectedRevision: completed.revision,
        }),
      /CONFLICT/,
    );
  } finally {
    f.store.close();
  }
});
test("invalid output fails without saving raw output, cancellation discards late inference, and source changes fail commit", async () => {
  const f = fixture();
  try {
    const invalid = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    await worker(f.store, async () => "private invalid raw output").runOnce();
    assert.equal(f.store.get(owner, invalid.id).status, "failed");
    assert.equal(f.store.get(owner, invalid.id).result, null);
    assert.equal(
      f.store.runHistory(owner, invalid.id)[0]!.outcome,
      "invalid_model_output",
    );
    const cancelled = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    const w = worker(f.store, async () => {
      const current = f.store.get(owner, cancelled.id);
      f.store.command(owner, cancelled.id, {
        command: "cancel",
        expectedRevision: current.revision,
      });
      w.cancel(cancelled.id);
      return output;
    });
    await w.runOnce();
    assert.equal(f.store.get(owner, cancelled.id).status, "cancelled");
    assert.equal(f.store.get(owner, cancelled.id).result, null);
    const changed = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    await worker(f.store, async () => {
      f.store.db
        .prepare("UPDATE tasks SET revision=revision+1 WHERE id=?")
        .run(f.parent.id);
      return output;
    }).runOnce();
    assert.equal(f.store.get(owner, changed.id).status, "failed");
    assert.equal(f.store.get(owner, changed.id).result, null);
  } finally {
    f.store.close();
  }
});
test("bounded queue rolls back overflow, preserves retry at capacity and rejects generic idempotency collisions", () => {
  const f = fixture();
  try {
    const input = f.request();
    const first = f.store.memoryExtractions.create(owner, f.parent.id, input);
    for (let i = 1; i < 20; i++)
      f.store.memoryExtractions.create(owner, f.parent.id, f.request());
    assert.throws(
      () => f.store.memoryExtractions.create(owner, f.parent.id, f.request()),
      /CAPACITY/,
    );
    assert.equal(f.store.export(owner).length, 21);
    assert.equal(
      f.store.memoryExtractions.create(owner, f.parent.id, input).id,
      first.id,
    );
    const collision = f.request();
    const generic = f.store.create(
      owner,
      { ...first.input, conversationId: collision.invocationId },
      "memory-candidates:" + collision.invocationId,
    );
    assert.equal(f.store.memoryExtractions.context(owner, generic.id), null);
    assert.throws(
      () => f.store.memoryExtractions.create(owner, f.parent.id, collision),
      /CONFLICT/,
    );
    assert.equal(f.store.memoryExtractions.context(owner, generic.id), null);
    f.store.deleteAll(owner);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) AS n FROM memory_extractions")
          .get() as any
      ).n,
      0,
    );
  } finally {
    f.store.close();
  }
});
test("schema ten upgrade, encrypted backup and reopen retain pending extraction provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-extractions-"));
  const path = join(dir, "local.db");
  const f = fixture(path);
  let store = f.store;
  try {
    store.db.exec("DROP TABLE memory_extractions; PRAGMA user_version=10");
    store.close();
    store = new Store(path, f.vault);
    assert.equal(store.db.pragma("user_version", { simple: true }), 38);
    const input = f.request();
    const task = store.memoryExtractions.create(owner, f.parent.id, input);
    const blob = (
      store.db
        .prepare("SELECT payload FROM memory_extractions WHERE task_id=?")
        .get(task.id) as any
    ).payload as Buffer;
    assert.equal(blob.includes(Buffer.from(f.parent.id)), false);
    await encryptedBackup(store, f.vault, join(dir, "backup.enc"));
    await restoreBackup(
      join(dir, "backup.enc"),
      f.vault,
      join(dir, "restored.db"),
    );
    store.close();
    store = new Store(join(dir, "restored.db"), f.vault);
    assert.equal(
      store.memoryExtractions.create(owner, f.parent.id, input).id,
      task.id,
    );
    assert.equal(
      store.memoryExtractions.context(owner, task.id)!.parentId,
      f.parent.id,
    );
    await worker(store, async () => output).runOnce();
    assert.equal(store.get(owner, task.id).status, "completed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-bound parents and changed source payloads cannot enter or complete extraction", async () => {
  const f = fixture();
  try {
    const task = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    const claim = f.store.claim(owner, "manual")!;
    f.store.db
      .prepare("UPDATE tasks SET result=? WHERE id=?")
      .run(
        f.vault.seal(
          { text: "Changed result without a matching snapshot." },
          "result:" + f.parent.id,
        ),
        f.parent.id,
      );
    assert.throws(
      () =>
        f.store.complete(owner, task.id, "manual", claim.generation, {
          kind: "memory_candidates",
        }),
      /CONFLICT/,
    );
    f.store.fail(owner, task.id, "manual", claim.generation, false);
    f.store.db.prepare("UPDATE tasks SET input=? WHERE id=?").run(
      f.vault.seal(
        {
          ...f.parent.input,
          sourceRefs: [
            {
              app: "crm",
              tenantId: "home",
              resourceId: "external",
              revision: "1",
            },
          ],
        },
        "task:" + f.parent.id,
      ),
      f.parent.id,
    );
    assert.throws(
      () => f.store.memoryExtractions.create(owner, f.parent.id, f.request()),
      /CONFLICT/,
    );
  } finally {
    f.store.close();
  }
});

test("export retains queued and failed extraction provenance and runs without treating history as current authority", () => {
  const f = fixture();
  try {
    const queued = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    const claim = f.store.claim(owner, "export-worker")!;
    f.store.recordModel(owner, queued.id, "export-worker", claim.generation, {
      profile,
      digest: "a".repeat(64),
    });
    f.store.fail(
      owner,
      queued.id,
      "export-worker",
      claim.generation,
      false,
      "invalid_model_output",
    );
    const pending = f.store.memoryExtractions.create(
      owner,
      f.parent.id,
      f.request(),
    );
    f.store.db
      .prepare("UPDATE tasks SET revision=revision+1 WHERE id=?")
      .run(f.parent.id);
    assert.throws(
      () => f.store.memoryExtractions.context(owner, pending.id),
      /CONFLICT/,
    );
    const history = f.store.memoryExtractions.export(owner);
    assert.equal(history.length, 2);
    const failed = history.find((item) => item.taskId === queued.id)!;
    assert.equal(failed.parentId, f.parent.id);
    assert.equal(failed.parentRevision, f.parent.revision);
    assert.equal(failed.promptVersion, 2);
    assert.match(failed.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(failed.runs[0]!.outcome, "invalid_model_output");
    assert.equal((failed.runs[0]!.model as any).digest, "a".repeat(64));
    assert.equal(
      history.find((item) => item.taskId === pending.id)!.runs.length,
      0,
    );
    assert.deepEqual(f.store.memoryExtractions.export(other), []);
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.memoryExtractions.export(owner), []);
  } finally {
    f.store.close();
  }
});
