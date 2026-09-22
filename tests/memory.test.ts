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

test("editing approved memory without renewed approval returns it to review", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
  );
  try {
    const item = await memory.add(alice, candidate);
    const approved = await memory.review(alice, item.id, 1, { approve: true });
    const pinned = await memory.review(alice, item.id, approved.revision, {
      pinned: true,
    });
    assert.equal(pinned.state, "approved");
    const edited = await memory.review(alice, item.id, pinned.revision, {
      text: "Changed summaries",
    });
    assert.equal(edited.state, "candidate");
    assert.deepEqual(await memory.search(alice, "summaries"), []);
    await memory.review(alice, item.id, edited.revision, { approve: true });
    assert.equal(
      (await memory.search(alice, "summaries"))[0]!.text,
      "Changed summaries",
    );
  } finally {
    memory.close();
  }
});
test("memory get cannot return a snapshot edited, deleted or expired during its access check", async () => {
  for (const action of ["edit", "delete", "expire"]) {
    let now = 1000,
      hold = false,
      release!: (allowed: boolean) => void;
    const memory = new MemoryStore(
      ":memory:",
      new Vault(randomBytes(32)),
      async () =>
        hold
          ? new Promise<boolean>((r) => {
              release = r;
            })
          : true,
      () => now,
    );
    try {
      const item = await memory.add(alice, { ...candidate, expiresAt: 2000 });
      hold = true;
      const reading = memory.get(alice, item.id);
      hold = false;
      if (action === "edit")
        await memory.review(alice, item.id, 1, { text: "replacement" });
      else if (action === "delete") memory.forget(alice, item.id);
      else now = 2000;
      release(true);
      await assert.rejects(reading, /NOT_FOUND/);
    } finally {
      memory.close();
    }
  }
});
test("search excludes deletion during final access check and a prior result edited while a later result is checked", async () => {
  let checks = 0,
    heldAt = 0,
    release!: (allowed: boolean) => void;
  let visited: string[] = [];
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async (_owner, sources) => {
      visited.push(sources[0]!.resourceId);
      if (++checks === heldAt)
        return new Promise<boolean>((r) => {
          release = r;
        });
      return true;
    },
  );
  try {
    const a = await memory.add(alice, candidate);
    const b = await memory.add(alice, {
      ...candidate,
      text: "Other summaries with citations",
      sources: [{ ...candidate.sources[0], resourceId: "second" }],
    });
    await memory.review(alice, a.id, 1, { approve: true });
    await memory.review(alice, b.id, 1, { approve: true });
    checks = 0;
    heldAt = 4;
    visited = [];
    const searching = memory.search(alice, "summaries");
    // Two initial checks and the first final check resolve before the second final check waits.
    while (checks < 4) await new Promise<void>((r) => setImmediate(r));
    const earlier = visited[2] === "selected" ? a : b;
    const pending = earlier.id === a.id ? b : a;
    heldAt = 0;
    await memory.review(alice, earlier.id, 2, { text: "Changed summaries" });
    memory.forget(alice, pending.id);
    release(true);
    assert.deepEqual(await searching, []);
  } finally {
    memory.close();
  }
});
test("expiry during access checking cannot create or approve a memory", async () => {
  let now = 1000,
    hold = false,
    release!: (allowed: boolean) => void;
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () =>
      hold
        ? new Promise<boolean>((r) => {
            release = r;
          })
        : true,
    () => now,
  );
  try {
    hold = true;
    const adding = memory.add(alice, { ...candidate, expiresAt: 1500 });
    now = 1500;
    release(true);
    await assert.rejects(adding, /NOT_FOUND/);
    hold = false;
    now = 1000;
    const item = await memory.add(alice, { ...candidate, expiresAt: 1500 });
    hold = true;
    const reviewing = memory.review(alice, item.id, 1, { approve: true });
    now = 1500;
    release(true);
    await assert.rejects(reviewing, /NOT_FOUND/);
    hold = false;
    now = 1000;
    assert.equal((await memory.get(alice, item.id)).state, "candidate");
  } finally {
    memory.close();
  }
});

test("export removes an earlier snapshot deleted while another memory's access check waits", async () => {
  let hold = false,
    release!: (allowed: boolean) => void;
  const visited: string[] = [];
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async (_owner, sources) => {
      if (!hold) return true;
      visited.push(sources[0]!.resourceId);
      return visited.length === 2
        ? new Promise<boolean>((r) => {
            release = r;
          })
        : true;
    },
  );
  try {
    const a = await memory.add(alice, candidate);
    const b = await memory.add(alice, {
      ...candidate,
      sources: [{ ...candidate.sources[0], resourceId: "second" }],
    });
    hold = true;
    const exporting = memory.export(alice);
    while (visited.length < 2) await new Promise<void>((r) => setImmediate(r));
    const first = visited[0] === "selected" ? a : b;
    memory.forget(alice, first.id);
    release(true);
    const result = await exporting;
    assert.equal(result.length, 1);
    assert.notEqual(result[0]!.id, first.id);
  } finally {
    memory.close();
  }
});

