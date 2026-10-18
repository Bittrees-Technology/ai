import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Vault } from "../modules/storage/vault.js";
import { AgentQueue } from "../modules/agents/queue.js";
import { AgentProfiles } from "../modules/agents/profiles.js";
import { MailDraftQueue } from "../modules/connectors/mail-draft-queue.js";
import { mailDigest } from "../modules/connectors/mail-draft-contract.js";
const request = () => ({
  contractVersion: "mail-draft-generation-v1",
  operationId: "a".repeat(64),
  policy: { id: "b".repeat(64), revision: 1 },
  sourceVersion: "c".repeat(64),
  deadline: Date.now() + 120000,
  mode: "draft",
  input: {
    instructions: "Answer hours only",
    facts: "Open Monday\u2028Closed Sunday",
    excluded: "No changes",
    subject: "Hours café 🌳",
    text: "When are you open?",
  },
});
async function setup() {
  const dir = await mkdtemp(tmpdir() + "/mail-queue-"),
    vault = new Vault(randomBytes(32));
  const queue = new AgentQueue(dir + "/queue.db", vault),
    profiles = new AgentProfiles(dir + "/profiles.db", vault);
  profiles.save({
    id: randomUUID(),
    name: "Mail",
    role: "Draft",
    methodology: "Approved facts only",
    knowledge: [],
    provider: "local",
    modelProfileId: "local",
  });
  profiles.bind({ workflow: "mail-draft", profile: profiles.list()[0]!.id });
  let enabled = true,
    allowed = true,
    calls = 0,
    handler: ((signal: AbortSignal) => Promise<string>) | undefined;
  const runtime: any = {
    pin: async () => ({
      profile: { model: "synthetic-local" },
      digest: "d".repeat(64),
    }),
    generate: async (_m: unknown, _p: string, signal: AbortSignal) => {
      calls++;
      if (handler) return handler(signal);
      return calls % 2
        ? JSON.stringify({
            decision: "reply",
            text: "Open Monday",
            factIds: [1],
          })
        : JSON.stringify({
            withinScope: true,
            supported: true,
            needsReview: false,
          });
    },
  };
  const options = {
    enabled: () => enabled,
    authorize: () => (allowed ? "reviewed-epoch" : null),
  };
  const make = () =>
    new MailDraftQueue(
      dir + "/drafts.db",
      vault,
      queue,
      profiles,
      runtime,
      () => ({}),
      options,
    );
  const adapter = make();
  return {
    dir,
    vault,
    adapter,
    queue,
    profiles,
    make,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    setHandler: (h: typeof handler) => {
      handler = h;
    },
    calls: () => calls,
    cleanup: async (closeAdapter = true) => {
      if (closeAdapter) await adapter.close();
      await queue.close();
      profiles.close();
      await rm(dir, { recursive: true });
    },
  };
}
test("shared queue creates bound encrypted durable draft, replay never regenerates", async () => {
  const f = await setup();
  try {
    const r = request();
    const a = await f.adapter.generate(r);
    assert.equal(a.status, "draft");
    assert.equal(a.evidence.modelDigest, "d".repeat(64));
    assert.equal(a.evidence.profileRevision, f.profiles.snapshot(f.profiles.resolve("mail-draft")).revision);
    assert.equal(a.requestDigest, mailDigest(r));
    assert.equal(f.calls(), 2);
    assert.deepEqual(await f.adapter.generate(r), a);
    assert.equal(f.calls(), 2);
    await assert.rejects(
      f.adapter.generate({ ...r, sourceVersion: "d".repeat(64) }),
    );
    f.setAllowed(false);
    await assert.rejects(f.adapter.generate(r));
  } finally {
    await f.cleanup();
  }
});
test("disabled, cloud profile, expired and extra send scope are denied before model", async () => {
  const f = await setup();
  try {
    f.setEnabled(false);
    await assert.rejects(f.adapter.generate(request()));
    f.setEnabled(true);
    await assert.rejects(f.adapter.generate({ ...request(), send: true }));
    await assert.rejects(f.adapter.generate({ ...request(), deadline: 0 }));
    f.profiles.save({ ...f.profiles.list()[0]!, provider: "openrouter" });
    await assert.rejects(f.adapter.generate(request()));
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});
test("same-model review denial returns no draft text or fact IDs", async () => {
  const f = await setup();
  let count = 0;
  f.setHandler(async () =>
    ++count === 1
      ? JSON.stringify({ decision: "reply", text: "Open Monday", factIds: [1] })
      : JSON.stringify({
          withinScope: false,
          supported: false,
          needsReview: true,
        }),
  );
  try {
    const result = await f.adapter.generate(request());
    assert.equal(result.status, "needs-review");
    assert.equal(result.text, "");
    assert.deepEqual(result.factIds, []);
  } finally {
    await f.cleanup();
  }
});
test("cancel does not release shared queue until active model settles; late output discarded", async () => {
  const f = await setup();
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  const block = new Promise<void>((r) => {
    release = r;
  });
  f.setHandler(async () => {
    started();
    await block;
    return JSON.stringify({
      decision: "reply",
      text: "Open Monday",
      factIds: [1],
    });
  });
  try {
    const r = request(),
      pending = f.adapter.generate(r);
    await running;
    f.adapter.cancel(r.operationId);
    let next = false;
    const other = f.queue.run(
      "Other workflow",
      new AbortController().signal,
      async () => {
        next = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(next, false);
    release();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.text, "");
    await other;
    assert.equal(next, true);
  } finally {
    release?.();
    await f.cleanup();
  }
});
test("revocation or profile change during generation discards output", async () => {
  for (const change of ["authority", "profile"]) {
    const f = await setup();
    f.setHandler(async () => {
      if (change === "authority") f.setAllowed(false);
      else
        f.profiles.save({ ...f.profiles.list()[0]!, methodology: "changed" });
      return JSON.stringify({
        decision: "reply",
        text: "Open Monday",
        factIds: [1],
      });
    });
    try {
      const r = await f.adapter.generate(request());
      assert.equal(r.status, "failed");
      assert.equal(r.text, "");
    } finally {
      await f.cleanup();
    }
  }
});
test("Python and TypeScript canonical UTF8 request hashes match", () => {
  const r = request();
  const py = spawnSync(
    "python3",
    [
      "-c",
      'import sys,json,hashlib; v=json.load(sys.stdin); print(hashlib.sha256(json.dumps(v,sort_keys=True,separators=(\",\",\":\"),ensure_ascii=False).encode()).hexdigest())',
    ],
    { input: JSON.stringify(r), encoding: "utf8" },
  );
  assert.equal(py.status, 0, py.stderr);
  assert.equal(mailDigest(r), py.stdout.trim());
});

test("confirmed draft replay survives restart without another model call", async () => {
  const f = await setup(),
    r = request();
  const first = await f.adapter.generate(r);
  await f.adapter.close();
  const reopened = f.make();
  try {
    assert.deepEqual(await reopened.generate(r), first);
    assert.equal(f.calls(), 2);
  } finally {
    await reopened.close();
    await f.cleanup(false);
  }
});
test("deadline while queued cancels without invoking model", async () => {
  const f = await setup();
  f.queue.pause();
  try {
    const r = { ...request(), deadline: Date.now() + 30 };
    const result = await f.adapter.generate(r);
    assert.equal(result.status, "cancelled");
    assert.equal(f.calls(), 0);
    assert.equal(result.text, "");
  } finally {
    await f.cleanup();
  }
});

test("checked-in v1 fixture matches canonical hash and Python caller contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/mail-draft-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(mailDigest(fixture.request), fixture.result.requestDigest);
});

test("interrupted encrypted operation is held after restart, never replayed", async () => {
  const f = await setup(),
    r = request();
  await f.adapter.close();
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(f.dir + "/drafts.db");
  const row = {
    id: r.operationId,
    requestDigest: mailDigest(r),
    state: "running",
    profileRevision: f.profiles.snapshot(f.profiles.resolve("mail-draft"))
      .revision,
    authorityEpoch: "reviewed-epoch",
  };
  db.prepare("INSERT INTO mail_drafts VALUES(?,?)").run(
    row.id,
    f.vault.seal(row, "mail-draft:" + row.id),
  );
  db.close();
  const reopened = f.make();
  try {
    await assert.rejects(reopened.generate(r), /reconciliation/);
    assert.equal(f.calls(), 0);
  } finally {
    await reopened.close();
    await f.cleanup(false);
  }
});
test("unpaired surrogate and out-of-contract Unicode lengths are rejected", async () => {
  const f = await setup();
  try {
    const r = request();
    await assert.rejects(
      f.adapter.generate({
        ...r,
        input: { ...r.input, text: "bad" + String.fromCharCode(0xd800) },
      }),
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});

 test("revocation after queue callback before persistence discards draft", async () => {
  const f = await setup();
  const original = f.queue.run.bind(f.queue);
  f.queue.run = ((label: any, signal: any, callback: any) =>
    original(label, signal, async (innerSignal) => {
      const value = await callback(innerSignal);
      f.setAllowed(false);
      return value;
    })) as typeof f.queue.run;
  try {
    const result = await f.adapter.generate(request());
    assert.equal(result.status, "failed");
    assert.equal(result.text, "");
    assert.deepEqual(result.factIds, []);
  } finally { await f.cleanup(); }
});
