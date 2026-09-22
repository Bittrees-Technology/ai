import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { Vault } from "../modules/storage/vault.js";
const owner = { userId: "local-owner", tenantId: "personal" };
const other = { userId: "other", tenantId: "personal" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-control-"));
  const path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = 1000000,
    tick = 0;
  let store = new Store(path, vault, () => {
    const value = now;
    now += tick;
    return value;
  });
  const identity = {
    remoteOwnerId: randomUUID(),
    controlId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
  };
  const task = store.create(
    owner,
    {
      conversationId: "c",
      kind: "query",
      prompt: "PRIVATE",
      modelProfileId: "m",
    },
    "k",
  );
  const command = {
    id: randomUUID(),
    deviceId: identity.deviceId,
    taskId: task.id,
    command: "pause",
    expectedRevision: task.revision,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  return {
    dir,
    vault,
    get store() {
      return store;
    },
    task,
    identity,
    command,
    allow: () =>
      store.allowRemoteControls(owner, {
        ...identity,
        expiresAt: now + 300000,
      }),
    advance: (ms: number) => {
      now += ms;
    },
    tick: (ms: number) => {
      tick = ms;
    },
    reopen: () => {
      store.close();
      store = new Store(path, vault, () => now);
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("remote executor requires persisted local consent and matching owner/device/epoch", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, f.command),
      /NOT_FOUND/,
    );
    f.allow();
    for (const identity of [
      { ...f.identity, epoch: 2 },
      { ...f.identity, controlId: randomUUID() },
      { ...f.identity, remoteOwnerId: randomUUID() },
    ])
      assert.throws(
        () => f.store.executeRemoteControl(owner, identity, f.command),
        /NOT_FOUND/,
      );
    assert.throws(
      () => f.store.executeRemoteControl(other, f.identity, f.command),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        f.store.executeRemoteControl(owner, f.identity, {
          ...f.command,
          deviceId: randomUUID(),
        }),
      /INVALID_INPUT/,
    );
    for (const raw of [
      { ...f.command, command: "resume" },
      { ...f.command, content: "PRIVATE" },
    ])
      assert.throws(() => f.store.executeRemoteControl(owner, f.identity, raw));
    f.store.revokeRemoteControls(owner, f.identity.deviceId);
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, f.command),
      /NOT_FOUND/,
    );
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    assert.equal(f.store.exportRemoteControls(owner).length, 0);
  } finally {
    f.close();
  }
});
test("task transition and encrypted receipt survive restart and retry without another transition", () => {
  const f = fixture();
  try {
    f.allow();
    const claim = f.store.claim(owner, "worker")!;
    const command = { ...f.command, expectedRevision: claim.task.revision };
    const result = f.store.executeRemoteControl(owner, f.identity, command);
    assert.equal(result.receipt.outcome, "applied");
    assert.throws(
      () =>
        f.store.complete(owner, f.task.id, "worker", claim.generation, "LATE"),
      /STALE_CLAIM/,
    );
    const task = f.store.get(owner, f.task.id),
      events = f.store.events(owner);
    assert.equal(task.status, "paused");
    const blob = f.store.db
      .prepare("SELECT payload FROM remote_control_receipts")
      .get() as { payload: Buffer };
    assert.equal(blob.payload.includes(Buffer.from(command.taskId)), false);
    f.reopen();
    f.advance(61000);
    assert.deepEqual(f.store.executeRemoteControl(owner, f.identity, command), {
      ...result,
      duplicate: true,
    });
    assert.deepEqual(f.store.get(owner, f.task.id), task);
    assert.deepEqual(f.store.events(owner), events);
    assert.throws(
      () =>
        f.store.executeRemoteControl(owner, f.identity, {
          ...command,
          command: "cancel",
        }),
      /CONFLICT/,
    );
    assert.equal(f.store.exportRemoteControls(owner).length, 1);
    assert.equal(f.store.exportRemoteControls(other).length, 0);
    f.store.deleteAll(other);
    assert.equal(f.store.exportRemoteControls(owner).length, 1);
    f.store.deleteAll(owner);
    assert.equal(f.store.exportRemoteControls(owner).length, 0);
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, command),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});
test("remote executor records conflict, denied, and expired outcomes without changing tasks", () => {
  const f = fixture();
  try {
    f.allow();
    for (const [change, outcome] of [
      [{ expectedRevision: 99 }, "conflict"],
      [{ taskId: randomUUID() }, "denied"],
      [
        {
          issuedAt: new Date(900000).toISOString(),
          expiresAt: new Date(999999).toISOString(),
        },
        "expired",
      ],
    ] as const) {
      const command = { ...f.command, id: randomUUID(), ...change };
      assert.equal(
        f.store.executeRemoteControl(owner, f.identity, command).receipt
          .outcome,
        outcome,
      );
      assert.equal(
        f.store.executeRemoteControl(owner, f.identity, command).duplicate,
        true,
      );
    }
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    assert.equal(
      f.store.executeRemoteControl(owner, f.identity, {
        ...f.command,
        command: "cancel",
      }).receipt.outcome,
      "applied",
    );
    assert.equal(f.store.get(owner, f.task.id).status, "cancelled");
    assert.equal(
      f.store.executeRemoteControl(owner, f.identity, {
        ...f.command,
        id: randomUUID(),
        expectedRevision: 2,
      }).receipt.outcome,
      "conflict",
    );
  } finally {
    f.close();
  }
});
test("receipt write failure and mid-transition expiry roll back task, run, and event changes", () => {
  const f = fixture();
  try {
    f.allow();
    const claim = f.store.claim(owner, "worker")!;
    const command = { ...f.command, expectedRevision: claim.task.revision };
    const before = f.store.get(owner, f.task.id),
      events = f.store.events(owner);
    const runs = f.store.db.prepare("SELECT * FROM runs").all();
    f.store.db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON remote_control_receipts BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
    );
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, command),
      /injected/,
    );
    assert.deepEqual(f.store.get(owner, f.task.id), before);
    assert.deepEqual(f.store.events(owner), events);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM runs").all(), runs);
    f.store.db.exec("DROP TRIGGER fail_receipt");
    f.tick(30000);
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, command),
      /EXPIRED/,
    );
    f.tick(0);
    assert.deepEqual(f.store.get(owner, f.task.id), before);
    assert.deepEqual(f.store.events(owner), events);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM runs").all(), runs);
    assert.equal(f.store.exportRemoteControls(owner).length, 0);
  } finally {
    f.close();
  }
});
test("version seven upgrade retains tasks and remote receipts remain disabled by default", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "DROP TABLE remote_control_bindings; DROP TABLE remote_control_receipts; PRAGMA user_version=7",
    );
    f.reopen();
    assert.equal(f.store.db.pragma("user_version", { simple: true }), 15);
    assert.equal(f.store.get(owner, f.task.id).input.prompt, "PRIVATE");
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, f.command),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});