test("worker does not send a stale approved memory to inference after an edit during access checking", async () => {
  const { Store } = await import("../modules/storage/store.js");
  const { LocalWorker } = await import("../apps/companion/worker.js");
  let hold = false,
    release!: (allowed: boolean) => void,
    began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  const memory = new MemoryStore(":memory:", vault, async () => {
    if (!hold) return true;
    began();
    return new Promise<boolean>((r) => {
      release = r;
    });
  });
  const profile = {
    id: "p",
    runtime: "ollama" as const,
    model: "synthetic",
    contextTokens: 2048,
    maxOutputTokens: 100,
    temperature: 0.2,
  };
  let generations = 0;
  const worker = new LocalWorker(
    store,
    alice,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () => {
        generations++;
        return "should not run";
      },
    },
    () => profile,
    "worker",
    memory,
  );
  try {
    const item = await memory.add(alice, candidate);
    await memory.review(alice, item.id, 1, { approve: true });
    const task = store.create(
      alice,
      {
        conversationId: "c",
        kind: "query",
        prompt: "Use summaries",
        modelProfileId: "p",
        memoryIds: [item.id],
      },
      "memory-race",
    );
    hold = true;
    const running = worker.runOnce();
    await started;
    hold = false;
    await memory.review(alice, item.id, 2, { text: "Changed private memory" });
    release(true);
    await running;
    assert.equal(generations, 0);
    assert.equal(store.get(alice, task.id).status, "failed");
    assert.equal(store.get(alice, task.id).result, null);
  } finally {
    memory.close();
    store.close();
  }
});

test("duplicate copies cannot crowd distinct text beyond the old hundred-match shortlist", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
    () => 1000,
  );
  try {
    for (let i = 0; i < 105; i++) {
      const item = await memory.add(alice, {
        ...candidate,
        text: "release build",
        sources: [{ ...candidate.sources[0], resourceId: `copy-${i}` }],
      });
      await memory.review(alice, item.id, 1, { approve: true });
    }
    const texts = [
      "release build requires source review",
      "release build needs a tested backup",
      "release build keeps task history",
    ];
    for (const text of texts) {
      const item = await memory.add(alice, { ...candidate, text });
      await memory.review(alice, item.id, 1, { approve: true });
    }
    const results = await memory.search(alice, "release build", 4);
    assert.deepEqual(
      new Set(results.map((r) => r.text)),
      new Set(["release build", ...texts]),
    );
    assert.equal(results.length, 4);
    assert.equal((await memory.export(alice)).length, 108);
    assert.deepEqual(await memory.search(bob, "release build"), []);
  } finally {
    memory.close();
  }
});
test("exact-text diversity retains different wording, negation, case, spacing and memory types", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
  );
  try {
    const entries = [
      { type: "fact", text: "release approved" },
      { type: "fact", text: "release not approved" },
      { type: "fact", text: "Release approved" },
      { type: "fact", text: "release  approved" },
      { type: "decision", text: "release approved" },
    ];
    for (const entry of entries) {
      const item = await memory.add(alice, { ...candidate, ...entry });
      await memory.review(alice, item.id, 1, { approve: true });
    }
    assert.equal(
      (await memory.search(alice, "release", 8)).length,
      entries.length,
    );
  } finally {
    memory.close();
  }
});
test("duplicate selection preserves only its own authorized provenance and falls back after revoked-copy access", async () => {
  let denied = "",
    finalChecks = 0,
    revokeOnFinal = false;
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async (_owner, sources) => {
      const id = sources[0]!.resourceId;
      if (revokeOnFinal && ++finalChecks === 3) denied = id;
      return id !== denied;
    },
  );
  try {
    for (const source of ["first", "second"]) {
      const item = await memory.add(alice, {
        ...candidate,
        sources: [{ ...candidate.sources[0], resourceId: source }],
      });
      await memory.review(alice, item.id, 1, { approve: true });
    }
    revokeOnFinal = true;
    const results = await memory.search(alice, "summaries");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.sources.length, 1);
    assert.notEqual(results[0]!.sources[0]!.resourceId, denied);
    assert.equal(results[0]!.verified, false);
  } finally {
    memory.close();
  }
});

test("source diversity improves coverage among equal matches without displacing a stronger query match", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
    () => 1000,
  );
  try {
    for (let i = 0; i < 16; i++) {
      const item = await memory.add(alice, {
        ...candidate,
        text: i === 15 ? "release unrelated" : `release build note ${i}`,
        sources: [
          {
            ...candidate.sources[0],
            resourceId: i < 12 ? "same" : `other-${i}`,
          },
        ],
      });
      await memory.review(alice, item.id, 1, {
        approve: true,
        pinned: i < 12 || i === 15,
      });
    }
    const results = await memory.search(alice, "release build", 4);
    assert.equal(results.length, 4);
    assert.equal(new Set(results.map((r) => r.sources[0]!.resourceId)).size, 4);
    assert.ok(results.every((r) => r.why.relevance === 1));
    assert.equal(results[0]!.why.pinned, true);
    const larger = await memory.search(alice, "release build", 8);
    assert.ok(
      larger
        .slice(4)
        .every((r) => r.why.sourcePenalty > 0 && r.why.sourcePenalty <= 2),
    );
    assert.equal((await memory.export(alice)).length, 16);
  } finally {
    memory.close();
  }
});
test("source repetition groups versions of the same resource and does not reward extra references", async () => {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
    () => 1000,
  );
  try {
    for (let i = 0; i < 4; i++) {
      const item = await memory.add(alice, {
        ...candidate,
        text: `release build ${i}`,
        sources: [
          { ...candidate.sources[0], revision: String(i + 1) },
          ...(i === 3
            ? [{ ...candidate.sources[0], resourceId: "extra" }]
            : []),
        ],
      });
      await memory.review(alice, item.id, 1, { approve: true });
    }
    const results = await memory.search(alice, "release build", 4);
    assert.deepEqual(
      results.map((r) => r.why.sourcePenalty),
      [0, 0.75, 1.5, 2],
    );
    assert.ok(results.every((r) => r.verified === false));
    const repeated = await memory.search(alice, "release build", 4);
    assert.deepEqual(
      repeated.map((r) => r.why.sourcePenalty),
      [0, 0.75, 1.5, 2],
    );
  } finally {
    memory.close();
  }
});
