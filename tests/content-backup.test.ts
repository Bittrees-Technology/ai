import { localMemoryAccess } from "../apps/companion/memory.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  createContentBackup,
  restoreContentBackup,
} from "../modules/storage/content-backup.js";
const owner = { userId: "alice", tenantId: "personal" };
const input = {
  conversationId: "c",
  kind: "query",
  prompt: "PRIVATE_TASK_CONTENT",
  modelProfileId: "p",
};
const memoryInput = {
  type: "preference",
  text: "PRIVATE_MEMORY_CONTENT",
  origin: "model",
  sources: [
    { app: "crm", tenantId: "personal", resourceId: "selected", revision: "1" },
  ],
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "content-backup-")),
    vault = new Vault(randomBytes(32));
  const tasks = new Store(join(dir, "tasks.db"), vault),
    memory = new MemoryStore(join(dir, "memory.db"), vault, async () => true);
  return {
    dir,
    vault,
    tasks,
    memory,
    close() {
      memory.close();
      tasks.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("coordinated content backup restores both stores into a fresh directory and clears remote consent", async () => {
  const f = fixture();
  let tasks: Store | undefined, memory: MemoryStore | undefined;
  try {
    const task = f.tasks.create(owner, input, "task");
    const claim = f.tasks.claim(owner, "seed")!;
    const completed = f.tasks.complete(
      owner,
      task.id,
      "seed",
      claim.generation,
      { text: "Synthetic local source" },
    );
    const item = await f.memory.add(owner, {
      ...memoryInput,
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: task.id,
          revision: String(completed.revision),
        },
      ],
    });
    await f.memory.review(owner, item.id, 1, { approve: true });
    f.tasks.db
      .prepare("INSERT INTO remote_control_bindings VALUES(?,?,?,?)")
      .run(
        owner.userId,
        owner.tenantId,
        "device",
        Buffer.from("synthetic-consent"),
      );
    f.tasks.db
      .prepare("INSERT INTO remote_template_permissions VALUES(?,?,?,?,?,?)")
      .run(
        "permission",
        owner.userId,
        owner.tenantId,
        "device",
        "template",
        Buffer.from("synthetic-consent"),
      );
    const file = join(f.dir, "content.aib");
    await createContentBackup(f.tasks, f.memory, f.vault, file);
    assert.equal(readFileSync(file).includes("PRIVATE_"), false);
    await assert.rejects(
      createContentBackup(f.tasks, f.memory, f.vault, file),
      /EEXIST/,
    );
    const target = await restoreContentBackup(file, f.vault, f.dir);
    assert.notEqual(target, f.dir);
    assert.ok(existsSync(join(target, "RECOVERY.json")));
    tasks = new Store(join(target, "tasks.db"), f.vault);
    memory = new MemoryStore(
      join(target, "memory.db"),
      f.vault,
      async () => false,
    );
    assert.equal(tasks.get(owner, task.id).input.prompt, input.prompt);
    await assert.rejects(memory.get(owner, item.id), /NOT_FOUND/);
    memory.close();
    memory = new MemoryStore(
      join(target, "memory.db"),
      f.vault,
      localMemoryAccess(tasks),
    );
    assert.equal((await memory.get(owner, item.id)).text, memoryInput.text);
    assert.equal(
      (
        tasks.db
          .prepare("SELECT count(*) n FROM remote_control_bindings")
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        tasks.db
          .prepare("SELECT payload FROM remote_template_permissions")
          .get() as { payload: Buffer | null }
      ).payload,
      null,
    );
    assert.equal(
      (
        f.tasks.db
          .prepare("SELECT count(*) n FROM remote_control_bindings")
          .get() as { n: number }
      ).n,
      1,
    );
    tasks.deleteAll(owner);
    await assert.rejects(memory.get(owner, item.id), /NOT_FOUND/);
  } finally {
    memory?.close();
    tasks?.close();
    f.close();
  }
});
test("writes during either snapshot reject the pair without publishing a backup; explicit retry succeeds", async () => {
  const f = fixture();
  try {
    for (const changed of ["tasks", "memory"]) {
      const target = join(f.dir, changed + ".aib");
      const memory = {
        changeToken: () => f.memory.changeToken(),
        backup: async (path: string) => {
          await f.memory.backup(path);
          if (changed === "tasks")
            f.tasks.create(owner, input, "concurrent-task");
          else await f.memory.add(owner, memoryInput);
        },
      };
      await assert.rejects(
        createContentBackup(f.tasks, memory, f.vault, target),
        /CONFLICT/,
      );
      assert.equal(existsSync(target), false);
      assert.equal(
        readdirSync(f.dir).some((name) =>
          name.startsWith(".bittrees-ai-content-backup-"),
        ),
        false,
      );
      await createContentBackup(f.tasks, f.memory, f.vault, target);
      assert.ok(existsSync(target));
    }
  } finally {
    f.close();
  }
});
test("wrong keys, tampering and invalid second snapshots leave no recovery directory or modified source stores", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "content.aib");
    await createContentBackup(f.tasks, f.memory, f.vault, file);
    const files = readdirSync(f.dir).sort();
    await assert.rejects(
      restoreContentBackup(file, new Vault(randomBytes(32)), f.dir),
    );
    assert.deepEqual(readdirSync(f.dir).sort(), files);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const tampered = join(f.dir, "tampered.aib");
    writeFileSync(tampered, bytes);
    await assert.rejects(restoreContentBackup(tampered, f.vault, f.dir));
    const envelope = f.vault.open<Record<string, unknown>>(
      readFileSync(file),
      "content-backup:v1",
    );
    envelope.memory = envelope.tasks;
    const invalid = join(f.dir, "invalid.aib");
    writeFileSync(invalid, f.vault.seal(envelope, "content-backup:v1"));
    await assert.rejects(restoreContentBackup(invalid, f.vault, f.dir));
    assert.equal(
      readdirSync(f.dir).some((name) =>
        name.startsWith("bittrees-ai-recovered-"),
      ),
      false,
    );
    assert.equal(f.tasks.list(owner).length, 0);
    assert.deepEqual(await f.memory.export(owner), []);
  } finally {
    f.close();
  }
});
