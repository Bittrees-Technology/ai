import {
  PrivateResumeDelivery,
  privateResumeReceiptSchema,
} from "../modules/remote/private-resume-delivery.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
import { exportPrivateIncomingReplay } from "../modules/remote/private-incoming-replay.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { conversationFixture, owner } from "./helpers/conversation-fixture.js";
import { PrivateResumeConsent } from "../modules/remote/private-resume-consent.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { LocalWorker } from "../apps/companion/worker.js";
const profile = {
  id: "resume",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
async function fixture() {
  const f = await conversationFixture();
  f.store.addProfile(owner, profile);
  let task = f.store.create(
    owner,
    {
      conversationId: randomUUID(),
      kind: "query",
      prompt: "SYNTHETIC_RESUME",
      modelProfileId: profile.id,
    },
    randomUUID(),
  );
  task = f.store.command(owner, task.id, {
    command: "pause",
    expectedRevision: task.revision,
  });
  const build = (store = f.store) => {
    const k = f.build(store);
    return new PrivateResumeConsent(
      store,
      f.vault,
      owner,
      f.current,
      k.keys,
      k.peers,
      f.clock,
    );
  };
  const consent = build(),
    choices = {
      peerId: f.peerId,
      peerKeyEpoch: 1,
      taskId: task.id,
      taskRevision: task.revision,
      modelDigest: "a".repeat(64),
      expiresAt: f.clock() + 600000,
    };
  const prepare = (overrides = {}) =>
    consent.prepare({
      expectedRevision: consent.list().revision,
      choices: { ...choices, ...overrides },
    });
  const approve = (r: Awaited<ReturnType<typeof prepare>>) =>
    consent.approve({
      reviewId: r.id,
      expectedRevision: r.revision,
      confirmed: true,
      acknowledged: true,
    });
  return { ...f, task, consent, choices, prepare, approve, buildResume: build };
}
function command(f: Awaited<ReturnType<typeof fixture>>, permissionId: string) {
  return {
    version: 1,
    id: randomUUID(),
    deviceId: f.binding.deviceId,
    permissionId,
    taskId: f.task.id,
    expectedRevision: f.task.revision,
    command: "resume",
    issuedAt: new Date(f.clock()).toISOString(),
    expiresAt: new Date(f.clock() + 60000).toISOString(),
  };
}
test("private resume reviews one paused task and does not inherit conversation authority", async () => {
  const f = await fixture();
  try {
    f.consent.list();
    f.approve(await f.prepare());
    const first = f.consent.list().grants[0]!;
    const handle = await f.consent.resolve(first.id);
    assert.equal(handle.identity.permissionId, first.id);
    assert.deepEqual(
      f.store.exportPrivateResumeConsent(owner),
      f.consent.list(),
    );
    assert.equal(
      f.store.exportPrivateConversationConsent(owner).grants.length,
      0,
    );
    const r = await f.prepare();
    r.grant.choices.modelDigest = "b".repeat(64);
    const next = f.approve(r).grant;
    assert.equal(next.choices.modelDigest, "a".repeat(64));
    assert.throws(handle.check, /DENIED/);
    assert.throws(() => f.approve(r), /DENIED/);
    await assert.rejects(
      f.prepare({ taskRevision: f.task.revision + 1 }),
      /CONFLICT/,
    );
    await assert.rejects(
      f.prepare({ expiresAt: f.clock() + 86400001 }),
      /DENIED/,
    );
    await assert.rejects(f.prepare({ receiveTasks: true }), /DENIED/);
  } finally {
    f.close();
  }
});
test("private resume requires delivery admission and a live private worker authority", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      handle = await f.consent.resolve(grant.id),
      cmd = command(f, grant.id);
    await assert.rejects(
      f.store.remoteResumes.execute(
        owner,
        handle.identity,
        cmd,
        async () => () => {},
      ),
      /NOT_FOUND/,
    );
    await f.store.remoteResumes.executeDelivery(
      owner,
      handle.identity,
      cmd,
      async () => () => {},
      { check: handle.check, admit: () => "new" },
    );
    const pinned = { profile, digest: "a".repeat(64) };
    assert.throws(
      () => f.store.remoteResumes.checkExecutionModel(owner, f.task.id, pinned),
      /NOT_FOUND/,
    );
    f.store.remoteResumes.checkExecutionModel(
      owner,
      f.task.id,
      pinned,
      (id) => {
        f.consent.check(id);
      },
    );
    f.setBinding({ ...f.binding, credentialEpoch: 2 });
    assert.throws(
      () =>
        f.store.remoteResumes.checkExecutionModel(
          owner,
          f.task.id,
          pinned,
          (id) => {
            f.consent.check(id);
          },
        ),
      /DENIED/,
    );
    assert.throws(handle.check, /DENIED/);
  } finally {
    f.close();
  }
});
test("private resume drops late worker output after peer authority changes", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      handle = await f.consent.resolve(grant.id);
    await f.store.remoteResumes.executeDelivery(
      owner,
      handle.identity,
      command(f, grant.id),
      async () => () => {},
      { check: handle.check, admit: () => "new" },
    );
    let generated = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          generated++;
          f.setBinding(null);
          return "LATE_PRIVATE_OUTPUT";
        },
      },
      () => profile,
      "worker",
      undefined,
      undefined,
      undefined,
      (id) => {
        f.consent.check(id);
      },
    );
    await worker.runOnce();
    assert.equal(generated, 1);
    assert.notEqual(f.store.get(owner, f.task.id).status, "completed");
    assert.equal(
      JSON.stringify(f.store.get(owner, f.task.id)).includes(
        "LATE_PRIVATE_OUTPUT",
      ),
      false,
    );
  } finally {
    f.close();
  }
});
test("private resume restore locks consent and owner deletion retains a review tombstone", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant;
    const backup = join(f.dir, "backup.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    const restored = new Store(path, f.vault, f.clock);
    try {
      const consent = f.buildResume(restored);
      assert.equal(consent.list().needsReview, true);
      assert.throws(() => consent.check(grant.id), /DENIED/);
      assert.equal(restored.remoteResumes.history(owner)[0]!.revoked, true);
    } finally {
      restored.close();
    }
    f.store.deleteAll(owner);
    const after = f.store.exportPrivateResumeConsent(owner);
    assert.equal(after.needsReview, true);
    assert.equal(after.revision, 2);
    assert.deepEqual(after.grants, []);
  } finally {
    f.close();
  }
});
test("private resume pending reviews and resolved handles reject peer or local-key changes", async () => {
  for (const change of ["peer", "local"] as const) {
    const f = await fixture();
    try {
      const grant = f.approve(await f.prepare()).grant;
      const handle = await f.consent.resolve(grant.id);
      const pending = await f.prepare();
      if (change === "peer")
        f.peers.revoke({
          peerId: f.peerId,
          expectedRevision: f.peers.list().revision,
          confirmed: true,
        });
      else
        f.keys.revoke({
          keyId: grant.local.keyId,
          expectedRevision: grant.local.revision,
          confirmed: true,
        });
      assert.throws(handle.check, /DENIED/);
      assert.throws(() => f.approve(pending), /DENIED/);
      assert.equal(f.consent.list().grants.length, 1);
      await assert.rejects(f.consent.resolve(grant.id), /DENIED/);
    } finally {
      f.close();
    }
  }
});
test("private resume invalidation during key resolution and profile changes cannot approve stale review", async () => {
  const f = await fixture();
  try {
    for (const slot of f.slots.values())
      slot.key.beforeRead = async () => f.consent.invalidate();
    await assert.rejects(f.prepare(), /CONFLICT/);
    for (const slot of f.slots.values()) slot.key.beforeRead = undefined;
    const pending = await f.prepare();
    f.store.db
      .prepare(
        "UPDATE model_profiles SET payload=? WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .run(
        f.vault.seal(
          { ...profile, temperature: 0.5 },
          "profile:" + owner.tenantId + ":" + owner.userId + ":" + profile.id,
        ),
        profile.id,
        owner.userId,
        owner.tenantId,
      );
    assert.throws(() => f.approve(pending), /DENIED/);
    assert.deepEqual(f.store.remoteResumes.history(owner), []);
    assert.equal(f.consent.list().revision, 0);
  } finally {
    f.close();
  }
});
test("private resume explicit revocation and corrupt retained consent fail closed", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant;
    const handle = await f.consent.resolve(grant.id);
    f.consent.revoke({
      permissionId: grant.id,
      expectedRevision: f.consent.list().revision,
      confirmed: true,
    });
    assert.throws(handle.check, /DENIED/);
    assert.equal(
      f.store.remoteResumes.history(owner).find((p) => p.id === grant.id)!
        .revoked,
      true,
    );
    const second = f.approve(await f.prepare()).grant;
    f.store.db
      .prepare("UPDATE private_resume_consents SET payload=?")
      .run(Buffer.from("corrupt"));
    assert.throws(() => f.consent.check(second.id), /STORAGE_UNAVAILABLE/);
    await assert.rejects(f.consent.resolve(second.id), /STORAGE_UNAVAILABLE/);
  } finally {
    f.close();
  }
});

