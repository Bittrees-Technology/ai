import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const alice = { userId: "alice", tenantId: "home" },
  bob = { userId: "bob", tenantId: "home" };
const input = (conversationId = "c") => ({
  conversationId,
  kind: "query",
  prompt: "SENTINEL_PRIVATE_PROMPT",
  modelProfileId: "m",
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-ai-"));
  const path = join(dir, "queue.db");
  let now = 1000;
  const vault = new Vault(randomBytes(32));
  let store = new Store(path, vault, () => now);
  return {
    dir,
    path,
    vault,
    get store() {
      return store;
    },
    advance: (n: number) => {
      now += n;
    },
    reopen: () => {
      store.close();
      store = new Store(path, vault, () => now);
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("encrypted durable content and owner isolation survive restart", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k");
    f.store.create(bob, input(), "k");
    f.reopen();
    assert.equal(
      f.store.get(alice, a.id).input.prompt,
      "SENTINEL_PRIVATE_PROMPT",
    );
    assert.throws(() => f.store.get(bob, a.id), /NOT_FOUND/);
    assert.equal(f.store.list(alice).length, 1);
    assert.equal(
      readFileSync(f.path).includes("SENTINEL_PRIVATE_PROMPT"),
      false,
    );
    assert.equal(
      JSON.stringify(f.store.events(alice)).includes("SENTINEL"),
      false,
    );
  } finally {
    f.close();
  }
});
test("idempotency preserves IDs, canonical field order and conflicting retry rejection", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k");
    assert.equal(f.store.create(alice, { ...input() }, "k").id, a.id);
    assert.throws(
      () => f.store.create(alice, { ...input(), prompt: "different" }, "k"),
      /CONFLICT/,
    );
    assert.equal(f.store.events(alice).length, 1);
  } finally {
    f.close();
  }
});
test("conversation order and dependencies allow only eligible claims", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "a"),
      b = f.store.create(alice, input(), "b");
    assert.equal(b.sequence, a.sequence + 1);
    const claim = f.store.claim(alice, "w")!;
    assert.equal(claim.task.id, a.id);
    assert.equal(f.store.claim(alice, "other"), null);
    f.store.create(alice, { ...input("second"), dependencies: [b.id] }, "dep");
    assert.equal(f.store.claim(alice, "other"), null);
    f.store.complete(alice, a.id, "w", claim.generation, "done");
    assert.equal(f.store.claim(alice, "w")!.task.id, b.id);
    assert.throws(
      () =>
        f.store.create(bob, { ...input(), dependencies: [a.id] }, "illegal"),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});
test("expired worker cannot complete after reassignment, heartbeat or cancellation", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k"),
      first = f.store.claim(alice, "old", 100)!;
    f.advance(101);
    const second = f.store.claim(alice, "new", 100)!;
    assert.ok(second.generation > first.generation);
    assert.throws(
      () => f.store.complete(alice, a.id, "old", first.generation, "stale"),
      /STALE_CLAIM/,
    );
    f.store.heartbeat(alice, a.id, "new", second.generation, 200);
    f.advance(101);
    assert.equal(f.store.claim(alice, "third"), null);
    f.store.command(alice, a.id, {
      command: "cancel",
      expectedRevision: second.task.revision,
    });
    assert.throws(
      () => f.store.complete(alice, a.id, "new", second.generation, "late"),
      /STALE_CLAIM/,
    );
  } finally {
    f.close();
  }
});
test("pause/resume requires current revision and terminal tasks cannot resume", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k");
    const p = f.store.command(alice, a.id, {
      command: "pause",
      expectedRevision: 1,
    });
    assert.equal(f.store.claim(alice, "w"), null);
    assert.throws(
      () =>
        f.store.command(alice, a.id, {
          command: "resume",
          expectedRevision: 1,
        }),
      /CONFLICT/,
    );
    const r = f.store.command(alice, a.id, {
      command: "resume",
      expectedRevision: p.revision,
    });
    assert.equal(r.status, "queued");
    const c = f.store.claim(alice, "w")!;
    const done = f.store.complete(alice, a.id, "w", c.generation, "ok");
    assert.throws(
      () =>
        f.store.command(alice, a.id, {
          command: "resume",
          expectedRevision: done.revision,
        }),
      /CONFLICT/,
    );
  } finally {
    f.close();
  }
});
test("bounded retries, deadlines, transactional outbox acknowledgement", () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k");
    for (let i = 0; i < 3; i++) {
      const c = f.store.claim(alice, "w")!;
      assert.ok(c);
      f.store.fail(alice, a.id, "w", c.generation, true);
      f.advance(10000);
    }
    assert.equal(f.store.get(alice, a.id).status, "failed");
    assert.equal(f.store.claim(alice, "w"), null);
    const pending = f.store.pending(alice) as { id: string }[];
    assert.ok(pending.length);
    f.store.acknowledge(bob, pending[0]!.id);
    assert.equal(f.store.pending(alice).length, pending.length);
    f.store.acknowledge(alice, pending[0]!.id);
    f.store.acknowledge(alice, pending[0]!.id);
    assert.equal(f.store.pending(alice).length, pending.length - 1);
    assert.throws(
      () =>
        f.store.create(
          alice,
          { ...input(), deadline: "1970-01-01T00:00:00Z" },
          "expired",
        ),
      /EXPIRED/,
    );
  } finally {
    f.close();
  }
});
test("backup includes WAL content; export and deletion preserve other users", async () => {
  const f = fixture();
  try {
    const a = f.store.create(alice, input(), "k");
    const b = f.store.create(bob, input(), "k");
    const backup = join(f.dir, "backup.db");
    await f.store.backup(backup);
    const restored = new Store(backup, f.vault);
    assert.equal(
      restored.get(alice, a.id).input.prompt,
      "SENTINEL_PRIVATE_PROMPT",
    );
    restored.close();
    assert.equal(f.store.export(alice).length, 1);
    f.store.deleteAll(alice);
    assert.equal(f.store.export(alice).length, 0);
    assert.equal(f.store.get(bob, b.id).id, b.id);
  } finally {
    f.close();
  }
});
test("authenticated encryption binds content to its record and rejects wrong keys", () => {
  const v = new Vault(randomBytes(32)),
    cipher = v.seal("secret", "record:1");
  assert.throws(() => v.open(cipher, "record:2"));
  assert.throws(() => new Vault(randomBytes(32)).open(cipher, "record:1"));
  cipher[cipher.length - 1]! ^= 1;
  assert.throws(() => v.open(cipher, "record:1"));
});
