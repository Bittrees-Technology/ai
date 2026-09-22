import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  activateContentBackup,
  resolveActiveContent,
} from "../apps/companion/active-content.js";
import { activationArguments } from "../apps/companion/activate-cli.js";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
const owner = { userId: "a", tenantId: "t" };
const input = {
  conversationId: "c",
  kind: "query",
  prompt: "synthetic",
  modelProfileId: "p",
};
test("activation selects complete restored content, preserves newer previous data and stable device files", async () => {
  const base = await mkdtemp(join(tmpdir(), "activation-"));
  const key = randomBytes(32),
    vault = new Vault(key);
  const tasks = new Store(join(base, "tasks.db"), vault),
    memory = new MemoryStore(join(base, "memory.db"), vault, async () => true);
  let restored: Store | undefined;
  let reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return key;
    },
    setSecret: async () => {
      throw Error("must not write key");
    },
  };
  try {
    const old = tasks.create(owner, input, "old");
    tasks.db
      .prepare("INSERT INTO remote_control_bindings VALUES(?,?,?,?)")
      .run(owner.userId, owner.tenantId, "device", Buffer.from("consent"));
    const backup = join(base, "backup.aib");
    await createContentBackup(tasks, memory, vault, backup);
    const newer = tasks.create(owner, input, "new");
    await writeFile(join(base, "pairing-code.txt"), "stable-code");
    await mkdir(join(base, "model-imports"));
    await writeFile(join(base, "model-imports", "jobs.db"), "stable-imports");
    const oldBytes = await readFile(join(base, "tasks.db"));
    assert.equal((await resolveActiveContent(base)).directory, base);
    const result = await activateContentBackup(backup, base, entry, 0);
    assert.equal(result.activated, true);
    assert.equal(result.previousDirectory, base);
    assert.equal(
      (await resolveActiveContent(base)).directory,
      result.directory,
    );
    assert.deepEqual(await readFile(join(base, "tasks.db")), oldBytes);
    assert.equal(tasks.get(owner, newer.id).id, newer.id);
    restored = new Store(join(result.directory, "tasks.db"), vault);
    assert.equal(restored.get(owner, old.id).id, old.id);
    assert.throws(() => restored!.get(owner, newer.id), /NOT_FOUND/);
    assert.deepEqual(
      restored.db.prepare("SELECT * FROM remote_control_bindings").all(),
      [],
    );
    assert.equal(
      await readFile(join(base, "pairing-code.txt"), "utf8"),
      "stable-code",
    );
    assert.equal(
      await readFile(join(base, "model-imports", "jobs.db"), "utf8"),
      "stable-imports",
    );
    const pointer = await readFile(join(base, "active-content.json"));
    const folders = await readdir(join(base, "stores"));
    await assert.rejects(
      activateContentBackup(
        backup,
        base,
        { ...entry, getSecret: async () => randomBytes(32) },
        0,
      ),
      /ACTIVATION_FAILED/,
    );
    await assert.rejects(
      activateContentBackup(
        backup,
        base,
        { ...entry, getSecret: async () => undefined },
        0,
      ),
      /ORIGINAL_KEY_UNAVAILABLE/,
    );
    assert.deepEqual(
      await readFile(join(base, "active-content.json")),
      pointer,
    );
    assert.deepEqual(await readdir(join(base, "stores")), folders);
    const second = await activateContentBackup(backup, base, entry, 0);
    assert.equal(second.previousDirectory, result.directory);
    assert.equal((await resolveActiveContent(base)).previous, folders[0]);
    assert.equal(restored.get(owner, old.id).id, old.id);
    assert.equal(reads, 2);
  } finally {
    restored?.close();
    memory.close();
    tasks.close();
    await rm(base, { recursive: true, force: true });
  }
});
test("malformed, oversized, missing-target and symlink selections fail closed before key access", async () => {
  const base = await mkdtemp(join(tmpdir(), "selection-"));
  const pointer = join(base, "active-content.json");
  const entry = {
    getSecret: async () => {
      throw Error("must not read");
    },
    setSecret: async () => {},
  };
  try {
    for (const raw of [
      "{}",
      "x".repeat(1025),
      JSON.stringify({ version: 1, current: "../elsewhere", previous: null }),
      JSON.stringify({
        version: 1,
        current: "bittrees-ai-recovered-ABC123",
        previous: null,
      }),
    ]) {
      await writeFile(pointer, raw);
      await assert.rejects(
        resolveActiveContent(base),
        /INVALID_ACTIVE_CONTENT/,
      );
      await assert.rejects(
        activateContentBackup("missing", base, entry, 0),
        /INVALID_ACTIVE_CONTENT/,
      );
    }
    await rm(pointer);
    await symlink(join(base, "missing"), pointer);
    await assert.rejects(resolveActiveContent(base), /INVALID_ACTIVE_CONTENT/);
    await rm(pointer);
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(base, "stores"));
    await writeFile(
      pointer,
      JSON.stringify({
        version: 1,
        current: "bittrees-ai-recovered-ABC123",
        previous: null,
      }),
    );
    await assert.rejects(resolveActiveContent(base), /INVALID_ACTIVE_CONTENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("activation requires confirmation and an available companion port before any key or data access", async () => {
  for (const args of [
    [],
    ["--backup", "a"],
    ["--backup", "a", "--confirm", "--confirm"],
    ["--backup", "--confirm", "--confirm"],
  ])
    assert.throws(() => activationArguments(args), /INVALID_ARGUMENTS/);
  assert.ok(
    activationArguments(["--backup", "a.aib", "--confirm"]).backup?.endsWith(
      "/a.aib",
    ),
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      activateContentBackup(
        "missing",
        "missing",
        {
          getSecret: async () => {
            throw Error("must not read");
          },
          setSecret: async () => {},
        },
        (server.address() as AddressInfo).port,
      ),
      /COMPANION_RUNNING_OR_PORT_UNAVAILABLE/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
