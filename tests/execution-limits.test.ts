import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ExecutionControls,
  defaultExecutionLimits,
} from "../apps/companion/execution-limits.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const owner = { userId: "synthetic", tenantId: "personal" };
const profile = {
  id: "p",
  runtime: "ollama" as const,
  model: "local",
  contextTokens: 2048,
  maxOutputTokens: 100,
  temperature: 0.2,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-limits-"));
  let free = 4 * 1024 ** 3;
  const controls = new ExecutionControls(join(dir, "limits.json"), () => free);
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  return {
    dir,
    controls,
    store,
    free: (n: number) => {
      free = n;
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function update(
  controls: ExecutionControls,
  limits: Partial<typeof defaultExecutionLimits>,
) {
  return controls.update({
    expectedRevision: controls.read().revision,
    confirmed: true,
    limits: { ...controls.read().limits, ...limits },
  });
}
function add(store: Store, key: string, conversationId = key, extra = {}) {
  return store.create(
    owner,
    {
      conversationId,
      kind: "query",
      prompt: "Synthetic input",
      modelProfileId: "p",
      ...extra,
    },
    key,
  );
}
async function until(f: () => boolean) {
  const end = Date.now() + 3000;
  while (!f()) {
    assert.ok(Date.now() < end, "condition did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("execution settings persist atomically with strict validation, revision conflicts and fail-closed loading", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.controls.read().limits, defaultExecutionLimits);
    const saved = update(f.controls, {
      parallelTasks: 3,
      maxTaskSeconds: 240,
      minFreeMemoryGiB: 2,
    });
    const path = join(f.dir, "limits.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(new ExecutionControls(path).read(), saved);
    assert.throws(
      () =>
        f.controls.update({
          expectedRevision: 0,
          confirmed: true,
          limits: defaultExecutionLimits,
        }),
      /CONFLICT/,
    );
    for (const limits of [
      { parallelTasks: 0 },
      { parallelTasks: 5 },
      { maxTaskSeconds: 0 },
      { maxTaskSeconds: 1801 },
      { minFreeMemoryGiB: -1 },
      { minFreeMemoryGiB: 0.5 },
      { endpoint: "https://acer.invalid" },
    ])
      assert.throws(() => update(f.controls, limits as any));
    assert.throws(() =>
      f.controls.update({
        expectedRevision: 1,
        confirmed: false,
        limits: defaultExecutionLimits,
      }),
    );
    const before = readFileSync(path, "utf8");
    const broken = new ExecutionControls(join(f.dir, "missing", "limits.json"));
    assert.throws(() => update(broken, { parallelTasks: 2 }));
    assert.equal(broken.read().revision, 0);
    assert.equal(readFileSync(path, "utf8"), before);
    symlinkSync(path, join(f.dir, "link"));
    assert.throws(() => new ExecutionControls(join(f.dir, "link")));
    writeFileSync(path, '{"version":2}');
    assert.throws(() => new ExecutionControls(path));
  } finally {
    f.cleanup();
  }
});
test("memory and pause admission hold queued tasks without attempts while deadlines and dependencies settle", async () => {
  const f = fixture();
  let calls = 0;
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => {
        calls++;
        return { profile, digest: "a".repeat(64) };
      },
      generate: async () => "result",
    },
    () => profile,
    "worker",
    undefined,
    undefined,
    f.controls,
  );
  try {
    const task = add(f.store, "held");
    update(f.controls, { minFreeMemoryGiB: 5 });
    assert.equal(f.controls.admission(0).reason, "low_memory");
    assert.equal(await worker.runOnce(), false);
    assert.equal(f.store.get(owner, task.id).status, "queued");
    assert.equal(f.store.runHistory(owner, task.id).length, 0);
    f.free(NaN);
    assert.equal(f.controls.admission(0).reason, "memory_unknown");
    assert.equal(await worker.runOnce(), false);
    update(f.controls, { pauseNewTasks: true });
    const expired = add(f.store, "expired", "expired", {
      deadline: new Date(Date.now() + 500).toISOString(),
    });
    const dependent = add(f.store, "dependent", "dependent", {
      dependencies: [expired.id],
    });
    // Advance the persisted deadline, without sleeping or changing the production clock.
    f.store.db
      .prepare("UPDATE tasks SET deadline=? WHERE id=?")
      .run(Date.now() - 1, expired.id);
    assert.equal(await worker.runOnce(), false);
    assert.equal(f.store.get(owner, expired.id).status, "expired");
    assert.equal(f.store.get(owner, dependent.id).status, "failed");
    assert.equal(calls, 0);
    update(f.controls, { pauseNewTasks: false, minFreeMemoryGiB: 0 });
    assert.equal(await worker.runOnce(), true);
    assert.equal(f.store.get(owner, task.id).status, "completed");
    assert.equal(calls, 1);
    const run = f.store.runHistory(owner, task.id)[0]!;
    assert.deepEqual(
      (run.model as any).executionLimits,
      f.controls.read().limits,
    );
  } finally {
    worker.stop();
    f.cleanup();
  }
});
test("bounded parallel tasks preserve conversation ordering, lower limits drain, cancellation and stop fence late results", async () => {
  const f = fixture();
  const finishes: ((s: string) => void)[] = [];
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () => new Promise<string>((r) => finishes.push(r)),
    },
    () => profile,
    "worker",
    undefined,
    undefined,
    f.controls,
  );
  const pending: Promise<boolean>[] = [];
  try {
    update(f.controls, { parallelTasks: 2 });
    const a = add(f.store, "a", "same"),
      b = add(f.store, "b", "same");
    pending.push(worker.runOnce());
    await until(() => finishes.length === 1);
    const c = add(f.store, "c", "other");
    pending.push(worker.runOnce());
    await until(() => finishes.length === 2);
    assert.equal(worker.activeTasks, 2);
    assert.equal(f.store.get(owner, a.id).status, "running");
    assert.equal(f.store.get(owner, b.id).status, "queued");
    assert.equal(f.store.get(owner, c.id).status, "running");
    assert.equal(await worker.runOnce(), false);
    update(f.controls, { parallelTasks: 1 });
    finishes[0]!("first");
    await pending[0];
    assert.equal(await worker.runOnce(), false);
    const current = f.store.get(owner, c.id);
    f.store.command(owner, c.id, {
      command: "cancel",
      expectedRevision: current.revision,
    });
    worker.cancel(c.id);
    finishes[1]!("late");
    await pending[1];
    assert.equal(f.store.get(owner, c.id).result, null);
    pending.push(worker.runOnce());
    await until(() => finishes.length === 3);
    worker.stop();
    finishes[2]!("late after stop");
    await pending[2];
    assert.equal(f.store.get(owner, b.id).result, null);
    assert.equal(await worker.runOnce(), false);
  } finally {
    worker.stop();
    for (const finish of finishes) finish("cleanup");
    await Promise.allSettled(pending);
    f.cleanup();
  }
});
test("whole-task timeout settles failure immediately, retains occupied slot and refuses non-cooperative late output", async () => {
  const f = fixture();
  let finish!: (s: string) => void;
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    },
    () => profile,
    "worker",
    undefined,
    undefined,
    f.controls,
  );
  let run: Promise<boolean> | undefined;
  try {
    update(f.controls, { maxTaskSeconds: 1 });
    const a = add(f.store, "slow");
    run = worker.runOnce();
    await until(() => !!finish);
    const b = add(f.store, "next");
    update(f.controls, { maxTaskSeconds: 100 });
    await until(() => f.store.get(owner, a.id).status === "failed");
    assert.equal(worker.activeTasks, 1);
    assert.equal(f.store.runHistory(owner, a.id)[0]!.outcome, "runtime_limit");
    assert.equal(await worker.runOnce(), false);
    assert.equal(f.store.get(owner, b.id).status, "queued");
    finish("late output");
    await run;
    assert.equal(f.store.get(owner, a.id).result, null);
    assert.equal(worker.activeTasks, 0);
    assert.equal(f.store.runHistory(owner, a.id).length, 1);
  } finally {
    worker.stop();
    finish?.("cleanup");
    await run;
    f.cleanup();
  }
});
test("execution HTTP controls require authentication, origin, explicit confirmation and current revision", async () => {
  const f = fixture(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: f.store,
      owner,
      token,
      port,
      executionControls: f.controls,
      activeTasks: () => 2,
    }),
  );
  const url = `http://127.0.0.1:${port}/v1/device/execution`;
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  const input = {
    expectedRevision: 0,
    confirmed: true,
    limits: { ...defaultExecutionLimits, parallelTasks: 2 },
  };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers, Origin: "https://evil.invalid" },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    assert.equal(f.controls.read().revision, 0);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...input, confirmed: false }),
        })
      ).status,
      400,
    );
    const saved = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("cache-control"), "no-store");
    assert.equal(((await saved.json()) as any).reason, "busy");
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      409,
    );
    assert.equal(
      ((await (await fetch(url, { headers })).json()) as any).revision,
      1,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.cleanup();
  }
});

