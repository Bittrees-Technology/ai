import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, readdir, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createRecoveryKit } from "../modules/storage/recovery-kit.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
import { installRecoveredKey } from "../apps/companion/install-recovered-key.js";
const owner = { userId: "a", tenantId: "personal" };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "install-key-")),
    key = randomBytes(32),
    vault = new Vault(key),
    kit = createRecoveryKit(key);
  const current = join(base, "current"),
    copies = join(base, "copies");
  await mkdir(current);
  await mkdir(copies);
  const tasks = new Store(join(current, "tasks.db"), vault),
    memory = new MemoryStore(
      join(current, "memory.db"),
      vault,
      async () => true,
    );
  const backup = join(base, "content.aib");
  try {
    tasks.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "synthetic recovered key",
        modelProfileId: "p",
      },
      "seed",
    );
    await createContentBackup(tasks, memory, vault, backup);
  } finally {
    memory.close();
    tasks.close();
  }
  return {
    base,
    current,
    copies,
    key,
    vault,
    kit,
    backup,
    close: () => rm(base, { recursive: true, force: true }),
  };
}
test("verified key installation creates only a missing entry and preserves matching/conflicting entries", async () => {
  const f = await fixture();
  let saved: Uint8Array | undefined,
    adds = 0;
  const entry = {
    getSecret: async () => saved,
    addSecretIfAbsent: async (key: Uint8Array) => {
      adds++;
      if (saved) return false;
      saved = Uint8Array.from(key);
      return true;
    },
  };
  const run = () =>
    installRecoveredKey(
      f.backup,
      f.copies,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      entry,
      0,
    );
  try {
    const first = await run();
    assert.equal(first.keyStatus, "created");
    assert.equal(first.activated, false);
    assert.deepEqual(Buffer.from(saved!), f.key);
    const opened = new Store(
      join(first.directory, "tasks.db"),
      new Vault(Buffer.from(saved!)),
    );
    opened.close();
    const second = await run();
    assert.equal(second.keyStatus, "already-present");
    assert.equal(adds, 2);
    saved = randomBytes(32);
    const conflicting = Buffer.from(saved),
      before = await readdir(f.copies);
    await assert.rejects(run(), /EXISTING_KEY_CONFLICT/);
    assert.deepEqual(Buffer.from(saved), conflicting);
    assert.equal(adds, 2);
    assert.deepEqual(await readdir(f.copies), before);
  } finally {
    await f.close();
  }
});
test("backup mismatch, unreadable key store and current-data key mismatch cannot trigger installation", async () => {
  const f = await fixture();
  let adds = 0;
  const entry = {
    getSecret: async (): Promise<Uint8Array | undefined> => undefined,
    addSecretIfAbsent: async () => {
      adds++;
      return true;
    },
  };
  const run = (kit = f.kit, provider = entry) =>
    installRecoveredKey(
      f.backup,
      f.copies,
      f.current,
      kit.kit,
      kit.recoveryCode,
      provider,
      0,
    );
  try {
    await assert.rejects(
      run(createRecoveryKit(randomBytes(32))),
      /CURRENT_DATA_KEY_CONFLICT/,
    );
    await assert.rejects(
      run(f.kit, {
        ...entry,
        getSecret: async () => {
          throw Error("private provider detail");
        },
      }),
      /KEY_STORE_UNAVAILABLE/,
    );
    const other = createRecoveryKit(randomBytes(32));
    await assert.rejects(
      installRecoveredKey(
        f.backup,
        f.copies,
        join(f.base, "fresh-device"),
        other.kit,
        other.recoveryCode,
        entry,
        0,
      ),
      /BACKUP_RESTORE_FAILED/,
    );
    const foreignPath = join(f.base, "foreign-memory.db");
    const foreignMemory = new MemoryStore(
      foreignPath,
      new Vault(randomBytes(32)),
      async () => false,
    );
    foreignMemory.close();
    await copyFile(
      join(f.current, "memory.db"),
      join(f.base, "saved-memory.db"),
    );
    await copyFile(foreignPath, join(f.current, "memory.db"));
    await assert.rejects(run(), /CURRENT_DATA_KEY_CONFLICT/);
    await copyFile(
      join(f.base, "saved-memory.db"),
      join(f.current, "memory.db"),
    );
    // Import jobs are separate from the backup but must still decrypt before key installation.
    await mkdir(join(f.current, "model-imports"));
    const jobs = new Database(join(f.current, "model-imports", "jobs.db"));
    jobs.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,payload BLOB NOT NULL)");
    jobs
      .prepare("INSERT INTO jobs VALUES(?,?)")
      .run(
        "job",
        new Vault(randomBytes(32)).seal({ id: "job" }, "import-job:job"),
      );
    jobs.close();
    await assert.rejects(run(), /CURRENT_DATA_KEY_CONFLICT/);
    assert.equal(adds, 0);
    assert.deepEqual(await readdir(f.copies), []);
  } finally {
    await f.close();
  }
});
test("competing insertion and uncertain writes retain verified copies and never overwrite or roll back credentials", async () => {
  const f = await fixture();
  let saved: Uint8Array | undefined;
  try {
    const entry = {
      getSecret: async () => saved,
      addSecretIfAbsent: async () => {
        saved = randomBytes(32);
        return false;
      },
    };
    const conflict = await installRecoveredKey(
      f.backup,
      f.copies,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      entry,
      0,
    );
    assert.equal(conflict.keyStatus, "conflict");
    assert.ok((await readdir(conflict.directory)).includes("RECOVERY.json"));
    saved = undefined;
    const uncertain = await installRecoveredKey(
      f.backup,
      f.copies,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      {
        getSecret: entry.getSecret,
        addSecretIfAbsent: async (key) => {
          saved = Uint8Array.from(key);
          throw Error("lost acknowledgement");
        },
      },
      0,
    );
    assert.equal(uncertain.keyStatus, "unconfirmed");
    assert.deepEqual(Buffer.from(saved!), f.key);
    assert.ok((await readdir(uncertain.directory)).includes("RECOVERY.json"));
    const reconciled = await installRecoveredKey(
      f.backup,
      f.copies,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      { getSecret: entry.getSecret, addSecretIfAbsent: async () => false },
      0,
    );
    assert.equal(reconciled.keyStatus, "already-present");
    assert.equal((await readdir(f.copies)).length, 3);
  } finally {
    await f.close();
  }
});
test("occupied companion port blocks key installation before key-store access", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      installRecoveredKey(
        "missing",
        "missing",
        "missing",
        Buffer.alloc(0),
        "",
        {
          getSecret: async () => {
            assert.fail("no read");
          },
          addSecretIfAbsent: async () => {
            assert.fail("no write");
          },
        },
        (server.address() as AddressInfo).port,
      ),
      /COMPANION_RUNNING_OR_PORT_UNAVAILABLE/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
