import { resumeTaskAccess } from "../apps/companion/resume-access.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { remoteControlSchema } from "../modules/remote/status.js";
import { LocalWorker } from "../apps/companion/worker.js";
import type { ResumeAccess } from "../modules/storage/remote-resumes.js";
const owner = { userId: "owner", tenantId: "personal" },
  other = { userId: "other", tenantId: "personal" };
const profile = {
  id: "synthetic",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
function fixture(waiting = false, questions = waiting) {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-resume-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = 1000000;
  let store = new Store(path, vault, () => now);
  store.addProfile(owner, profile);
  let task = store.create(
    owner,
    {
      conversationId: "conversation",
      kind: "query",
      prompt: "PRIVATE_TASK",
      modelProfileId: profile.id,
      allowQuestions: questions,
    },
    randomUUID(),
  );
  if (waiting) {
    const claim = store.claim(owner, "worker")!;
    store.waitForOwnerInput(
      owner,
      task.id,
      "worker",
      claim.generation,
      "PRIVATE_QUESTION",
    );
    task = store.get(owner, task.id);
  }
  task = store.command(owner, task.id, {
    command: "pause",
    expectedRevision: task.revision,
  });
  const identity = {
    scope: "tasks:resume" as const,
    remoteOwnerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    permissionId: randomUUID(),
  };
  const approval = {
    identity,
    taskId: task.id,
    taskRevision: task.revision,
    modelDigest: "a".repeat(64),
    expiresAt: now + 600000,
    confirmed: true,
  };
  const command = {
    version: 1,
    id: randomUUID(),
    deviceId: identity.deviceId,
    permissionId: identity.permissionId,
    taskId: task.id,
    expectedRevision: task.revision,
    command: "resume",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  return {
    dir,
    path,
    vault,
    identity,
    approval,
    command,
    task,
    get store() {
      return store;
    },
    get now() {
      return now;
    },
    advance(n: number) {
      now += n;
    },
    reopen() {
      store.close();
      store = new Store(path, vault, () => now);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const allow: ResumeAccess = async () => () => {};
function unchanged(f: ReturnType<typeof fixture>) {
  assert.equal(f.store.get(owner, f.task.id).status, "paused");
  assert.equal(f.store.get(owner, f.task.id).revision, f.task.revision);
  assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
}
test("resume has separate local authority, no default access provider and no pause/cancel widening", async () => {
  const f = fixture();
  try {
    assert.equal(remoteControlSchema.safeParse(f.command).success, false);
    await assert.rejects(
      f.store.remoteResumes.execute(owner, f.identity, f.command, allow),
      /NOT_FOUND/,
    );
    const old = {
      remoteOwnerId: f.identity.remoteOwnerId,
      deviceId: f.identity.deviceId,
      epoch: 1,
      controlId: randomUUID(),
    };
    f.store.allowRemoteControls(owner, { ...old, expiresAt: f.now + 600000 });
    await assert.rejects(
      f.store.remoteResumes.execute(owner, old, f.command, allow),
    );
    assert.throws(() => f.store.executeRemoteControl(owner, old, f.command));
    f.store.remoteResumes.approve(owner, f.approval);
    await assert.rejects(
      f.store.remoteResumes.execute(owner, f.identity, f.command),
      /NOT_FOUND/,
    );
    for (const identity of [
      { ...f.identity, scope: "controls:pause-cancel" },
      { ...f.identity, epoch: 2 },
      { ...f.identity, remoteOwnerId: randomUUID() },
      { ...f.identity, permissionId: randomUUID() },
    ])
      await assert.rejects(
        f.store.remoteResumes.execute(owner, identity, f.command, allow),
      );
    await assert.rejects(
      f.store.remoteResumes.execute(other, f.identity, f.command, allow),
    );
    await assert.rejects(
      f.store.remoteResumes.execute(
        { ...owner, tenantId: "other" },
        f.identity,
        f.command,
        allow,
      ),
    );
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        f.identity,
        { ...f.command, prompt: "OVERRIDE" },
        allow,
      ),
    );
    unchanged(f);
  } finally {
    f.close();
  }
});
test("one exact resume persists once across concurrent delivery and reopen, and the real worker executes once", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    let checks = 0;
    const access: ResumeAccess = async (task, p) => {
      assert.equal(f.store.db.inTransaction, false);
      assert.equal(task.id, f.task.id);
      assert.deepEqual(p, profile);
      return () => {
        checks++;
      };
    };
    const results = await Promise.all([
      f.store.remoteResumes.execute(owner, f.identity, f.command, access),
      f.store.remoteResumes.execute(owner, f.identity, f.command, access),
    ]);
    assert.deepEqual(results.map((v) => v.duplicate).sort(), [false, true]);
    assert.equal(checks, 2);
    assert.equal(f.store.get(owner, f.task.id).revision, f.task.revision + 1);
    assert.equal(f.store.remoteResumes.receipts(owner).length, 1);
    f.reopen();
    const duplicate = await f.store.remoteResumes.execute(
      owner,
      f.identity,
      f.command,
    );
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        f.identity,
        { ...f.command, expiresAt: new Date(f.now + 50000).toISOString() },
        allow,
      ),
      /CONFLICT/,
    );
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        f.identity,
        { ...f.command, id: randomUUID() },
        allow,
      ),
      /CONFLICT/,
    );
    let generated = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          generated++;
          return "SYNTHETIC_RESULT";
        },
      },
      () => profile,
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(generated, 1);
    assert.equal(f.store.get(owner, f.task.id).status, "completed");
    assert.equal(
      JSON.stringify(f.store.remoteResumes.receipts(owner)).includes("PRIVATE"),
      false,
    );
  } finally {
    f.close();
  }
});
test("resume preserves an unanswered wait and cannot start a worker", async () => {
  const f = fixture(true);
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    const r = await f.store.remoteResumes.execute(
      owner,
      f.identity,
      f.command,
      allow,
    );
    assert.equal(r.receipt.outcome, "awaiting_input");
    assert.equal(f.store.claim(owner, "next"), null);
    assert.equal(f.store.inputWaitHistory(owner, f.task.id)[0]!.replyId, null);
  } finally {
    f.close();
  }
});
test("revocation or task transition during fresh access denies resume with no receipt", async () => {
  for (const change of ["revoke", "cancel"]) {
    const f = fixture();
    try {
      f.store.remoteResumes.approve(owner, f.approval);
      await assert.rejects(
        f.store.remoteResumes.execute(
          owner,
          f.identity,
          f.command,
          async () => {
            if (change === "revoke")
              f.store.remoteResumes.revoke(owner, f.identity.deviceId);
            else
              f.store.command(owner, f.task.id, {
                command: "cancel",
                expectedRevision: f.task.revision,
              });
            return () => {};
          },
        ),
      );
      assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
      assert.equal(
        f.store.get(owner, f.task.id).status,
        change === "revoke" ? "paused" : "cancelled",
      );
      if (change === "revoke")
        assert.throws(() => f.store.remoteResumes.approve(owner, f.approval));
    } finally {
      f.close();
    }
  }
});
test("source/model access rejection and commit-time failure roll back task, receipt and use", async () => {
  for (const phase of ["await", "before", "after"]) {
    const f = fixture();
    try {
      f.store.remoteResumes.approve(owner, f.approval);
      let checks = 0;
      await assert.rejects(
        f.store.remoteResumes.execute(
          owner,
          f.identity,
          f.command,
          async () => {
            if (phase === "await") throw Error("SOURCE_DENIED");
            return () => {
              if (++checks === (phase === "before" ? 1 : 2))
                throw Error("SOURCE_DENIED");
            };
          },
        ),
        /SOURCE_DENIED/,
      );
      unchanged(f);
      assert.equal(
        f.store.remoteResumes.history(owner)[0]!.permission!.consumed,
        false,
      );
      assert.equal(
        (
          await f.store.remoteResumes.execute(
            owner,
            f.identity,
            f.command,
            allow,
          )
        ).duplicate,
        false,
      );
    } finally {
      f.close();
    }
  }
});
test("short command leases, local grant expiry and clock rollback never authorize execution", async () => {
  for (const which of [
    "command",
    "grant",
    "future",
    "long",
    "rollback",
    "commit",
  ]) {
    const f = fixture();
    try {
      f.store.remoteResumes.approve(owner, f.approval);
      let command = { ...f.command };
      if (which === "command") f.advance(60000);
      if (which === "grant") f.advance(600000);
      if (which === "future")
        command.issuedAt = new Date(f.now + 1).toISOString();
      if (which === "long")
        command.expiresAt = new Date(f.now + 300001).toISOString();
      if (which === "rollback") f.advance(-1);
      await assert.rejects(
        f.store.remoteResumes.execute(owner, f.identity, command, async () => {
          let checks = 0;
          return () => {
            if (which === "commit" && ++checks === 2) f.advance(60000);
          };
        }),
      );
      unchanged(f);
    } finally {
      f.close();
    }
  }
});
test("new approval revokes old authority, while altered task/profile and wrong task revision are denied", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    const next = {
      ...f.approval,
      identity: { ...f.identity, permissionId: randomUUID() },
    };
    f.store.remoteResumes.approve(owner, next);
    await assert.rejects(
      f.store.remoteResumes.execute(owner, f.identity, f.command, allow),
      /NOT_FOUND/,
    );
    const command = { ...f.command, permissionId: next.identity.permissionId };
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        next.identity,
        { ...command, expectedRevision: 1 },
        allow,
      ),
      /CONFLICT/,
    );
    f.store.db
      .prepare(
        "UPDATE model_profiles SET payload=? WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .run(
        f.vault.seal(
          { ...profile, temperature: 0.7 },
          "profile:personal:owner:synthetic",
        ),
        owner.userId,
        owner.tenantId,
        profile.id,
      );
    await assert.rejects(
      f.store.remoteResumes.execute(owner, next.identity, command, allow),
      /CONFLICT/,
    );
    unchanged(f);
  } finally {
    f.close();
  }
});
test("backup recovery locks resume grants, preserves receipts and refuses reapproval of old identity", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    await f.store.remoteResumes.execute(owner, f.identity, f.command, allow);
    const file = join(f.dir, "backup.enc"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, file);
    await restoreBackup(file, f.vault, path);
    restored = new Store(path, f.vault, () => f.now);
    assert.deepEqual(
      restored.remoteResumes.receipts(owner),
      f.store.remoteResumes.receipts(owner),
    );
    assert.equal(restored.remoteResumes.history(owner)[0]!.revoked, true);
    assert.throws(
      () =>
        restored!.remoteResumes.checkExecutionModel(owner, f.task.id, {
          profile,
          digest: "a".repeat(64),
        }),
      /NOT_FOUND/,
    );
    await assert.rejects(
      restored.remoteResumes.execute(owner, f.identity, f.command, allow),
      /NOT_FOUND/,
    );
    assert.throws(() => restored!.remoteResumes.approve(owner, f.approval));
  } finally {
    restored?.close();
    f.close();
  }
});

