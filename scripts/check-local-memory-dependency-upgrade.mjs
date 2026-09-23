import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv[2])
  throw Error(
    "Provide the extracted PR134 engine directory; run npm run build first.",
  );
const legacy = resolve(process.argv[2]);
const load = (root, name) =>
  import(pathToFileURL(join(root, "dist", name + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(repo, "modules/storage/store"),
  { MemoryStore: OldMemory } = await load(legacy, "modules/memory/store"),
  { MemoryStore: CurrentMemory } = await load(repo, "modules/memory/store"),
  { Vault } = await load(repo, "modules/storage/vault"),
  { LocalWorker } = await load(legacy, "apps/companion/worker"),
  { localMemoryAccess, localTaskDependencies } = await load(
    repo,
    "apps/companion/memory",
  );
const oldBackup = await load(legacy, "modules/storage/content-backup"),
  newBackup = await load(repo, "modules/storage/content-backup");
const dir = await mkdtemp(join(tmpdir(), "ai-local-dependency-upgrade-")),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "isolated" };
let old, memory, current, restored, restoredMemory, rollback, rollbackMemory;
try {
  old = new Old(join(dir, "tasks.db"), vault);
  memory = new OldMemory(join(dir, "memory.db"), vault, async () => true);
  assert.equal(old.db.pragma("user_version", { simple: true }), 20);
  const profile = old.addProfile(owner, {
    id: "p",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 8192,
    maxOutputTokens: 1000,
    temperature: 0,
  });
  const complete = async (memoryIds = []) => {
    const task = old.create(
      owner,
      {
        conversationId: randomUUID(),
        kind: "query",
        prompt: "Synthetic reference",
        modelProfileId: "p",
        memoryIds,
      },
      randomUUID(),
    );
    const w = new LocalWorker(
      old,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => "SYNTHETIC_DERIVED_CONTENT",
      },
      () => profile,
      "seed",
      memory,
    );
    await w.runOnce();
    w.stop();
    assert.equal(old.get(owner, task.id).status, "completed");
    return old.get(owner, task.id);
  };
  const add = async (task) => {
    const item = await memory.add(owner, {
      type: "fact",
      origin: "model",
      text: "SYNTHETIC_REFERENCE",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: task.id,
          revision: String(task.revision),
        },
      ],
    });
    return memory.review(owner, item.id, 1, { approve: true, pinned: true });
  };
  const source = await complete(),
    first = await add(source),
    derived = await complete([first.id]),
    second = await add(derived),
    child = await complete([second.id]);
  const review = old.taskFeedback.read(owner, child.id);
  old.taskFeedback.save(owner, child.id, {
    expectedTaskRevision: review.taskRevision,
    runId: review.runId,
    expectedReviewRevision: 0,
    operationId: randomUUID(),
    review: { outcome: "edited", note: "Synthetic review retained" },
    confirmed: true,
  });
  const before = old.export(owner),
    beforeMemory = await memory.export(owner);
  await oldBackup.createContentBackup(
    old,
    memory,
    vault,
    join(dir, "original.aib"),
  );
  old.close();
  old = undefined;
  memory.close();
  memory = undefined;
  assert.throws(
    () => new Current(join(dir, "tasks.db"), new Vault(randomBytes(32))),
    /key|authenticate/i,
  );
  current = new Current(join(dir, "tasks.db"), vault);
  memory = new CurrentMemory(
    join(dir, "memory.db"),
    vault,
    localMemoryAccess(current, () => memory),
  );
  assert.equal(current.db.pragma("user_version", { simple: true }), 21);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(await memory.export(owner), beforeMemory);
  assert.equal(localTaskDependencies(current, owner, child.id, memory), true);
  memory.forget(owner, first.id);
  assert.equal(
    localTaskDependencies(current, owner, derived.id, memory),
    false,
  );
  assert.equal(localTaskDependencies(current, owner, child.id, memory), false);
  assert.deepEqual(await memory.export(owner), []);
  assert.equal(
    current.taskFeedback.read(owner, child.id).review.note,
    "Synthetic review retained",
  );
  await newBackup.createContentBackup(
    current,
    memory,
    vault,
    join(dir, "updated.aib"),
  );
  const copy = await newBackup.restoreContentBackup(
    join(dir, "updated.aib"),
    vault,
    dir,
  );
  restored = new Current(join(copy, "tasks.db"), vault);
  restoredMemory = new CurrentMemory(
    join(copy, "memory.db"),
    vault,
    localMemoryAccess(restored, () => restoredMemory),
  );
  assert.equal(
    localTaskDependencies(restored, owner, child.id, restoredMemory),
    false,
  );
  assert.deepEqual(await restoredMemory.search(owner, "REFERENCE"), []);
  assert.deepEqual(restored.get(owner, child.id).result, child.result);
  assert.equal(
    restored.taskFeedback.read(owner, child.id).review.note,
    "Synthetic review retained",
  );
  restored.close();
  restored = undefined;
  restoredMemory.close();
  restoredMemory = undefined;
  current.close();
  current = undefined;
  memory.close();
  memory = undefined;
  for (const path of [join(dir, "tasks.db"), join(copy, "tasks.db")])
    assert.throws(() => new Old(path, vault), /Unsupported database version/);
  const original = await oldBackup.restoreContentBackup(
    join(dir, "original.aib"),
    vault,
    dir,
  );
  rollback = new Old(join(original, "tasks.db"), vault);
  rollbackMemory = new OldMemory(
    join(original, "memory.db"),
    vault,
    async () => true,
  );
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 20);
  assert.deepEqual(rollback.export(owner), before);
  assert.deepEqual(await rollbackMemory.export(owner), beforeMemory);
  const sha = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const receipt = {
    date: new Date().toISOString(),
    runtime: process.version,
    fromTaskSchema: 20,
    toTaskSchema: 21,
    memorySchema: 2,
    legacySourceCommit: "119571fe7ccb36ae349a20470bfab8cba568473c",
    legacyCompiledStoreSha256: await sha(
      join(legacy, "dist/modules/storage/store.js"),
    ),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "modules/storage/store.ts",
          "modules/memory/store.ts",
          "apps/companion/memory.ts",
        ].map(async (file) => [file, await sha(join(repo, file))]),
      ),
    ),
    checks: [
      "Actual prepared PR134 worker seeded a three-task/two-memory chain, exact used versions and a quality review.",
      "Wrong-key upgrade failed; task20 to21 preserved every task, result, memory revision, pin and approval.",
      "Deleting the ancestor memory denied both derived tasks and the remaining derived memory without deleting retained results/review.",
      "Coordinated encrypted backup/restore retained data and dependency denial.",
      "Actual prepared PR134 engine refused both upgraded and restored task21 stores.",
      "Original coordinated backup reopened separately through the actual older task20/memory2 helpers.",
    ],
    limits: [
      "Disposable synthetic data and fake inference only; no personal data/key access, installed app replacement or Acer change.",
      "Raw storage/backup preserves history; companion content APIs and worker enforce current local dependency checks.",
      "Original-backup rollback contains historical data and older access behavior, and does not carry forward later edits or deletions.",
      "External-source memories, independent/native/personal acceptance remain open.",
    ],
  };
  const output =
    process.argv[3] ??
    join(
      repo,
      "docs/evidence/local-memory-dependency-schema-compatibility-2026-09-23.json",
    );
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    "Actual prepared task20→21 preservation, dependency denial after restore, old-engine refusal and separate original-backup rollback passed.",
  );
} finally {
  old?.close();
  memory?.close();
  current?.close();
  restored?.close();
  restoredMemory?.close();
  rollback?.close();
  rollbackMemory?.close();
  await rm(dir, { recursive: true, force: true });
}