async function encryptedCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  permissionId: string,
  overrides = {},
  headerOverrides = {},
  sender = f.sender,
) {
  const cmd = { ...command(f, permissionId), ...overrides };
  const key = await f.keys.resolve();
  const header = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: f.binding.ownerId,
    senderId: f.peerId,
    recipientId: f.binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: key.proof.keyEpoch,
    messageId: randomUUID(),
    operationId: cmd.id,
    sequence: 90,
    issuedAt: Date.parse(cmd.issuedAt),
    expiresAt: Date.parse(cmd.expiresAt),
    ...headerOverrides,
  };
  const envelope = await sealPrivateEnvelope(
    header,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, type: "task.resume", command: cmd }),
    ),
    { senderKey: sender, recipientPublicKey: key.pair.publicKey },
    f.clock,
  );
  return { cmd, envelope, input: { permissionId, envelope, confirmed: true } };
}
function delivery(
  f: Awaited<ReturnType<typeof fixture>>,
  store = f.store,
  access = async () => () => {},
) {
  return new PrivateResumeDelivery(
    store,
    f.vault,
    owner,
    f.buildResume(store),
    access,
    f.clock,
  );
}
test("encrypted resume admits once and returns the original authenticated receipt across concurrent calls and reopen", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, grant.id),
      receiver = delivery(f);
    const accepted = await Promise.all([
      receiver.receive(wire.input),
      delivery(f).receive(wire.input),
    ]);
    assert.deepEqual(accepted.map((r) => r.duplicate).sort(), [false, true]);
    assert.equal(f.store.get(owner, f.task.id).revision, f.task.revision + 1);
    const replay = exportPrivateIncomingReplay(f.store, f.vault, owner).filter(
      (r) => r.identity.type === "task.resume",
    );
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.outcome.collection, "remote_resume_receipts");
    const request = {
      permissionId: grant.id,
      commandId: wire.cmd.id,
      confirmed: true,
    };
    const [first, second] = await Promise.all([
      receiver.receipt(request),
      delivery(f).receipt(request),
    ]);
    assert.deepEqual(first, second);
    const key = await f.keys.resolve();
    const opened = await openPrivateEnvelope(
      first,
      first.header,
      { recipientKey: f.sender, senderPublicKey: key.pair.publicKey },
      f.clock,
    );
    try {
      const body = privateResumeReceiptSchema.parse(
        JSON.parse(new TextDecoder().decode(opened.plaintext)),
      );
      assert.deepEqual(body.receipt, accepted[0]!.receipt);
      assert.equal(body.receipt.outcome, "queued");
    } finally {
      opened.plaintext.fill(0);
    }
    const reopened = new Store(f.path, f.vault, f.clock);
    try {
      const next = delivery(f, reopened);
      assert.equal((await next.receive(wire.input)).duplicate, true);
      assert.deepEqual(await next.receipt(request), first);
      assert.equal(reopened.exportPrivateResumeDelivery(owner).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test("encrypted resume rejects wrong sender, task, scope and envelope operation before changing the task", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      receiver = delivery(f);
    const wrong = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    for (const wire of [
      await encryptedCommand(f, grant.id, {}, {}, wrong),
      await encryptedCommand(f, grant.id, { taskId: randomUUID() }),
      await encryptedCommand(f, grant.id, { permissionId: randomUUID() }),
      await encryptedCommand(f, grant.id, {}, { operationId: randomUUID() }),
    ]) {
      await assert.rejects(
        receiver.receive({ ...wire.input, permissionId: grant.id }),
      );
    }
    assert.equal(f.store.get(owner, f.task.id).status, "paused");
    assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
    assert.deepEqual(f.store.exportPrivateResumeDelivery(owner), []);
    assert.equal(
      exportPrivateIncomingReplay(f.store, f.vault, owner).some(
        (r) => r.identity.type === "task.resume",
      ),
      false,
    );
  } finally {
    f.close();
  }
});
test("encrypted resume rejects new ciphertext for a consumed operation and rechecks consent on duplicates", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, grant.id),
      receiver = delivery(f);
    await receiver.receive(wire.input);
    const changed = await encryptedCommand(f, grant.id, wire.cmd, {
      messageId: wire.envelope.header.messageId,
      sequence: wire.envelope.header.sequence,
    });
    await assert.rejects(receiver.receive(changed.input), /CONFLICT/);
    assert.equal(f.store.exportPrivateResumeDelivery(owner).length, 1);
    f.consent.revoke({
      permissionId: grant.id,
      expectedRevision: f.consent.list().revision,
      confirmed: true,
    });
    await assert.rejects(receiver.receive(wire.input), /DENIED/);
    await assert.rejects(
      receiver.receipt({
        permissionId: grant.id,
        commandId: wire.cmd.id,
        confirmed: true,
      }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("encrypted resume journal failure rolls back task, replay, receipt, sequence and permission use", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, grant.id),
      receiver = delivery(f);
    const beforeReplay = exportPrivateIncomingReplay(f.store, f.vault, owner);
    const beforeSequences = f.store.db
      .prepare("SELECT * FROM private_send_channels")
      .all();
    f.store.db.exec(
      "CREATE TRIGGER fail_resume_journal BEFORE INSERT ON private_resume_delivery BEGIN SELECT RAISE(ABORT,'JOURNAL_FAILURE'); END",
    );
    await assert.rejects(receiver.receive(wire.input), /JOURNAL_FAILURE/);
    assert.equal(f.store.get(owner, f.task.id).status, "paused");
    assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
    assert.deepEqual(
      exportPrivateIncomingReplay(f.store, f.vault, owner),
      beforeReplay,
    );
    assert.deepEqual(
      f.store.db.prepare("SELECT * FROM private_send_channels").all(),
      beforeSequences,
    );
    assert.equal(
      f.store.remoteResumes.history(owner)[0]!.permission!.consumed,
      false,
    );
    f.store.db.exec("DROP TRIGGER fail_resume_journal");
    assert.equal((await receiver.receive(wire.input)).duplicate, false);
  } finally {
    f.close();
  }
});
test("encrypted resume expiry, recovery and deletion never revive delivery authority", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, grant.id),
      receiver = delivery(f);
    await receiver.receive(wire.input);
    const backup = join(f.dir, "delivery.enc"),
      path = join(f.dir, "delivery-restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    const restored = new Store(path, f.vault, f.clock);
    try {
      assert.equal(
        restored.exportPrivateResumeDelivery(owner)[0]!.locked,
        true,
      );
      await assert.rejects(delivery(f, restored).receive(wire.input), /DENIED/);
    } finally {
      restored.close();
    }
    f.time(Date.parse(wire.cmd.expiresAt));
    await assert.rejects(receiver.receive(wire.input));
    assert.equal(f.store.get(owner, f.task.id).revision, f.task.revision + 1);
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateResumeDelivery(owner), []);
  } finally {
    f.close();
  }
});
test("encrypted resume rejects reused directed sequence for a separately approved operation", async () => {
  const f = await fixture();
  try {
    const first = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, first.id),
      receiver = delivery(f);
    await receiver.receive(wire.input);
    const current = f.store.get(owner, f.task.id);
    const paused = f.store.command(owner, f.task.id, {
      command: "pause",
      expectedRevision: current.revision,
    });
    const next = f.approve(
      await f.prepare({ taskRevision: paused.revision }),
    ).grant;
    const collision = await encryptedCommand(f, next.id, {
      expectedRevision: paused.revision,
    });
    await assert.rejects(receiver.receive(collision.input), /CONFLICT/);
    assert.equal(f.store.get(owner, f.task.id).revision, paused.revision);
    assert.equal(
      f.store.remoteResumes.history(owner).find((p) => p.id === next.id)!
        .permission!.consumed,
      false,
    );
    assert.equal(f.store.remoteResumes.receipts(owner).length, 1);
    const fresh = await encryptedCommand(
      f,
      next.id,
      { expectedRevision: paused.revision },
      { sequence: 91 },
    );
    assert.equal((await receiver.receive(fresh.input)).duplicate, false);
  } finally {
    f.close();
  }
});
test("encrypted resume rechecks private authority after async source validation and keeps replay available on denial", async () => {
  const f = await fixture();
  try {
    const grant = f.approve(await f.prepare()).grant,
      wire = await encryptedCommand(f, grant.id);
    const before = exportPrivateIncomingReplay(f.store, f.vault, owner);
    const receiver = delivery(f, f.store, async () => {
      assert.equal(f.store.db.inTransaction, false);
      f.consent.revoke({
        permissionId: grant.id,
        expectedRevision: f.consent.list().revision,
        confirmed: true,
      });
      return () => {};
    });
    await assert.rejects(receiver.receive(wire.input));
    assert.equal(f.store.get(owner, f.task.id).status, "paused");
    assert.deepEqual(
      exportPrivateIncomingReplay(f.store, f.vault, owner),
      before,
    );
    assert.deepEqual(f.store.exportPrivateResumeDelivery(owner), []);
    assert.deepEqual(f.store.remoteResumes.receipts(owner), []);
  } finally {
    f.close();
  }
});
