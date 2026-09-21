import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
const alice = { userId: "alice", tenantId: "home" },
  bob = { userId: "bob", tenantId: "home" };
const candidate = {
  type: "preference",
  text: "Use concise summaries with source citations",
  origin: "model",
  sources: [
    { app: "crm", tenantId: "home", resourceId: "selected", revision: "1" },
  ],
};
test("only reviewed, currently authorized memories are ranked; model claims stay unverified", async () => {
  let allowed = true;
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => allowed,
  );
  try {
    const m = await memory.add(alice, candidate);
    assert.equal((await memory.add(alice, candidate)).id, m.id);
    assert.deepEqual(await memory.search(alice, "summaries"), []);
    const approved = await memory.review(alice, m.id, 1, {
      approve: true,
      pinned: true,
    });
    assert.equal(approved.verified, false);
    const results = await memory.search(alice, "summaries citations");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.why.reviewed, true);
    assert.deepEqual(await memory.search(bob, "summaries"), []);
    await assert.rejects(memory.get(bob, m.id), /NOT_FOUND/);
    allowed = false;
    assert.deepEqual(await memory.search(alice, "summaries"), []);
    assert.deepEqual(await memory.export(alice), []);
    await assert.rejects(memory.get(alice, m.id), /NOT_FOUND/);
  } finally {
    memory.close();
  }
});
test("feedback is idempotent; retrieval cannot improve usefulness; edits and deletion persist", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
  );
  try {
    const m = await memory.add(alice, candidate);
    await memory.review(alice, m.id, 1, { approve: true });
    await memory.feedback(alice, m.id, "event1", "accepted");
    await memory.feedback(alice, m.id, "event1", "accepted");
    await assert.rejects(
      memory.feedback(alice, m.id, "event1", "rejected"),
      /CONFLICT/,
    );
    const first = (await memory.search(alice, "summaries"))[0]!;
    const second = (await memory.search(alice, "summaries"))[0]!;
    assert.equal(first.why.usefulness, second.why.usefulness);
    assert.equal(first.why.usefulness, 0.2);
    const edited = await memory.review(alice, m.id, 2, {
      text: "Use short summaries with exact citations",
    });
    assert.equal(edited.text, "Use short summaries with exact citations");
    memory.invalidate(alice, "crm", "selected");
    assert.deepEqual(await memory.search(alice, "summaries"), []);
    assert.deepEqual(await memory.export(alice), []);
  } finally {
    memory.close();
  }
});
test("expiration overrides pinning and wrong-user deletion cannot remove a memory", async () => {
  let now = 1000;
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
    () => now,
  );
  try {
    const m = await memory.add(alice, { ...candidate, expiresAt: 1100 });
    await memory.review(alice, m.id, 1, { approve: true, pinned: true });
    assert.throws(() => memory.forget(bob, m.id), /NOT_FOUND/);
    now = 1101;
    assert.deepEqual(await memory.search(alice, "summaries"), []);
    memory.forget(alice, m.id);
  } finally {
    memory.close();
  }
});

test("memory content stays encrypted across restart and wrong-key opens fail", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ai-memory-")),
    path = join(dir, "memory.db"),
    vault = new Vault(randomBytes(32));
  let s = new MemoryStore(path, vault, async () => true);
  try {
    const m = await s.add(alice, candidate);
    await s.review(alice, m.id, 1, { approve: true });
    s.close();
    s = new MemoryStore(path, vault, async () => true);
    assert.equal((await s.get(alice, m.id)).text, candidate.text);
    assert.equal(readFileSync(path).includes(candidate.text), false);
    assert.throws(
      () => new MemoryStore(path, new Vault(randomBytes(32)), async () => true),
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