test("receipt storage failure rolls back task transition and leaves the single use available", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    f.store.db.exec(
      "CREATE TRIGGER reject_resume BEFORE INSERT ON remote_resume_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END",
    );
    await assert.rejects(
      f.store.remoteResumes.execute(owner, f.identity, f.command, allow),
      /synthetic receipt write failure/,
    );
    unchanged(f);
    assert.equal(
      f.store.remoteResumes.history(owner)[0]!.permission!.consumed,
      false,
    );
    f.store.db.exec("DROP TRIGGER reject_resume");
    assert.equal(
      (await f.store.remoteResumes.execute(owner, f.identity, f.command, allow))
        .receipt.outcome,
      "queued",
    );
  } finally {
    f.close();
  }
});
test("owner deletion erases resume grants and receipts without affecting another owner", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    await f.store.remoteResumes.execute(owner, f.identity, f.command, allow);
    f.store.db
      .prepare("INSERT INTO remote_resume_permissions VALUES(?,?,?,?,?,NULL)")
      .run(
        other.userId,
        other.tenantId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      );
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.remoteResumes.history(owner), []);
    assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
    assert.equal(f.store.remoteResumes.history(other).length, 1);
  } finally {
    f.close();
  }
});
test("unused resume grant cannot execute after backup recovery", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    const backup = join(f.dir, "unused.enc"),
      path = join(f.dir, "unused.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    restored = new Store(path, f.vault, () => f.now);
    await assert.rejects(
      restored.remoteResumes.execute(owner, f.identity, f.command, allow),
      /NOT_FOUND/,
    );
    assert.equal(restored.get(owner, f.task.id).status, "paused");
    assert.deepEqual(restored.remoteResumes.receipts(owner), []);
  } finally {
    restored?.close();
    f.close();
  }
});
test("tampered encrypted resume permission fails closed without a task effect", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    const row = f.store.db
      .prepare("SELECT payload FROM remote_resume_permissions WHERE id=?")
      .get(f.identity.permissionId) as { payload: Buffer };
    row.payload[20] = row.payload[20]! ^ 1;
    f.store.db
      .prepare("UPDATE remote_resume_permissions SET payload=? WHERE id=?")
      .run(row.payload, f.identity.permissionId);
    await assert.rejects(
      f.store.remoteResumes.execute(owner, f.identity, f.command, allow),
    );
    unchanged(f);
  } finally {
    f.close();
  }
});

