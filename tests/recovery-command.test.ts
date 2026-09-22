import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
import {
  recoverContentCopy,
  recoveryArguments,
} from "../apps/companion/recovery.js";
test("recovery arguments require explicit confirmation and reject duplicates and unknown options", () => {
  assert.deepEqual(
    recoveryArguments([
      "--backup",
      "a.aib",
      "--destination-parent",
      "destination",
      "--confirm",
    ]),
    { backup: resolve("a.aib"), parent: resolve("destination") },
  );
  for (const args of [
    [],
    ["--backup", "a", "--destination-parent", "d"],
    [
      "--backup",
      "a",
      "--backup",
      "b",
      "--destination-parent",
      "d",
      "--confirm",
    ],
    ["--backup", "a", "--destination-parent", "d", "--confirm", "--confirm"],
    [
      "--backup",
      "a",
      "--destination-parent",
      "d",
      "--confirm",
      "--key",
      "secret",
    ],
  ])
    assert.throws(() => recoveryArguments(args), /INVALID_ARGUMENTS/);
});
test("offline recovery uses only an existing key, returns a separate copy, and leaves original data unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recover-command-")),
    key = randomBytes(32),
    vault = new Vault(key),
    owner = { userId: "a", tenantId: "t" };
  const tasks = new Store(join(dir, "tasks.db"), vault),
    memory = new MemoryStore(join(dir, "memory.db"), vault, async () => true);
  let recovered: Store | undefined;
  let writes = 0,
    reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return key;
    },
    setSecret: async () => {
      writes++;
    },
  };
  try {
    const task = tasks.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "synthetic before backup",
        modelProfileId: "p",
      },
      "first",
    );
    const file = join(dir, "backup.aib");
    await createContentBackup(tasks, memory, vault, file);
    const newer = tasks.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "synthetic after backup",
        modelProfileId: "p",
      },
      "second",
    );
    const result = await recoverContentCopy(file, dir, entry, 0);
    assert.equal(result.activated, false);
    assert.notEqual(result.directory, dir);
    recovered = new Store(join(result.directory, "tasks.db"), vault);
    assert.equal(
      recovered.get(owner, task.id).input.prompt,
      "synthetic before backup",
    );
    assert.throws(() => recovered!.get(owner, newer.id), /NOT_FOUND/);
    assert.equal(
      tasks.get(owner, newer.id).input.prompt,
      "synthetic after backup",
    );
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    const before = readdirSync(dir).sort();
    for (const getSecret of [
      async () => undefined,
      async () => new Uint8Array(3),
      async () => {
        throw Error("private-keychain-detail");
      },
    ]) {
      await assert.rejects(
        recoverContentCopy(
          file,
          dir,
          { getSecret, setSecret: entry.setSecret },
          0,
        ),
        /ORIGINAL_KEY_UNAVAILABLE/,
      );
    }
    await assert.rejects(
      recoverContentCopy(
        file,
        dir,
        { getSecret: async () => randomBytes(32), setSecret: entry.setSecret },
        0,
      ),
      /BACKUP_RESTORE_FAILED/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(readdirSync(dir).sort(), before);
  } finally {
    recovered?.close();
    memory.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("occupied companion port blocks recovery before Keychain access and guard releases after failure", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  let reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return undefined;
    },
    setSecret: async () => {
      throw Error("must not create key");
    },
  };
  try {
    await assert.rejects(
      recoverContentCopy("missing", "missing", entry, port),
      /COMPANION_RUNNING_OR_PORT_UNAVAILABLE/,
    );
    assert.equal(reads, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  await assert.rejects(
    recoverContentCopy("missing", "missing", entry, port),
    /INVALID_PATH/,
  );
  assert.equal(reads, 0);
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(port, "127.0.0.1", r));
  await new Promise<void>((r) => probe.close(() => r()));
});
