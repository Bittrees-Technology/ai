/** One preservation/rollback journey using the actual previous task38/memory2 writer. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  symlink,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const ref = "d9865a7af12bfee5524c9e88df2bdc9d40025e4d";
const dir = await mkdtemp(join(tmpdir(), "bittrees-memory-upgrade-"));
const openStores = [];
const load = (base, file) =>
  import(pathToFileURL(join(base, "dist", file + ".js")).href);
try {
  const legacy = join(dir, "legacy");
  await mkdir(legacy);
  const archive = execFileSync(
    "git",
    [
      "archive",
      ref,
      "modules",
      "apps",
      "scripts",
      "tests",
      "package.json",
      "tsconfig.json",
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    "825d6f123c46f4791b47acfae83b37119d26f21049b2a2efc5471e8252010a87",
  );
  execFileSync("tar", ["-x", "-C", legacy], { input: archive });
  await symlink(join(root, "node_modules"), join(legacy, "node_modules"));
  execFileSync(join(root, "node_modules/.bin/tsc"), [], {
    cwd: legacy,
    stdio: "inherit",
  });
  const { Store: OldStore } = await load(legacy, "modules/storage/store");
  const { MemoryStore: OldMemory } = await load(legacy, "modules/memory/store");
  const oldBackup = await load(legacy, "modules/storage/backup");
  const { Store } = await load(root, "modules/storage/store");
  const { MemoryStore } = await load(root, "modules/memory/store");
  const { Vault } = await load(root, "modules/storage/vault");
  const backup = await load(root, "modules/storage/backup");
  const vault = new Vault(randomBytes(32)),
    owner = { userId: "synthetic", tenantId: "home" };
  const taskPath = join(dir, "tasks.db"),
    memoryPath = join(dir, "memory.db");
  const oldTasks = new OldStore(taskPath, vault),
    oldMemories = new OldMemory(memoryPath, vault, async () => true);
  const task = oldTasks.create(
    owner,
    {
      conversationId: "preserve",
      kind: "query",
      prompt: "SYNTHETIC_TASK_PRESERVED",
      modelProfileId: "local",
    },
    "preserve",
  );
  const candidate = {
    type: "preference",
    text: "SYNTHETIC_MEMORY_PRESERVED",
    origin: "user",
    sources: [
      { app: "local", tenantId: "home", resourceId: task.id, revision: "1" },
    ],
  };
  const added = await oldMemories.add(owner, candidate);
  await oldMemories.review(owner, added.id, 1, { approve: true, pinned: true });
  await oldMemories.feedback(owner, added.id, "review", "accepted");
  const before = await oldMemories.get(owner, added.id),
    rank = await oldMemories.search(owner, "SYNTHETIC_MEMORY_PRESERVED");
  assert.equal(oldTasks.db.pragma("user_version", { simple: true }), 38);
  await oldBackup.encryptedBackup(oldTasks, vault, join(dir, "old-tasks.enc"));
  await oldBackup.encryptedMemoryBackup(
    oldMemories,
    vault,
    join(dir, "old-memory.enc"),
  );
  oldTasks.close();
  oldMemories.close();
  const tasks = new Store(taskPath, vault),
    memories = new MemoryStore(memoryPath, vault, async () => true);
  openStores.push(tasks, memories);
  assert.equal(tasks.db.pragma("user_version", { simple: true }), 39);
  assert.deepEqual(tasks.get(owner, task.id), task);
  assert.deepEqual(await memories.get(owner, added.id), {
    ...before,
    useApps: ["local"],
  });
  assert.equal((await memories.add(owner, candidate)).id, added.id);
  assert.equal(
    (await memories.search(owner, "SYNTHETIC_MEMORY_PRESERVED"))[0].why
      .usefulness,
    rank[0].why.usefulness,
  );
  assert.throws(
    () => new OldStore(taskPath, vault),
    /Unsupported database version/,
  );
  assert.throws(
    () => new OldMemory(memoryPath, vault, async () => true),
    /Unsupported memory store/,
  );
  const allowed = await memories.review(owner, added.id, before.revision, {
    useApps: ["local", "autonote"],
    scopeConfirmed: true,
  });
  await backup.encryptedMemoryBackup(
    memories,
    vault,
    join(dir, "scoped-memory.enc"),
  );
  await backup.restoreMemoryBackup(
    join(dir, "scoped-memory.enc"),
    vault,
    join(dir, "restored-memory.db"),
  );
  const restored = new MemoryStore(
    join(dir, "restored-memory.db"),
    vault,
    async () => true,
  );
  openStores.push(restored);
  const restoredItem = await restored.get(owner, added.id);
  assert.equal(restoredItem.text, candidate.text);
  assert.equal(restoredItem.pinned, true);
  assert.deepEqual(restoredItem.useApps, ["local"]);
  assert.equal(restoredItem.revision, allowed.revision + 1);
  assert.throws(
    () => restored.dependencySources(owner, added.id, undefined, "autonote"),
    /NOT_FOUND/,
  );
  // The old retained copies remain usable with the actual old writer for rollback.
  await oldBackup.restoreBackup(
    join(dir, "old-tasks.enc"),
    vault,
    join(dir, "rollback-tasks.db"),
  );
  await oldBackup.restoreMemoryBackup(
    join(dir, "old-memory.enc"),
    vault,
    join(dir, "rollback-memory.db"),
  );
  const rollbackTasks = new OldStore(join(dir, "rollback-tasks.db"), vault),
    rollbackMemory = new OldMemory(
      join(dir, "rollback-memory.db"),
      vault,
      async () => true,
    );
  openStores.push(rollbackTasks, rollbackMemory);
  assert.deepEqual(rollbackTasks.get(owner, task.id), task);
  assert.deepEqual(await rollbackMemory.get(owner, added.id), before);
  assert.equal(
    (await readFile(join(dir, "scoped-memory.enc"))).includes(candidate.text),
    false,
  );
  const result = {
    passed: true,
    legacyRef: ref,
    legacyArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    tasks: "38→39",
    memory: "2→3",
    verified: [
      "unchanged task/content/review/pin/feedback preserved",
      "duplicate candidate retains original ID",
      "actual old writers refuse upgraded stores",
      "restored cross-app permission denied",
      "separate old backups remain valid for rollback",
    ],
  };
  if (process.argv[2]) {
    await mkdir(dirname(process.argv[2]), { recursive: true });
    await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result));
} finally {
  for (const store of openStores.reverse()) store.close();
  await rm(dir, { recursive: true, force: true });
}