test("an accidentally asynchronous commit guard cannot authorize resume", async () => {
  const f = fixture();
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        f.identity,
        f.command,
        async () => async () => {
          throw Error("late access rejection");
        },
      ),
      /INVALID_INPUT/,
    );
    unchanged(f);
    assert.equal(
      f.store.remoteResumes.history(owner)[0]!.permission!.consumed,
      false,
    );
  } finally {
    f.close();
  }
});

test("remote resume binds the approved digest into access validation and worker execution", async () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.store.remoteResumes.approve(owner, {
        ...f.approval,
        modelDigest: undefined,
      }),
    );
    f.store.remoteResumes.approve(owner, f.approval);
    await f.store.remoteResumes.execute(
      owner,
      f.identity,
      f.command,
      async (_task, _profile, digest) => {
        assert.equal(digest, "a".repeat(64));
        return () => {};
      },
    );
    f.reopen();
    let generated = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "b".repeat(64) }),
        generate: async () => {
          generated++;
          return "WRONG_MODEL";
        },
      },
      () => profile,
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(generated, 0);
    assert.notEqual(f.store.get(owner, f.task.id).status, "completed");
  } finally {
    f.close();
  }
});

test("remote resume denies revoked or expired grants after queueing and drops late results", async () => {
  for (const change of [
    "revoke-before",
    "expire-before",
    "revoke-during",
    "profile-during",
  ] as const) {
    const f = fixture();
    try {
      f.store.remoteResumes.approve(owner, f.approval);
      await f.store.remoteResumes.execute(owner, f.identity, f.command, allow);
      const revoke = () =>
        f.store.remoteResumes.revoke(owner, f.identity.deviceId);
      if (change === "revoke-before") revoke();
      if (change === "expire-before") f.advance(600000);
      let generated = 0;
      const worker = new LocalWorker(
        f.store,
        owner,
        {
          pin: async () => ({ profile, digest: "a".repeat(64) }),
          generate: async () => {
            generated++;
            if (change === "revoke-during") revoke();
            if (change === "profile-during")
              f.store.addProfile(owner, { ...profile, temperature: 1 });
            return "LATE_RESULT";
          },
        },
        () => profile,
      );
      await worker.runOnce();
      assert.equal(generated, change.endsWith("before") ? 0 : 1);
      assert.notEqual(f.store.get(owner, f.task.id).status, "completed");
    } finally {
      f.close();
    }
  }
});

