import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
import {
  activateContentBackup,
  rollbackContent,
  resolveActiveContent,
} from "../apps/companion/active-content.js";
import { activationArguments } from "../apps/companion/activate-cli.js";
import { localMemoryAccess } from "../apps/companion/memory.js";
const owner = { userId: "a", tenantId: "personal" };
const input = {
  conversationId: "c",
  kind: "query",
  prompt: "synthetic rollback source",
  modelProfileId: "p",
};
test("rollback clones previous task and memory data, clears permissions and retains current and original content", async () => {
  const base = await mkdtemp(join(tmpdir(), "rollback-")),
    key = randomBytes(32),
    vault = new Vault(key);
  const entry = {
    getSecret: async () => key,
    setSecret: async () => {
      throw Error("no key writes");
    },
  };
  const stores: Store[] = [],
    memories: MemoryStore[] = [];
  try {
    const original = new Store(join(base, "tasks.db"), vault);
    stores.push(original);
    const memory = new MemoryStore(
      join(base, "memory.db"),
      vault,
      localMemoryAccess(original),
    );
    memories.push(memory);
    const first = original.create(owner, input, "first"),
      claim = original.claim(owner, "seed")!;
    const completed = original.complete(
      owner,
      first.id,
      "seed",
      claim.generation,
      { text: "synthetic source" },
    );
    const item = await memory.add(owner, {
      type: "preference",
      text: "synthetic memory",
      origin: "model",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: first.id,
          revision: String(completed.revision),
        },
      ],
    });
    await memory.review(owner, item.id, 1, { approve: true });
    original.db
      .prepare("INSERT INTO remote_control_bindings VALUES(?,?,?,?)")
      .run(owner.userId, owner.tenantId, "device", Buffer.from("old-consent"));
    original.db
      .prepare("INSERT INTO remote_template_permissions VALUES(?,?,?,?,?,?)")
      .run(
        "permission",
        owner.userId,
        owner.tenantId,
        "device",
        "template",
        Buffer.from("old-consent"),
      );
    const file = join(base, "earlier.aib");
    await createContentBackup(original, memory, vault, file);
    const newer = original.create(owner, input, "newer");
    const selected = await activateContentBackup(file, base, entry, 0);
    const current = new Store(join(selected.directory, "tasks.db"), vault);
    stores.push(current);
    const currentOnly = current.create(owner, input, "current-only");
    // Original data is newer than the activated backup; rollback captures that
    // previous directory's latest state, not the earlier imported archive.
    const result = await rollbackContent(base, entry, 0);
    assert.notEqual(result.directory, base);
    assert.notEqual(result.directory, selected.directory);
    assert.equal(result.previousDirectory, selected.directory);
    assert.equal(
      (await resolveActiveContent(base)).directory,
      result.directory,
    );
    const recovered = new Store(join(result.directory, "tasks.db"), vault);
    stores.push(recovered);
    const restoredMemory = new MemoryStore(
      join(result.directory, "memory.db"),
      vault,
      localMemoryAccess(recovered),
    );
    memories.push(restoredMemory);
    assert.equal(recovered.get(owner, newer.id).id, newer.id);
    assert.throws(() => recovered.get(owner, currentOnly.id), /NOT_FOUND/);
    assert.equal(current.get(owner, currentOnly.id).id, currentOnly.id);
    assert.equal(original.get(owner, newer.id).id, newer.id);
    assert.equal(
      (await restoredMemory.get(owner, item.id)).text,
      "synthetic memory",
    );
    assert.deepEqual(
      recovered.db.prepare("SELECT * FROM remote_control_bindings").all(),
      [],
    );
    assert.equal(
      (
        recovered.db
          .prepare("SELECT payload FROM remote_template_permissions")
          .get() as { payload: unknown }
      ).payload,
      null,
    );
    assert.equal(
      original.db.prepare("SELECT * FROM remote_control_bindings").all().length,
      1,
    );
    recovered.db.prepare("DELETE FROM tasks WHERE id=?").run(first.id);
    await assert.rejects(restoredMemory.get(owner, item.id));
    // A second rollback clones the preceding selection, preserving writes made
    // there and retaining the data created by the first rollback.
    const again = await rollbackContent(base, entry, 0);
    const twice = new Store(join(again.directory, "tasks.db"), vault);
    stores.push(twice);
    assert.equal(twice.get(owner, currentOnly.id).id, currentOnly.id);
    assert.equal(again.previousDirectory, result.directory);
    assert.equal(
      (await readdir(base)).some((name) => name.startsWith(".rollback-")),
      false,
    );
  } finally {
    for (const m of memories) m.close();
    for (const s of stores) s.close();
    await rm(base, { recursive: true, force: true });
  }
});
test("rollback refuses absent history, missing previous stores, wrong key and occupied port without changing selection", async () => {
  const base = await mkdtemp(join(tmpdir(), "rollback-failure-")),
    key = randomBytes(32),
    vault = new Vault(key);
  let reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return key;
    },
    setSecret: async () => {
      throw Error("no writes");
    },
  };
  const tasks = new Store(join(base, "tasks.db"), vault),
    memory = new MemoryStore(join(base, "memory.db"), vault, async () => false);
  try {
    await assert.rejects(
      rollbackContent(base, entry, 0),
      /NO_PREVIOUS_CONTENT/,
    );
    assert.equal(reads, 0);
    tasks.create(owner, input, "seed");
    const file = join(base, "backup.aib");
    await createContentBackup(tasks, memory, vault, file);
    await activateContentBackup(file, base, entry, 0);
    const pointer = await readFile(join(base, "active-content.json")),
      folders = await readdir(join(base, "stores"));
    await assert.rejects(
      rollbackContent(
        base,
        { ...entry, getSecret: async () => randomBytes(32) },
        0,
      ),
      /ACTIVATION_FAILED/,
    );
    await rename(join(base, "memory.db"), join(base, "memory.retained"));
    try {
      await assert.rejects(
        rollbackContent(base, entry, 0),
        /ACTIVATION_FAILED/,
      );
    } finally {
      await rename(join(base, "memory.retained"), join(base, "memory.db"));
    }
    assert.deepEqual(
      await readFile(join(base, "active-content.json")),
      pointer,
    );
    assert.deepEqual(await readdir(join(base, "stores")), folders);
    assert.equal(
      (await readdir(base)).some((name) => name.startsWith(".rollback-")),
      false,
    );
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const before = reads;
    try {
      await assert.rejects(
        rollbackContent(base, entry, (server.address() as AddressInfo).port),
        /COMPANION_RUNNING_OR_PORT_UNAVAILABLE/,
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    assert.equal(reads, before);
  } finally {
    memory.close();
    tasks.close();
    await rm(base, { recursive: true, force: true });
  }
});
test("rollback arguments require explicit confirmation and exclude mixed backup selection", () => {
  assert.deepEqual(activationArguments(["--previous", "--confirm"]), {
    previous: true,
  });
  for (const args of [
    ["--previous"],
    ["--previous", "--confirm", "--confirm"],
    ["--previous", "--backup", "a", "--confirm"],
  ])
    assert.throws(() => activationArguments(args), /INVALID_ARGUMENTS/);
});
