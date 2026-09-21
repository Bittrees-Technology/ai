import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "alice", tenantId: "home" };
const profile = {
  id: "p",
  runtime: "ollama" as const,
  model: "local",
  contextTokens: 2048,
  maxOutputTokens: 100,
  temperature: 0.2,
};
test("worker records immutable model selection, returns only draft text and preserves ordering", async () => {
  const s = new Store(":memory:", new Vault(randomBytes(32)));
  const p = { ...profile };
  const worker = new LocalWorker(
    s,
    owner,
    {
      pin: async () => ({ profile: { ...p }, digest: "a".repeat(64) }),
      generate: async () => {
        assert.equal(s.db.inTransaction, false);
        p.model = "changed-for-next-run";
        return "draft";
      },
    },
    () => p,
  );
  try {
    const a = s.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "test",
        modelProfileId: "p",
      },
      "a",
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(s.get(owner, a.id).status, "completed");
    assert.equal(
      (s.get(owner, a.id).result as { kind: string }).kind,
      "unreviewed_draft",
    );
    assert.equal(
      (s.runHistory(owner, a.id)[0]!.model as { profile: { model: string } })
        .profile.model,
      "local",
    );
    assert.equal(await worker.runOnce(), false);
  } finally {
    s.close();
  }
});
test("cancelled generation cannot write a late result or claim another task concurrently", async () => {
  const s = new Store(":memory:", new Vault(randomBytes(32)));
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  let finish!: (s: string) => void;
  const worker = new LocalWorker(
    s,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () => {
        began();
        return new Promise<string>((r) => {
          finish = r;
        });
      },
    },
    () => profile,
  );
  try {
    const a = s.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "test",
        modelProfileId: "p",
      },
      "a",
    );
    const running = worker.runOnce();
    await started;
    assert.equal(await worker.runOnce(), false);
    const current = s.get(owner, a.id);
    s.command(owner, a.id, {
      command: "cancel",
      expectedRevision: current.revision,
    });
    worker.cancel(a.id);
    finish("late");
    await running;
    assert.equal(s.get(owner, a.id).status, "cancelled");
    assert.equal(s.get(owner, a.id).result, null);
  } finally {
    s.close();
  }
});
