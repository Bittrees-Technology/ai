import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "alice", tenantId: "personal" },
  other = { userId: "bob", tenantId: "personal" };
const profile = {
  id: "local",
  runtime: "ollama" as const,
  model: "local",
  contextTokens: 4096,
  maxOutputTokens: 1024,
  temperature: 0.2,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "remote-template-")),
    path = join(dir, "store.db"),
    vault = new Vault(randomBytes(32));
  let now = 1000000,
    tick = 0;
  const clock = () => {
    const n = now;
    now += tick;
    return n;
  };
  let store = new Store(path, vault, clock);
  store.addProfile(owner, profile);
  const template = store.saveTemplate(owner, {
    id: randomUUID(),
    expectedRevision: 0,
    confirmed: true,
    definition: {
      name: "PRIVATE_NAME",
      prompt: "PRIVATE_PROMPT",
      kind: "query",
      modelProfileId: "local",
    },
  });
  const identity = {
    scope: "templates:run" as const,
    remoteOwnerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    permissionId: randomUUID(),
  };
  const approval = {
    identity,
    templateId: template.id,
    templateRevision: 1,
    maxRuns: 2,
    expiresAt: now + 600000,
    confirmed: true,
  };
  const command = () => ({
    id: randomUUID(),
    deviceId: identity.deviceId,
    templateId: template.id,
    templateRevision: 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  });
  return {
    dir,
    vault,
    template,
    identity,
    approval,
    command,
    get store() {
      return store;
    },
    setTime(value: number) {
      now = value;
    },
    tick(value: number) {
      tick = value;
    },
    reopen() {
      store.close();
      store = new Store(path, vault, clock);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("template execution requires separate exact permission; receipts and allowances survive restart", () => {
  const f = fixture();
  try {
    const command = f.command();
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, command),
      /NOT_FOUND/,
    );
    f.store.remoteTemplates.approve(owner, f.approval);
    for (const identity of [
      { ...f.identity, scope: "controls:pause-cancel" },
      { ...f.identity, epoch: 2 },
      { ...f.identity, remoteOwnerId: randomUUID() },
      { ...f.identity, permissionId: randomUUID() },
    ])
      assert.throws(() =>
        f.store.remoteTemplates.execute(owner, identity, command),
      );
    assert.throws(
      () => f.store.remoteTemplates.execute(other, f.identity, command),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        f.store.remoteTemplates.execute(
          { ...owner, tenantId: "elsewhere" },
          f.identity,
          command,
        ),
      /NOT_FOUND/,
    );
    assert.throws(() =>
      f.store.remoteTemplates.execute(owner, f.identity, {
        ...command,
        prompt: "override",
      }),
    );
    const first = f.store.remoteTemplates.execute(owner, f.identity, command);
    assert.equal(first.receipt.outcome, "queued");
    assert.equal(
      f.store.get(owner, first.receipt.taskId!).input.prompt,
      "PRIVATE_PROMPT",
    );
    assert.equal(JSON.stringify(first).includes("PRIVATE"), false);
    f.reopen();
    assert.deepEqual(
      f.store.remoteTemplates.execute(owner, f.identity, command),
      { ...first, duplicate: true },
    );
    assert.equal(
      f.store.remoteTemplates.approve(owner, f.approval).remaining,
      1,
    );
    assert.throws(
      () =>
        f.store.remoteTemplates.execute(owner, f.identity, {
          ...command,
          expiresAt: new Date(1050000).toISOString(),
        }),
      /CONFLICT/,
    );
    assert.equal(
      f.store.remoteTemplates.execute(owner, f.identity, f.command()).receipt
        .outcome,
      "queued",
    );
    assert.equal(
      f.store.remoteTemplates.execute(owner, f.identity, f.command()).receipt
        .outcome,
      "denied",
    );
    assert.equal(f.store.list(owner).length, 2);
    assert.equal(
      f.store.remoteTemplates.approve(owner, f.approval).remaining,
      0,
    );
    const exported = f.store.remoteTemplates.export(owner);
    assert.equal(exported.receipts.length, 3);
    assert.equal(exported.permissions[0]!.remaining, 0);
    assert.equal(JSON.stringify(exported).includes("PRIVATE"), false);
    assert.deepEqual(f.store.remoteTemplates.export(other), {
      permissions: [],
      receipts: [],
    });
    for (const table of [
      "remote_template_permissions",
      "remote_template_receipts",
    ]) {
      const row = f.store.db
        .prepare(`SELECT payload FROM ${table} LIMIT 1`)
        .get() as { payload: Buffer };
      assert.equal(row.payload.includes(f.identity.remoteOwnerId), false);
    }
  } finally {
    f.close();
  }
});
test("editing or deleting templates and replacing permission cancel dependent work without recycling consent", () => {
  const f = fixture();
  try {
    f.store.remoteTemplates.approve(owner, f.approval);
    const command = f.command(),
      task = f.store.remoteTemplates.execute(owner, f.identity, command).receipt
        .taskId!;
    const claim = f.store.claim(owner, "worker")!;
    f.store.saveTemplate(owner, {
      id: f.template.id,
      expectedRevision: 1,
      confirmed: true,
      definition: { ...f.template.definition, prompt: "NEW" },
    });
    assert.equal(f.store.get(owner, task).status, "cancelled");
    assert.throws(
      () =>
        f.store.complete(owner, task, "worker", claim.generation, {
          text: "late",
        }),
      /STALE_CLAIM/,
    );
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, command),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        f.store.remoteTemplates.approve(owner, {
          ...f.approval,
          templateRevision: 2,
        }),
      /CONFLICT/,
    );
    const identity = { ...f.identity, permissionId: randomUUID() };
    const approval = { ...f.approval, identity, templateRevision: 2 };
    f.store.remoteTemplates.approve(owner, approval);
    const second = f.store.remoteTemplates.execute(owner, identity, {
      ...f.command(),
      templateRevision: 2,
    }).receipt.taskId!;
    const replacement = {
      ...approval,
      identity: { ...identity, permissionId: randomUUID() },
    };
    f.store.remoteTemplates.approve(owner, replacement);
    assert.equal(f.store.get(owner, second).status, "cancelled");
    assert.throws(
      () => f.store.remoteTemplates.approve(owner, approval),
      /CONFLICT/,
    );
    const third = f.store.remoteTemplates.execute(owner, replacement.identity, {
      ...f.command(),
      templateRevision: 2,
    }).receipt.taskId!;
    f.store.deleteTemplate(owner, f.template.id, {
      expectedRevision: 2,
      confirmed: true,
    });
    assert.equal(f.store.get(owner, third).status, "cancelled");
    assert.equal(f.store.get(owner, task).result, null);
  } finally {
    f.close();
  }
});
test("template lease validation and receipt-write failures roll back task and budget atomically", () => {
  const f = fixture();
  try {
    for (const change of [
      { maxRuns: 21 },
      { confirmed: false },
      { expiresAt: 1000000 + 86400001 },
    ])
      assert.throws(() =>
        f.store.remoteTemplates.approve(owner, { ...f.approval, ...change }),
      );
    f.store.remoteTemplates.approve(owner, f.approval);
    const command = f.command();
    for (const change of [
      { issuedAt: new Date(1000001).toISOString() },
      { issuedAt: new Date(999999).toISOString() },
      { expiresAt: new Date(1300001).toISOString() },
      { expiresAt: command.issuedAt },
    ])
      assert.throws(
        () =>
          f.store.remoteTemplates.execute(owner, f.identity, {
            ...command,
            ...change,
          }),
        /INVALID_INPUT/,
      );
    f.store.db.exec(
      "CREATE TRIGGER fail_template_receipt BEFORE INSERT ON remote_template_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
    );
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, command),
      /receipt failure/,
    );
    assert.equal(f.store.list(owner).length, 0);
    assert.equal(
      f.store.remoteTemplates.export(owner).permissions[0]!.remaining,
      2,
    );
    assert.equal(f.store.remoteTemplates.export(owner).receipts.length, 0);
    f.store.db.exec("DROP TRIGGER fail_template_receipt");
    f.tick(20000);
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, command),
      /EXPIRED/,
    );
    assert.equal(f.store.list(owner).length, 0);
    assert.equal(
      f.store.remoteTemplates.export(owner).permissions[0]!.remaining,
      2,
    );
    f.tick(0);
    f.setTime(1060000);
    assert.equal(
      f.store.remoteTemplates.execute(owner, f.identity, command).receipt
        .outcome,
      "expired",
    );
    assert.equal(
      f.store.remoteTemplates.export(owner).permissions[0]!.remaining,
      2,
    );
    f.setTime(f.approval.expiresAt);
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, command),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});
test("remote template pending capacity is owner-wide and exact retries remain stable", () => {
  const f = fixture();
  try {
    f.store.remoteTemplates.approve(owner, { ...f.approval, maxRuns: 20 });
    for (let n = 0; n < 20; n++)
      f.store.remoteTemplates.execute(owner, f.identity, f.command());
    const second = f.store.saveTemplate(owner, {
      id: randomUUID(),
      expectedRevision: 0,
      confirmed: true,
      definition: f.template.definition,
    });
    const identity = { ...f.identity, permissionId: randomUUID() };
    f.store.remoteTemplates.approve(owner, {
      ...f.approval,
      identity,
      templateId: second.id,
    });
    const command = { ...f.command(), templateId: second.id };
    const receipt = f.store.remoteTemplates.execute(owner, identity, command);
    assert.equal(receipt.receipt.outcome, "capacity");
    assert.equal(f.store.list(owner).length, 20);
    const task = f.store.list(owner)[0]!;
    f.store.command(owner, task.id, {
      command: "cancel",
      expectedRevision: task.revision,
    });
    assert.deepEqual(
      f.store.remoteTemplates.execute(owner, identity, command),
      { ...receipt, duplicate: true },
    );
    assert.equal(
      f.store.remoteTemplates.execute(owner, identity, {
        ...command,
        id: randomUUID(),
      }).receipt.outcome,
      "queued",
    );
  } finally {
    f.close();
  }
});
test("restored template history cannot re-enable consent or execute queued runs", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    f.store.remoteTemplates.approve(owner, f.approval);
    const command = f.command(),
      receipt = f.store.remoteTemplates.execute(
        owner,
        f.identity,
        command,
      ).receipt;
    const backup = join(f.dir, "backup.enc"),
      destination = join(f.dir, "restore.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, destination);
    restored = new Store(destination, f.vault, () => 1000000);
    assert.equal(restored.remoteTemplates.export(owner).receipts.length, 1);
    assert.equal(restored.remoteTemplates.export(owner).permissions.length, 0);
    assert.throws(
      () => restored!.remoteTemplates.execute(owner, f.identity, command),
      /NOT_FOUND/,
    );
    assert.throws(
      () => restored!.remoteTemplates.approve(owner, f.approval),
      /CONFLICT/,
    );
    assert.equal(restored.claim(owner, "restored-worker"), null);
    assert.equal(restored.get(owner, receipt.taskId!).status, "cancelled");
    restored.deleteAll(owner);
    assert.deepEqual(restored.remoteTemplates.export(owner), {
      permissions: [],
      receipts: [],
    });
    assert.equal(
      (
        restored.db
          .prepare("SELECT COUNT(*) AS n FROM remote_template_runs")
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    restored?.close();
    f.close();
  }
});
test("actual worker drops output if template permission is revoked during inference", async () => {
  const f = fixture();
  try {
    f.store.remoteTemplates.approve(owner, f.approval);
    const receipt = f.store.remoteTemplates.execute(
      owner,
      f.identity,
      f.command(),
    ).receipt;
    let release!: (text: string) => void, begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          begin();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      (id) => f.store.profile(owner, id),
    );
    const running = worker.runOnce();
    await started;
    const cancelled = f.store.remoteTemplates.revoke(
      owner,
      f.identity.deviceId,
    );
    assert.deepEqual(cancelled, [receipt.taskId]);
    release("late output");
    await running;
    assert.equal(f.store.get(owner, receipt.taskId!).status, "cancelled");
    assert.equal(f.store.get(owner, receipt.taskId!).result, null);
  } finally {
    f.close();
  }
});