test("remote resume fences clarification generation and discards revoked decisions", async () => {
  const f = fixture(false, true);
  try {
    f.store.remoteResumes.approve(owner, f.approval);
    await f.store.remoteResumes.execute(owner, f.identity, f.command, allow);
    let generated = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          generated++;
          f.store.remoteResumes.revoke(owner, f.identity.deviceId);
          return JSON.stringify({ decision: "proceed" });
        },
      },
      () => profile,
    );
    await worker.runOnce();
    assert.equal(generated, 1);
    assert.notEqual(f.store.get(owner, f.task.id).status, "completed");
  } finally {
    f.close();
  }
});

test("host resume access validates the exact local model and commits only with fresh dependencies", async () => {
  for (const mode of [
    "valid",
    "digest",
    "profile",
    "unavailable",
    "expired",
    "changed",
  ] as const) {
    const f = fixture();
    try {
      f.store.remoteResumes.approve(owner, f.approval);
      let calls = 0;
      const access = resumeTaskAccess(
        f.store,
        owner,
        new SourceTasks(),
        {
          pin: async (raw, signal) => {
            assert.equal(f.store.db.inTransaction, false);
            assert.ok(signal);
            assert.deepEqual(raw, profile);
            calls++;
            if (mode === "unavailable") throw new Error("MODEL_UNAVAILABLE");
            if (mode === "expired") f.advance(10000);
            if (mode === "changed")
              f.store.addProfile(owner, { ...profile, temperature: 1 });
            return {
              profile:
                mode === "profile" ? { ...profile, temperature: 1 } : profile,
              digest: (mode === "digest" ? "b" : "a").repeat(64),
            };
          },
        },
        undefined,
        () => f.now,
        () => f.now,
      );
      if (mode === "valid") {
        await f.store.remoteResumes.execute(
          owner,
          f.identity,
          f.command,
          access,
        );
        assert.equal(f.store.get(owner, f.task.id).status, "queued");
      } else {
        await assert.rejects(
          f.store.remoteResumes.execute(owner, f.identity, f.command, access),
        );
        unchanged(f);
      }
      assert.equal(calls, 1);
    } finally {
      f.close();
    }
  }
});

