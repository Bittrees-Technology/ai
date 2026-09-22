import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { MemoryStore } from "../modules/memory/store.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  encryptedBackup,
  encryptedMemoryBackup,
  restoreBackup,
  restoreMemoryBackup,
} from "../modules/storage/backup.js";
const owner = { userId: "alice", tenantId: "home" };
const candidate = {
  type: "preference",
  text: "PRIVATE_MEMORY_SENTINEL concise summaries",
  origin: "model",
  sources: [
    { app: "crm", tenantId: "home", resourceId: "selected", revision: "1" },
  ],
};
test("memory backup preserves reviewed history while restored source access remains separately enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-backup-")),
    vault = new Vault(randomBytes(32));
  const memory = new MemoryStore(
    join(dir, "original.db"),
    vault,
    async () => true,
  );
  let restored: MemoryStore | undefined;
  try {
    const item = await memory.add(owner, candidate);
    await memory.review(owner, item.id, 1, { approve: true, pinned: true });
    await memory.feedback(owner, item.id, "feedback-1", "accepted");
    const before = await memory.get(owner, item.id),
      rankBefore = await memory.search(owner, "concise");
    const archive = join(dir, "backup.enc");
    await encryptedMemoryBackup(memory, vault, archive);
    assert.equal(readFileSync(archive).includes(candidate.text), false);
    await assert.rejects(
      restoreBackup(archive, vault, join(dir, "wrong-kind.db")),
    );
    await assert.rejects(
      restoreMemoryBackup(
        archive,
        new Vault(randomBytes(32)),
        join(dir, "wrong-key.db"),
      ),
    );
    assert.equal(existsSync(join(dir, "wrong-key.db")), false);
    let access = false;
    const destination = join(dir, "restored.db");
    await restoreMemoryBackup(archive, vault, destination);
    restored = new MemoryStore(destination, vault, async () => access);
    assert.deepEqual(await restored.search(owner, "concise"), []);
    await assert.rejects(restored.get(owner, item.id), /NOT_FOUND/);
    access = true;
    assert.deepEqual(await restored.get(owner, item.id), before);
    assert.equal(
      (await restored.search(owner, "concise"))[0]!.why.usefulness,
      rankBefore[0]!.why.usefulness,
    );
    await assert.rejects(
      restored.get({ ...owner, userId: "bob" }, item.id),
      /NOT_FOUND/,
    );
    await assert.rejects(
      restoreMemoryBackup(archive, vault, destination),
      /EEXIST/,
    );
  } finally {
    restored?.close();
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("memory restore rejects wrong store payloads and sidecars without publishing or overwriting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-restore-boundary-")),
    vault = new Vault(randomBytes(32));
  const tasks = new Store(join(dir, "tasks.db"), vault),
    memory = new MemoryStore(join(dir, "memory.db"), vault, async () => true);
  try {
    const taskArchive = join(dir, "tasks.enc"),
      archive = join(dir, "memory.enc");
    await encryptedBackup(tasks, vault, taskArchive);
    await encryptedMemoryBackup(memory, vault, archive);
    await assert.rejects(
      restoreMemoryBackup(taskArchive, vault, join(dir, "task-as-memory.db")),
    );
    // Even authenticated envelopes must contain the declared database kind.
    const taskEnvelope = vault.open<{ sqlite: string }>(
      readFileSync(taskArchive),
      "backup:v1",
    );
    const mislabeled = join(dir, "mislabeled.enc");
    writeFileSync(
      mislabeled,
      vault.seal(
        { version: 2, kind: "memory", sqlite: taskEnvelope.sqlite },
        "backup:v1",
      ),
    );
    const target = join(dir, "mislabeled.db");
    await assert.rejects(
      restoreMemoryBackup(mislabeled, vault, target),
      /kind mismatch/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(
      readdirSync(dir).some((p) => p.startsWith(".bittrees-ai-restore-")),
      false,
    );
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const destination = join(dir, "restore" + suffix + ".db"),
        sidecar = destination + suffix;
      writeFileSync(sidecar, "preserve");
      await assert.rejects(
        restoreMemoryBackup(archive, vault, destination),
        /EEXIST/,
      );
      assert.equal(readFileSync(sidecar, "utf8"), "preserve");
      assert.equal(existsSync(destination), false);
    }
  } finally {
    memory.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
