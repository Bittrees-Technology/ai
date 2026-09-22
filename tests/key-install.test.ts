import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  mkdtemp,
  rm,
  readdir,
  mkdir,
  copyFile,
  writeFile,
  symlink,
} from "node:fs/promises";
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
import {
  installRecoveredKey,
  recoverAndActivateWithKit,
} from "../apps/companion/install-recovered-key.js";
import { resolveActiveContent } from "../apps/companion/active-content.js";
import { recoverKitRequest } from "../apps/companion/kit-recovery.js";
import { spawnSync } from "node:child_process";
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

test("kit recovery selects verified task and memory data on a fresh device and retains earlier content", async () => {
  const f = await fixture();
  let saved: Uint8Array | undefined;
  const entry = {
    getSecret: async () => saved,
    addSecretIfAbsent: async (key: Uint8Array) => {
      if (saved) return false;
      saved = Uint8Array.from(key);
      return true;
    },
  };
  const target = join(f.base, "fresh-device"),
    kitFile = join(f.base, "key.btkey");
  try {
    const tasks = new Store(join(f.current, "tasks.db"), f.vault);
    const memory = new MemoryStore(
      join(f.current, "memory.db"),
      f.vault,
      async () => true,
    );
    const item = await memory.add(owner, {
      type: "preference",
      text: "Synthetic recovery memory",
      origin: "user",
      sources: [
        {
          app: "local",
          tenantId: "personal",
          resourceId: "seed",
          revision: "1",
        },
      ],
    });
    const secondBackup = join(f.base, "with-memory.aib");
    await createContentBackup(tasks, memory, f.vault, secondBackup);
    memory.close();
    tasks.close();
    await writeFile(kitFile, f.kit.kit);
    const result = await recoverKitRequest(
      {
        operation: "recover-with-kit-v1",
        confirmed: true,
        kit: kitFile,
        backup: secondBackup,
        code: f.kit.recoveryCode,
      },
      target,
      entry,
      0,
    );
    assert.deepEqual(result, {
      version: 1,
      activated: true,
      keyStatus: "created",
    });
    const first = await resolveActiveContent(target);
    const opened = new Store(join(first.directory, "tasks.db"), f.vault);
    const openedMemory = new MemoryStore(
      join(first.directory, "memory.db"),
      f.vault,
      async () => true,
    );
    assert.equal(
      opened.list(owner)[0]!.input.prompt,
      "synthetic recovered key",
    );
    assert.equal(
      (await openedMemory.get(owner, item.id)).text,
      "Synthetic recovery memory",
    );
    openedMemory.close();
    opened.close();
    const next = await recoverAndActivateWithKit(
      f.backup,
      target,
      f.kit.kit,
      f.kit.recoveryCode,
      entry,
      0,
    );
    assert.equal(next.activated, true);
    assert.equal(next.keyStatus, "already-present");
    const current = await resolveActiveContent(target);
    assert.equal(current.previous, first.name);
    assert.ok((await readdir(first.directory)).includes("memory.db"));
    assert.deepEqual(Buffer.from(saved!), f.key);
  } finally {
    await f.close();
  }
});
test("native recovery protocol rejects unconfirmed, injected, malformed and symlink input before key access", async () => {
  const f = await fixture();
  let reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return undefined;
    },
    addSecretIfAbsent: async () => {
      assert.fail("no writes");
    },
  };
  try {
    const kit = join(f.base, "kit.btkey"),
      linked = join(f.base, "linked.btkey");
    await writeFile(kit, f.kit.kit);
    await symlink(kit, linked);
    const value = {
      operation: "recover-with-kit-v1",
      confirmed: true,
      kit,
      backup: f.backup,
      code: f.kit.recoveryCode,
    };
    for (const change of [
      { confirmed: false },
      { base: f.base },
      { helper: "/other" },
      { code: "wrong" },
      { kit: "relative" },
      { kit: linked },
    ])
      await assert.rejects(
        recoverKitRequest({ ...value, ...change }, f.current, entry, 0),
      );
    await writeFile(kit, Buffer.alloc(117));
    await assert.rejects(recoverKitRequest(value, f.current, entry, 0));
    assert.equal(reads, 0);
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/companion/kit-recovery-worker.ts"],
      {
        input: JSON.stringify(value),
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
  } finally {
    await f.close();
  }
});
test("conflicts, uncertain writes and selection failures retain copies without silently activating", async () => {
  const f = await fixture();
  let saved: Uint8Array | undefined;
  const entry = {
    getSecret: async () => saved,
    addSecretIfAbsent: async (key: Uint8Array) => {
      saved = Uint8Array.from(key);
      throw Error("lost acknowledgement");
    },
  };
  try {
    const before = await resolveActiveContent(f.current);
    const uncertain = await recoverAndActivateWithKit(
      f.backup,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      entry,
      0,
    );
    assert.equal(uncertain.keyStatus, "unconfirmed");
    assert.equal(uncertain.activated, false);
    assert.deepEqual(await resolveActiveContent(f.current), before);
    assert.ok((await readdir(uncertain.directory)).includes("RECOVERY.json"));
    saved = undefined;
    const conflict = await recoverAndActivateWithKit(
      f.backup,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      {
        ...entry,
        addSecretIfAbsent: async () => {
          saved = randomBytes(32);
          return false;
        },
      },
      0,
    );
    assert.equal(conflict.keyStatus, "conflict");
    assert.equal(conflict.activated, false);
    assert.deepEqual(await resolveActiveContent(f.current), before);
    saved = undefined;
    // Force a selection failure after the add without deleting the recovered copy/key.
    const failed = await recoverAndActivateWithKit(
      f.backup,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      {
        ...entry,
        addSecretIfAbsent: async (key) => {
          saved = Uint8Array.from(key);
          await mkdir(join(f.current, "active-content.json"));
          return true;
        },
      },
      0,
    );
    assert.equal(failed.keyStatus, "created");
    assert.equal(failed.activated, false);
    assert.deepEqual(Buffer.from(saved!), f.key);
    assert.ok((await readdir(failed.directory)).includes("RECOVERY.json"));
    await rm(join(f.current, "active-content.json"), { recursive: true });
    const retry = await recoverAndActivateWithKit(
      f.backup,
      f.current,
      f.kit.kit,
      f.kit.recoveryCode,
      { ...entry, addSecretIfAbsent: async () => false },
      0,
    );
    assert.equal(retry.keyStatus, "already-present");
    assert.equal(retry.activated, true);
    assert.ok((await readdir(uncertain.directory)).includes("RECOVERY.json"));
  } finally {
    await f.close();
  }
});