test("host resume access rejects wrong owner and stale task before model access", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runtime = {
      pin: async () => {
        calls++;
        return { profile, digest: "a".repeat(64) };
      },
    };
    await assert.rejects(
      resumeTaskAccess(
        f.store,
        other,
        new SourceTasks(),
        runtime,
      )(f.task, profile, "a".repeat(64)),
    );
    const stale = { ...f.task, revision: f.task.revision + 1 };
    await assert.rejects(
      resumeTaskAccess(
        f.store,
        owner,
        new SourceTasks(),
        runtime,
      )(stale, profile, "a".repeat(64)),
    );
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});

// A synthetic durable receiver journal isolates the transaction contract here.
// These tests do not claim encryption, shared-ledger or private-consent wiring.
function admissionProbe(f: ReturnType<typeof fixture>) {
  f.store.db.exec(
    "CREATE TABLE resume_admission_probe(id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  );
  const count = () =>
    (
      f.store.db
        .prepare("SELECT count(*) AS n FROM resume_admission_probe")
        .get() as { n: number }
    ).n;
  let valid = true,
    failAfterWrite = false;
  return {
    count,
    revoke() {
      valid = false;
    },
    failAfterWrite() {
      failAfterWrite = true;
    },
    hooks: {
      check() {
        assert.equal(f.store.db.inTransaction, true);
        if (!valid) throw Error("PRIVATE_CONSENT_ENDED");
      },
      admit(receipt: { id: string }) {
        assert.equal(f.store.db.inTransaction, true);
        const payload = JSON.stringify(receipt);
        const row = f.store.db
          .prepare("SELECT payload FROM resume_admission_probe WHERE id=?")
          .get(receipt.id) as { payload: string } | undefined;
        if (row) {
          assert.equal(row.payload, payload);
          return "duplicate" as const;
        }
        f.store.db
          .prepare("INSERT INTO resume_admission_probe VALUES(?,?)")
          .run(receipt.id, payload);
        if (failAfterWrite) throw Error("AFTER_ADMISSION_WRITE");
        return "new" as const;
      },
    },
  };
}
test("delivery admission shares durable resume effects across concurrent calls and restart", async () => {
  const f = fixture();
  try {
    const journal = admissionProbe(f);
    f.store.remoteResumes.approve(owner, f.approval);
    const results = await Promise.all(
      [1, 2].map(() =>
        f.store.remoteResumes.executeDelivery(
          owner,
          f.identity,
          f.command,
          allow,
          journal.hooks,
        ),
      ),
    );
    assert.deepEqual(results.map((v) => v.duplicate).sort(), [false, true]);
    assert.equal(journal.count(), 1);
    f.reopen();
    const duplicate = await f.store.remoteResumes.executeDelivery(
      owner,
      f.identity,
      f.command,
      undefined,
      journal.hooks,
    );
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, results[0]!.receipt);
    assert.equal(f.store.get(owner, f.task.id).revision, f.task.revision + 1);
    journal.revoke();
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        undefined,
        journal.hooks,
      ),
      /PRIVATE_CONSENT_ENDED/,
    );
    assert.equal(journal.count(), 1);
  } finally {
    f.close();
  }
});
test("delivery failure after journal write rolls back task, consumed permission, receipt and journal", async () => {
  const f = fixture();
  try {
    const journal = admissionProbe(f);
    f.store.remoteResumes.approve(owner, f.approval);
    journal.failAfterWrite();
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        allow,
        journal.hooks,
      ),
      /AFTER_ADMISSION_WRITE/,
    );
    unchanged(f);
    assert.equal(journal.count(), 0);
    // Permission was not consumed; an ordinary explicit local authority check
    // can still apply the same command after the failed delivery transaction.
    const accepted = await f.store.remoteResumes.execute(
      owner,
      f.identity,
      f.command,
      allow,
    );
    assert.equal(accepted.duplicate, false);
  } finally {
    f.close();
  }
});
test("late private-consent loss rolls back accepted journal and all resume effects", async () => {
  const f = fixture();
  try {
    const journal = admissionProbe(f);
    f.store.remoteResumes.approve(owner, f.approval);
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        allow,
        {
          check: journal.hooks.check,
          admit(receipt) {
            const result = journal.hooks.admit(receipt);
            journal.revoke();
            return result;
          },
        },
      ),
      /PRIVATE_CONSENT_ENDED/,
    );
    unchanged(f);
    assert.equal(journal.count(), 0);
  } finally {
    f.close();
  }
});
test("delivery rejects replay classification mismatch and cannot invent admission for old plain receipt", async () => {
  const f = fixture();
  try {
    const journal = admissionProbe(f);
    f.store.remoteResumes.approve(owner, f.approval);
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        allow,
        {
          check: journal.hooks.check,
          admit() {
            return "duplicate";
          },
        },
      ),
      /CONFLICT/,
    );
    unchanged(f);
    await f.store.remoteResumes.execute(owner, f.identity, f.command, allow);
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        undefined,
        journal.hooks,
      ),
      /CONFLICT/,
    );
    assert.equal(journal.count(), 0);
    assert.equal(f.store.remoteResumes.receipts(owner).length, 1);
  } finally {
    f.close();
  }
});
test("delivery denies consent before source access and rejects accidentally async admission guards", async () => {
  const f = fixture();
  try {
    const journal = admissionProbe(f);
    f.store.remoteResumes.approve(owner, f.approval);
    journal.revoke();
    let accesses = 0;
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        async () => {
          accesses++;
          return () => {};
        },
        journal.hooks,
      ),
      /PRIVATE_CONSENT_ENDED/,
    );
    assert.equal(accesses, 0);
    await assert.rejects(
      f.store.remoteResumes.executeDelivery(
        owner,
        f.identity,
        f.command,
        allow,
        { ...journal.hooks, check: async () => {} },
      ),
      /INVALID_INPUT/,
    );
    unchanged(f);
    assert.equal(journal.count(), 0);
  } finally {
    f.close();
  }
});
