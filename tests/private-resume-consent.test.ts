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
