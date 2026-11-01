import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { TaskSyncRunBudget } from "../modules/task-sync/run-budget.js";
import { Vault } from "../modules/storage/vault.js";

function fixture(overrides = {}) {
  const db = new Database(":memory:"),
    vault = new Vault(randomBytes(32));
  db.exec("CREATE TABLE budget(value BLOB NOT NULL)");
  let now = 1000;
  const store = {
    read() {
      const row = db.prepare("SELECT value FROM budget").get() as
        { value: Buffer } | undefined;
      return row ? vault.open(row.value, "test") : null;
    },
    write(s: unknown) {
      db.prepare("DELETE FROM budget").run();
      db.prepare("INSERT INTO budget VALUES(?)").run(vault.seal(s, "test"));
    },
    atomic<T>(f: () => T) {
      return db.transaction(f).immediate();
    },
  };
  const review = {
    version: 1,
    confirmed: true,
    runId: randomUUID(),
    scopeDigest: "a".repeat(64),
    issuedAt: now,
    expiresAt: now + 10000,
    maxWorkAttempts: 2,
    maxRequests: 3,
    maxRequestBytes: 2000,
    maxResponseBytes: 2000,
    requestsByKind: {
      source: 3,
      connect: 0,
      execute: 0,
      preview: 0,
      owner: 0,
      attestation: 3,
      status: 0,
    },
    ...overrides,
  };
  const create = () => new TaskSyncRunBudget(store, () => now);
  return {
    db,
    store,
    review,
    create,
    advance: (n: number) => (now += n),
    scope: review.scopeDigest,
  };
}

test("missing budget denies all dispatch; persisted reservations are never refunded or replaced", async () => {
  const f = fixture();
  let calls = 0;
  try {
    let b = f.create();
    const run = () =>
      b.fetch(
        (async () => {
          calls++;
          throw Error("lost reply");
        }) as typeof fetch,
        () => f.scope,
        () => "source",
      )("https://example.invalid");
    await assert.rejects(run, /separately reviewed/);
    assert.equal(calls, 0);
    b.bind(f.review);
    for (let n = 0; n < 3; n++) {
      await assert.rejects(run, /lost reply/);
      b = f.create();
      b.bind(f.review);
    }
    await assert.rejects(run, /budget exhausted/);
    assert.equal(calls, 3);
    assert.equal(b.snapshot()?.requests, 3);
    assert.throws(
      () => b.bind({ ...f.review, maxRequests: 4 }),
      /cannot be replaced/,
    );
    b = f.create();
    assert.throws(() => b.reserve(f.scope, "source", 0), /budget exhausted/);
  } finally {
    f.db.close();
  }
});

for (const reason of ["scope", "clock", "deadline", "invalid state"])
  test(reason + " fails closed across restart", () => {
    const f = fixture();
    try {
      let b = f.create();
      b.bind(f.review);
      if (reason === "clock") f.advance(-1);
      if (reason === "deadline") f.advance(10000);
      if (reason === "invalid state")
        f.store.write({ ...b.snapshot(), requests: -1 });
      assert.throws(() =>
        b.beginWork(reason === "scope" ? "b".repeat(64) : f.scope),
      );
      b = f.create();
      assert.throws(() => b.beginWork(f.scope));
    } finally {
      f.db.close();
    }
  });

test("shared immediate transactions prevent two clients spending the last request", () => {
  const f = fixture({ maxRequests: 1 });
  try {
    const a = f.create(),
      b = f.create();
    a.bind(f.review);
    a.reserve(f.scope, "source", 10);
    assert.throws(() => b.reserve(f.scope, "source", 10), /exhausted/);
    assert.equal(a.snapshot()?.requests, 1);
  } finally {
    f.db.close();
  }
});

test("response bytes are checked before oversized content is released", async () => {
  const f = fixture({ maxResponseBytes: 100 });
  try {
    const b = f.create();
    b.bind(f.review);
    const response = await b.fetch(
      (async () => new Response("x".repeat(101))) as typeof fetch,
      () => f.scope,
      () => "source",
    )("https://example.invalid");
    await assert.rejects(() => response.text(), /response-byte budget/);
    assert.throws(() => f.create().beginWork(f.scope), /response-byte budget/);
  } finally {
    f.db.close();
  }
});

test("abort bounds opaque callbacks, stalled headers and stalled response bodies", async () => {
  const f = fixture();
  try {
    const b = f.create();
    b.bind(f.review);
    let c = new AbortController(),
      observed: AbortSignal | undefined;
    const opaque = b.value(
      f.scope,
      "attestation",
      {},
      async (signal) => {
        observed = signal;
        return new Promise(() => {});
      },
      c.signal,
    );
    c.abort();
    await assert.rejects(() => opaque, /interrupted/);
    assert.equal(observed?.aborted, true);
    c = new AbortController();
    const headers = b.fetch(
      (async () => new Promise(() => {})) as typeof fetch,
      () => f.scope,
      () => "source",
    )("https://example.invalid", { signal: c.signal });
    c.abort();
    await assert.rejects(() => headers, /interrupted/);
    c = new AbortController();
    const response = await b.fetch(
      (async () =>
        new Response(
          new ReadableStream({ pull: () => new Promise(() => {}) }),
        )) as typeof fetch,
      () => f.scope,
      () => "source",
    )("https://example.invalid", { signal: c.signal });
    const body = response.text();
    c.abort();
    await assert.rejects(() => body, /interrupted/);
    assert.equal(b.snapshot()?.requests, 3);
  } finally {
    f.db.close();
  }
});