test("schema-nine migration preserves templates and starts with no remote permission", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "DROP TABLE remote_template_runs; DROP TABLE remote_template_receipts; DROP TABLE remote_template_permissions; PRAGMA user_version=9",
    );
    f.reopen();
    assert.equal(f.store.db.pragma("user_version", { simple: true }), 24);
    assert.deepEqual(f.store.template(owner, f.template.id), f.template);
    assert.deepEqual(f.store.remoteTemplates.export(owner), {
      permissions: [],
      receipts: [],
    });
    assert.throws(
      () => f.store.remoteTemplates.execute(owner, f.identity, f.command()),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});

test("permission expiry prevents worker heartbeat and completion, including after restart", () => {
  const f = fixture();
  try {
    const expiry = 1030000;
    f.store.remoteTemplates.approve(owner, {
      ...f.approval,
      expiresAt: expiry,
    });
    const command = {
      ...f.command(),
      expiresAt: new Date(expiry).toISOString(),
    };
    const taskId = f.store.remoteTemplates.execute(owner, f.identity, command)
      .receipt.taskId!;
    const claim = f.store.claim(owner, "worker", 60000)!;
    f.setTime(expiry);
    assert.throws(
      () => f.store.heartbeat(owner, taskId, "worker", claim.generation),
      /STALE_CLAIM/,
    );
    assert.throws(
      () =>
        f.store.complete(owner, taskId, "worker", claim.generation, {
          text: "late",
        }),
      /STALE_CLAIM/,
    );
    f.reopen();
    assert.equal(f.store.claim(owner, "new-worker"), null);
    assert.equal(f.store.get(owner, taskId).status, "cancelled");
    assert.equal(f.store.get(owner, taskId).result, null);
  } finally {
    f.close();
  }
});