test("malformed leases, changed epochs and expired local consent cannot execute", () => {
  const f = fixture();
  try {
    f.allow();
    for (const change of [
      { issuedAt: new Date(1000001).toISOString() },
      { expiresAt: f.command.issuedAt },
      { expiresAt: new Date(1400000).toISOString() },
    ])
      assert.throws(
        () =>
          f.store.executeRemoteControl(owner, f.identity, {
            ...f.command,
            ...change,
          }),
        /INVALID_INPUT/,
      );
    f.store.allowRemoteControls(owner, {
      ...f.identity,
      epoch: 2,
      expiresAt: 1300000,
    });
    assert.throws(
      () => f.store.executeRemoteControl(owner, f.identity, f.command),
      /NOT_FOUND/,
    );
    f.advance(300001);
    assert.throws(
      () =>
        f.store.executeRemoteControl(
          owner,
          { ...f.identity, epoch: 2 },
          f.command,
        ),
      /NOT_FOUND/,
    );
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    assert.equal(f.store.exportRemoteControls(owner).length, 0);
  } finally {
    f.close();
  }
});

test("backup restores receipt history but requires fresh local control consent", async () => {
  const f = fixture();
  try {
    f.allow();
    f.store.executeRemoteControl(owner, f.identity, f.command);
    const backup = join(f.dir, "backup.enc"),
      destination = join(f.dir, "restore.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, destination);
    const restored = new Store(destination, f.vault, () => 1000000);
    try {
      assert.equal(restored.exportRemoteControls(owner).length, 1);
      assert.equal(restored.get(owner, f.task.id).status, "paused");
      assert.throws(
        () => restored.executeRemoteControl(owner, f.identity, f.command),
        /NOT_FOUND/,
      );
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("failed consent removal never publishes a restored database", async () => {
  const f = fixture();
  try {
    f.allow();
    f.store.db
      .exec(`CREATE TRIGGER fail_restore_consent BEFORE DELETE ON remote_control_bindings
      BEGIN SELECT RAISE(ABORT, 'injected consent deletion failure'); END`);
    const backup = join(f.dir, "backup.enc");
    const destination = join(f.dir, "restore.db");
    await encryptedBackup(f.store, f.vault, backup);
    const before = readdirSync(f.dir).sort();
    await assert.rejects(
      restoreBackup(backup, f.vault, destination),
      /injected consent deletion failure/,
    );
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(f.dir).sort(), before);
    assert.equal(f.store.remoteControlsAllowed(owner, f.identity), true);
  } finally {
    f.close();
  }
});
