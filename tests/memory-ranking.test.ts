import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { Store } from "../modules/storage/store.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "alice", tenantId: "home" },
  other = { userId: "bob", tenantId: "home" };
const candidate = {
  type: "fact",
  text: "PRIVATE_MEMORY_SUMMARY art report",
  origin: "user",
  sources: [
    { app: "local", tenantId: "home", resourceId: "synthetic", revision: "1" },
  ],
};
async function approved(memory: MemoryStore, text: string, pinned = false) {
  const item = await memory.add(owner, {
    ...candidate,
    text,
    sources: [
      { ...candidate.sources[0], resourceId: randomBytes(12).toString("hex") },
    ],
  });
  return memory.review(owner, item.id, 1, { approve: true, pinned });
}
test("coverage uses actual FTS token matches, including accent normalization, rather than substrings", async () => {
  const cases = [
    ["art report", "art report", "quarterly report"],
    ["red account", "red account", "credit account"],
    ["2026 report", "2026 report", "12026 report"],
    ["cafe deadline", "café deadline", "deadline only"],
    ["resume approved", "résumé approved", "approved only"],
    ["release build", "release-build", "releases build"],
  ];
  for (const [query, full, partial] of cases) {
    const memory = new MemoryStore(
      ":memory:",
      new Vault(randomBytes(32)),
      async () => true,
      () => 1000,
    );
    try {
      await approved(memory, full!);
      await approved(memory, partial!, true);
      const results = await memory.search(owner, query!);
      assert.equal(results[0]!.text, full);
      assert.equal(results[0]!.why.relevance, 1);
      assert.equal(results[1]!.why.relevance, 0.5);
      assert.equal(results[0]!.why.matchedTerms.length, 2);
      assert.equal(results[1]!.why.matchedTerms.length, 1);
      assert.equal(results[0]!.verified, false);
      assert.deepEqual(await memory.search(other, query!), []);
    } finally {
      memory.close();
    }
  }
});
test("query operators stay literal, term count stays bounded and unauthorized memory cannot supply matching evidence", async () => {
  let access = true;
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async (_o, sources) => access || sources[0]!.resourceId !== "secret",
  );
  try {
    await approved(memory, "art OR report");
    const privateItem = await memory.add(owner, {
      ...candidate,
      text: "secret café report",
      sources: [{ ...candidate.sources[0], resourceId: "secret" }],
    });
    await memory.review(owner, privateItem.id, 1, { approve: true });
    access = false;
    const r = await memory.search(owner, '"art" OR report*');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0]!.why.matchedTerms, ["art", "or", "report"]);
    assert.deepEqual(await memory.search(owner, "cafe"), []);
    const query = Array.from({ length: 21 }, (_, i) => "word" + i).join(" ");
    await approved(memory, query);
    const bounded = await memory.search(owner, query);
    assert.equal(bounded[0]!.why.queryTerms.length, 20);
    assert.equal(bounded[0]!.why.relevance, 1);
  } finally {
    memory.close();
  }
});
test("feedback follows exact content through edits and pin changes without deleting prior ratings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-ranking-")),
    path = join(dir, "memory.db"),
    vault = new Vault(randomBytes(32));
  const memory = new MemoryStore(path, vault, async () => true);
  try {
    const item = await approved(memory, "release approved");
    await memory.feedback(owner, item.id, "rating", "accepted", item.revision);
    await memory.feedback(owner, item.id, "rating", "accepted", item.revision);
    const pinned = await memory.review(owner, item.id, item.revision, {
      pinned: true,
    });
    assert.equal(
      (await memory.search(owner, "release"))[0]!.why.usefulness,
      0.2,
    );
    await assert.rejects(
      memory.feedback(owner, item.id, "stale", "accepted", item.revision),
      /CONFLICT/,
    );
    const edited = await memory.review(owner, item.id, pinned.revision, {
      text: "release not approved",
      approve: true,
    });
    assert.equal((await memory.search(owner, "release"))[0]!.why.usefulness, 0);
    await assert.rejects(
      memory.feedback(owner, item.id, "rating", "accepted", edited.revision),
      /CONFLICT/,
    );
    await memory.feedback(
      owner,
      item.id,
      "new-rating",
      "rejected",
      edited.revision,
    );
    assert.equal(
      (await memory.search(owner, "release"))[0]!.why.usefulness,
      -0.2,
    );
    const db = new Database(path);
    try {
      assert.equal(
        (db.prepare("SELECT count(*) AS n FROM feedback").get() as any).n,
        2,
      );
      assert.equal(
        (db.prepare("SELECT version FROM memory_meta").get() as any).version,
        3,
      );
    } finally {
      db.close();
    }
    await memory.review(owner, item.id, edited.revision, {
      text: "release approved",
      approve: true,
    });
    assert.equal(
      (await memory.search(owner, "release"))[0]!.why.usefulness,
      0.2,
    );
    memory.forget(owner, item.id);
    const after = new Database(path);
    try {
      assert.equal(
        (after.prepare("SELECT count(*) AS n FROM feedback").get() as any).n,
        0,
      );
    } finally {
      after.close();
    }
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function legacy(path: string, vault: Vault) {
  const db = new Database(path);
  db.exec(`CREATE TABLE memory_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,verifier BLOB NOT NULL);
CREATE TABLE memory(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,pinned INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,payload BLOB NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(user_id,tenant_id,fingerprint));
CREATE TABLE feedback(memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,id TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(memory_id,id));`);
  db.prepare("INSERT INTO memory_meta VALUES(1,1,?)").run(
    vault.seal("bittrees-ai-memory", "memory-key"),
  );
  const payload = { ...candidate, expiresAt: null };
  db.prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "legacy",
    owner.userId,
    owner.tenantId,
    "approved",
    2,
    1,
    1000,
    1000,
    vault.seal(payload, "memory:legacy"),
    vault.fingerprint(payload),
  );
  db.prepare("INSERT INTO feedback VALUES(?,?,?,?)").run(
    "legacy",
    "legacy-rating",
    "accepted",
    1000,
  );
  db.close();
}
test("schema1 migration preserves all memory and legacy ratings but never invents a content association", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-legacy-")),
    path = join(dir, "memory.db"),
    vault = new Vault(randomBytes(32));
  legacy(path, vault);
  let memory: MemoryStore | undefined;
  try {
    assert.throws(
      () => new MemoryStore(path, new Vault(randomBytes(32)), async () => true),
    );
    memory = new MemoryStore(
      path,
      vault,
      async () => true,
      () => 1000,
    );
    const m = await memory.get(owner, "legacy");
    assert.equal(m.text, candidate.text);
    assert.equal(m.pinned, true);
    assert.equal(
      (await memory.search(owner, "art report"))[0]!.why.usefulness,
      0,
    );
    await assert.rejects(
      memory.feedback(owner, "legacy", "legacy-rating", "accepted", 2),
      /CONFLICT/,
    );
    await memory.feedback(owner, "legacy", "fresh-rating", "accepted", 2);
    assert.equal(
      (await memory.search(owner, "art report"))[0]!.why.usefulness,
      0.2,
    );
    memory.close();
    memory = undefined;
    const db = new Database(path);
    try {
      const rows = db
        .prepare("SELECT id,content_fingerprint FROM feedback ORDER BY id")
        .all() as any[];
      assert.equal(rows.length, 2);
      assert.ok(rows[0].content_fingerprint);
      assert.equal(rows[1].content_fingerprint, null);
    } finally {
      db.close();
    }
    assert.equal(readFileSync(path).includes(candidate.text), false);
    memory = new MemoryStore(path, vault, async () => false);
    assert.deepEqual(await memory.search(owner, "report"), []);
  } finally {
    memory?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failed memory migration rolls back its column and version without changing encrypted records", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-migration-")),
    path = join(dir, "memory.db"),
    vault = new Vault(randomBytes(32));
  legacy(path, vault);
  const db = new Database(path);
  try {
    const before = db.prepare("SELECT * FROM memory").all();
    db.exec(
      "CREATE TRIGGER reject_upgrade BEFORE UPDATE ON memory_meta BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    );
    assert.throws(
      () => new MemoryStore(path, vault, async () => true),
      /fixture rollback/,
    );
    assert.deepEqual(db.prepare("SELECT * FROM memory").all(), before);
    assert.equal(
      (db.prepare("SELECT version FROM memory_meta").get() as any).version,
      1,
    );
    assert.equal((db.pragma("table_info(feedback)") as any[]).length, 4);
    db.exec("DROP TRIGGER reject_upgrade");
    const memory = new MemoryStore(path, vault, async () => true);
    memory.close();
    assert.equal(
      (db.prepare("SELECT version FROM memory_meta").get() as any).version,
      3,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("memory feedback HTTP requires an authenticated current revision and still denies lost source access", async () => {
  let access = true;
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault),
    memory = new MemoryStore(":memory:", vault, async () => access),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  const item = await approved(memory, "release approved");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, memory, owner, token, port }));
  const url = `http://127.0.0.1:${port}/v1/memories/${item.id}/feedback`,
    headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
  const send = (body: unknown) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal(
      (await send({ id: "rating", outcome: "accepted" })).status,
      400,
    );
    assert.equal(
      (await send({ id: "rating", outcome: "accepted", revision: 1 })).status,
      409,
    );
    assert.equal(
      (
        await send({
          id: "rating",
          outcome: "accepted",
          revision: item.revision,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await send({
          id: "rating",
          outcome: "accepted",
          revision: item.revision,
        })
      ).status,
      204,
    );
    access = false;
    assert.equal(
      (
        await send({
          id: "denied",
          outcome: "accepted",
          revision: item.revision,
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    memory.close();
    store.close();
  }
});