test("an expired lease never duplicates a still-pending task in another local slot", async () => {
  const f = fixture();
  const finishes: ((s: string) => void)[] = [];
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () => new Promise<string>((r) => finishes.push(r)),
    },
    () => profile,
    "worker",
    undefined,
    undefined,
    f.controls,
  );
  const pending: Promise<boolean>[] = [];
  try {
    update(f.controls, { parallelTasks: 2 });
    const a = add(f.store, "expired-running");
    pending.push(worker.runOnce());
    await until(() => finishes.length === 1);
    f.store.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run(Date.now() - 1, a.id);
    assert.equal(await worker.runOnce(), false);
    assert.equal(f.store.runHistory(owner, a.id).length, 1);
    const b = add(f.store, "different-task");
    pending.push(worker.runOnce());
    await until(() => finishes.length === 2);
    assert.equal(f.store.get(owner, b.id).status, "running");
    assert.equal(worker.activeTasks, 2);
    finishes[0]!("stale");
    finishes[1]!("current");
    await Promise.all(pending);
    assert.equal(f.store.get(owner, a.id).result, null);
    assert.equal(f.store.get(owner, b.id).status, "completed");
  } finally {
    worker.stop();
    for (const finish of finishes) finish("cleanup");
    await Promise.allSettled(pending);
    f.cleanup();
  }
});
