import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { dependencyFailureSchema } from "../modules/storage/dependency-failure.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";
import { projectRemoteStatus } from "../modules/remote/status.js";
const owner = { userId: "alice", tenantId: "local" };
const other = { userId: "alice", tenantId: "other" };
const input = (conversationId: string, dependencies: string[] = []) => ({
  conversationId,
  dependencies,
  kind: "query",
  modelProfileId: "p",
  prompt: "DEPENDENCY_PRIVATE_PROMPT",
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-dependencies-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = Date.now(),
    s = new Store(path, vault, () => now);
  return {
    dir,
    path,
    vault,
    get s() {
      return s;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    reopen: () => {
      s.close();
      s = new Store(path, vault, () => now);
    },
    close: () => {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function cancel(s: Store, id: string) {
  return s.command(owner, id, {
    command: "cancel",
    expectedRevision: s.get(owner, id).revision,
  });
}
test("Failed, cancelled and expired prerequisites become encrypted failures; deeper chains settle on later ticks", () => {
  const f = fixture();
  try {
    const a = f.s.create(owner, input("a"), "a"),
      claim = f.s.claim(owner, "w")!;
    f.s.fail(owner, a.id, "w", claim.generation, false);
    const b = f.s.create(owner, input("b"), "b");
    cancel(f.s, b.id);
    const c = f.s.create(
      owner,
      { ...input("c"), deadline: new Date(f.now() + 100).toISOString() },
      "c",
    );
    const dependent = f.s.create(
      owner,
      input("chain", [a.id, b.id, c.id]),
      "d",
    );
    const child = f.s.create(owner, input("chain", [dependent.id]), "child");
    const next = f.s.create(owner, input("chain"), "next");
    f.advance(101);
    assert.equal(f.s.claim(owner, "w"), null);
    const failure = f.s.get(owner, dependent.id);
    assert.equal(failure.status, "failed");
    assert.equal(failure.generation, 1);
    assert.equal(failure.revision, 2);
    assert.deepEqual(
      dependencyFailureSchema
        .parse(failure.result)
        .prerequisites.map((p) => p.status)
        .sort(),
      ["cancelled", "expired", "failed"],
    );
    assert.equal(f.s.get(owner, child.id).status, "queued");
    const eligible = f.s.claim(owner, "w")!;
    assert.equal(eligible.task.id, next.id);
    assert.equal(f.s.get(owner, child.id).status, "failed");
    assert.equal(f.s.runHistory(owner, dependent.id).length, 0);
    assert.throws(
      () =>
        f.s.command(owner, dependent.id, {
          command: "resume",
          expectedRevision: 2,
        }),
      /CONFLICT/,
    );
    assert.equal(
      f.s.create(owner, input("chain", [a.id, b.id, c.id]), "d").id,
      dependent.id,
    );
    assert.equal(
      (f.s.events(owner) as any[]).filter(
        (e) => e.task_id === dependent.id && e.type === "dependency_failed",
      ).length,
      1,
    );
    f.reopen();
    assert.deepEqual(f.s.get(owner, dependent.id).result, failure.result);
    assert.equal(readFileSync(f.path).includes("dependency_failure"), false);
  } finally {
    f.close();
  }
});
test("Paused prerequisites and transient retries remain pending; successful dependencies still run", () => {
  const f = fixture();
  try {
    const parent = f.s.create(owner, input("parent"), "parent"),
      claim = f.s.claim(owner, "w")!;
    f.s.fail(owner, parent.id, "w", claim.generation, true);
    const dependent = f.s.create(owner, input("child", [parent.id]), "child");
    assert.equal(f.s.claim(owner, "w"), null);
    assert.equal(f.s.get(owner, dependent.id).status, "queued");
    const paused = f.s.command(owner, parent.id, {
      command: "pause",
      expectedRevision: f.s.get(owner, parent.id).revision,
    });
    f.advance(10000);
    assert.equal(f.s.claim(owner, "w"), null);
    f.s.command(owner, parent.id, {
      command: "resume",
      expectedRevision: paused.revision,
    });
    const retry = f.s.claim(owner, "w")!;
    f.s.complete(owner, parent.id, "w", retry.generation, { text: "done" });
    assert.equal(f.s.claim(owner, "w")!.task.id, dependent.id);
  } finally {
    f.close();
  }
});
test("Dependency reconciliation is bounded, owner-scoped and durable across concurrent connections", () => {
  const f = fixture();
  let second: Store | undefined;
  try {
    const parent = f.s.create(owner, input("p"), "p");
    cancel(f.s, parent.id);
    for (let i = 0; i < 129; i++)
      f.s.create(owner, input("child-" + i, [parent.id]), "child-" + i);
    const unrelated = f.s.create(other, input("other"), "other");
    assert.throws(
      () => f.s.create(other, input("bad", [parent.id]), "bad"),
      /NOT_FOUND/,
    );
    second = new Store(f.path, f.vault, f.now);
    assert.equal(f.s.claim(owner, "first"), null);
    const count = () =>
      f.s.db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE user_id=? AND tenant_id=? AND status='failed'",
        )
        .get(owner.userId, owner.tenantId) as { n: number };
    assert.equal(count().n, 128);
    assert.equal(second.claim(owner, "second"), null);
    assert.equal(count().n, 129);
    const events = f.s.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE type='dependency_failed'",
      )
      .get();
    f.s.claim(owner, "again");
    assert.deepEqual(
      f.s.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE type='dependency_failed'",
        )
        .get(),
      events,
    );
    assert.equal(f.s.get(other, unrelated.id).status, "queued");
  } finally {
    second?.close();
    f.close();
  }
});
test("Failure metadata, revisions and outbox records roll back together on a write failure", () => {
  const f = fixture();
  try {
    const parent = f.s.create(owner, input("p"), "p");
    cancel(f.s, parent.id);
    const a = f.s.create(owner, input("a", [parent.id]), "a"),
      b = f.s.create(owner, input("b", [parent.id]), "b");
    const before = f.s.events(owner);
    f.s.db.exec(
      "CREATE TRIGGER fail_dependency BEFORE INSERT ON outbox WHEN (SELECT type FROM events WHERE id=NEW.event_id)='dependency_failed' BEGIN SELECT RAISE(ABORT,'test'); END",
    );
    assert.throws(() => f.s.claim(owner, "w"), /test/);
    for (const id of [a.id, b.id]) {
      const row = f.s.get(owner, id);
      assert.equal(row.status, "queued");
      assert.equal(row.revision, 1);
      assert.equal(row.result, null);
    }
    assert.deepEqual(f.s.events(owner), before);
    f.s.db.exec("DROP TRIGGER fail_dependency");
    assert.equal(f.s.claim(owner, "w"), null);
    assert.equal(f.s.get(owner, a.id).status, "failed");
    assert.equal(f.s.get(owner, b.id).status, "failed");
  } finally {
    f.close();
  }
});
test("Actual worker skips impossible tasks and runs later independent work without exposing dependency content", async () => {
  const f = fixture();
  try {
    const parent = f.s.create(owner, input("p"), "p");
    cancel(f.s, parent.id);
    const blocked = f.s.create(owner, input("ordered", [parent.id]), "blocked"),
      next = f.s.create(
        owner,
        { ...input("ordered"), prompt: "only this independent task" },
        "next",
      );
    const profile = {
      id: "p",
      runtime: "ollama" as const,
      model: "synthetic",
      contextTokens: 2048,
      maxOutputTokens: 100,
      temperature: 0,
    };
    let calls = 0;
    const worker = new LocalWorker(
      f.s,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async (_p, prompt) => {
          calls++;
          assert.match(prompt, /only this independent task/);
          assert.doesNotMatch(prompt, /DEPENDENCY_PRIVATE_PROMPT/);
          assert.equal(f.s.db.inTransaction, false);
          return "independent draft";
        },
      },
      () => profile,
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(calls, 1);
    assert.equal(f.s.get(owner, blocked.id).status, "failed");
    assert.equal(f.s.get(owner, next.id).status, "completed");
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 1);
    const projected = JSON.stringify(
      projectRemoteStatus(f.s.get(owner, blocked.id), randomUUID()),
    );
    assert.doesNotMatch(
      projected,
      /dependency_failure|prerequisites|DEPENDENCY_PRIVATE_PROMPT/,
    );
    assert.equal(projected.includes(parent.id), false);
  } finally {
    f.close();
  }
});
test("Authenticated local failure details and encrypted backup preserve reasons without reopening terminal work", async () => {
  const f = fixture(),
    server = createServer();
  let restored: Store | undefined;
  try {
    const parent = f.s.create(owner, input("p"), "p");
    cancel(f.s, parent.id);
    const blocked = f.s.create(owner, input("c", [parent.id]), "c");
    f.s.command(owner, blocked.id, { command: "pause", expectedRevision: 1 });
    f.s.claim(owner, "w");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    server.on(
      "request",
      localApi({ store: f.s, owner, port, token: "s".repeat(32) }),
    );
    const url = `http://127.0.0.1:${port}/v1/requests/${blocked.id}`;
    assert.equal((await fetch(url)).status, 401);
    const res = await fetch(url, {
      headers: { authorization: "Bearer " + "s".repeat(32) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const saved = await res.json();
    assert.equal(saved.status, "failed");
    assert.equal(
      dependencyFailureSchema.parse(saved.result).prerequisites[0]!.taskId,
      parent.id,
    );
    await encryptedBackup(f.s, f.vault, join(f.dir, "backup.aib"));
    await restoreBackup(
      join(f.dir, "backup.aib"),
      f.vault,
      join(f.dir, "restored.db"),
    );
    restored = new Store(join(f.dir, "restored.db"), f.vault, f.now);
    assert.deepEqual(restored.get(owner, blocked.id).result, saved.result);
    assert.equal(restored.claim(owner, "w"), null);
    assert.throws(() => restored!.get(other, blocked.id), /NOT_FOUND/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    restored?.close();
    f.close();
  }
});
