import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const owner = { userId: "alice", tenantId: "personal" };
const profile = {
  id: "first",
  runtime: "ollama",
  model: "local:1",
  contextTokens: 2048,
  maxOutputTokens: 100,
  temperature: 0.2,
};
test("profiles are immutable and defaults do not change existing task selections", () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    store.addProfile(owner, profile);
    store.addProfile(owner, { ...profile, id: "second", model: "local:2" });
    store.setDefaultProfile(owner, "first");
    const task = store.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "hello",
        modelProfileId: store.defaultProfile(owner)!.id,
      },
      "task",
    );
    store.setDefaultProfile(owner, "second");
    assert.equal(store.get(owner, task.id).input.modelProfileId, "first");
    assert.throws(
      () => store.addProfile(owner, { ...profile, model: "different" }),
      /CONFLICT/,
    );
    assert.throws(
      () => store.profile({ ...owner, userId: "bob" }, "first"),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        store.addProfile(owner, {
          ...profile,
          id: "too-large",
          maxOutputTokens: 2048,
        }),
      /INVALID_INPUT/,
    );
  } finally {
    store.close();
  }
});
test("explicit model switching fences a running attempt and retains its history", () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    store.addProfile(owner, profile);
    store.addProfile(owner, { ...profile, id: "second", model: "local:2" });
    const task = store.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "hello",
        modelProfileId: "first",
      },
      "task",
    );
    const first = store.claim(owner, "worker")!;
    store.recordModel(owner, task.id, "worker", first.generation, {
      profile,
      digest: "a".repeat(64),
    });
    assert.throws(
      () => store.switchModel(owner, task.id, "second", 1),
      /CONFLICT/,
    );
    const switched = store.switchModel(
      owner,
      task.id,
      "second",
      first.task.revision,
    );
    assert.equal(switched.status, "queued");
    assert.equal(switched.input.modelProfileId, "second");
    assert.throws(
      () => store.complete(owner, task.id, "worker", first.generation, "late"),
      /STALE_CLAIM/,
    );
    const second = store.claim(owner, "worker")!;
    store.recordModel(owner, task.id, "worker", second.generation, {
      profile: { ...profile, id: "second" },
      digest: "b".repeat(64),
    });
    store.complete(owner, task.id, "worker", second.generation, "result");
    const history = store.runHistory(owner, task.id) as {
      outcome: string;
      model: { digest: string };
    }[];
    assert.equal(history.length, 2);
    assert.equal(history[0]!.outcome, "model_switched");
    assert.equal(history[0]!.model.digest, "a".repeat(64));
    assert.equal(history[1]!.outcome, "completed");
  } finally {
    store.close();
  }
});
