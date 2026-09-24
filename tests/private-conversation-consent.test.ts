import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { conversationFixture, owner } from "./helpers/conversation-fixture.js";
import { PrivateTaskConsent } from "../modules/remote/private-task-consent.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
const scope = (g: { id: string; conversationRef: string }) => ({
  permissionId: g.id,
  conversationRef: g.conversationRef,
});
test("conversation permission is separate from task authority and binds one selected thread, Inbox and direction", async () => {
  const f = await conversationFixture();
  try {
    assert.equal(f.consent.list().grants.length, 0);
    await assert.rejects(f.consent.resolve(randomUUID()), /DENIED/);
    const review = await f.prepare();
    review.grant.choices.permissions.answersToMac = true; // Returned view is not authority.
    const { grant } = f.approve(review);
    const access = await f.consent.resolve(grant.id);
    assert.equal(
      access.access(scope(grant), "messagesToMac")?.grant.choices
        .conversationId,
      f.choices.conversationId,
    );
    assert.equal(access.access(scope(grant), "answersToMac"), null);
    assert.equal(access.access(scope(grant), "questionsToBrowser"), null);
    assert.equal(
      access.access(
        { ...scope(grant), conversationRef: randomUUID() },
        "messagesToMac",
      ),
      null,
    );
    assert.equal(
      access.access(
        { ...scope(grant), permissionId: randomUUID() },
        "messagesToMac",
      ),
      null,
    );
    const copy = access.access(scope(grant), "messagesToMac")!;
    copy.grant.choices.permissions.answersToMac = true;
    assert.equal(access.access(scope(grant), "answersToMac"), null);
    const tasks = new PrivateTaskConsent(
      f.store,
      f.vault,
      owner,
      f.current,
      f.keys,
      f.peers,
      f.clock,
    );
    assert.deepEqual(tasks.list().grants, []);
    await assert.rejects(tasks.resolve(f.peerId), /DENIED/);
    assert.throws(() => f.approve(review), /DENIED/);
    assert.deepEqual(
      f.store.exportPrivateConversationConsent(owner),
      f.consent.list(),
    );
    f.store.db.pragma("wal_checkpoint(TRUNCATE)");
    assert.equal(
      readFileSync(f.path).includes(Buffer.from(grant.conversationRef)),
      false,
    );
  } finally {
    f.close();
  }
});
test("conversation selection rejects unknown and foreign threads, nonpersonal Inboxes and extra task or source rights", async () => {
  const f = await conversationFixture();
  try {
    await assert.rejects(f.prepare({ conversationId: "missing" }), /DENIED/);
    await assert.rejects(f.prepare({ inboxId: "missing" }), /DENIED/);
    await assert.rejects(
      f.prepare({ permissions: { ...f.choices.permissions, publish: true } }),
      /DENIED/,
    );
    await assert.rejects(f.prepare({ modelProfileId: "local" }), /DENIED/);
    await assert.rejects(
      f.prepare({ expiresAt: f.clock() + 86400001 }),
      /DENIED/,
    );
    await assert.rejects(
      f.prepare({ expiresAt: f.binding.expiresAt + 1 }),
      /DENIED/,
    );
    const other = { ...owner, userId: "other" };
    f.store.createInbox(other, {
      ...f.inbox,
      ownerId: other.userId,
      memberUserIds: [other.userId],
    });
    const foreign = randomUUID();
    f.store.appendMessage(
      other,
      {
        conversationId: foreign,
        recipientInboxId: f.inbox.id,
        type: "notification",
        content: "FOREIGN",
      },
      randomUUID(),
    );
    await assert.rejects(f.prepare({ conversationId: foreign }), /DENIED/);
    for (const change of [
      { ownerType: "agent", ownerId: "agent" },
      { teamId: "team" },
      { memberUserIds: [owner.userId, owner.userId] },
    ]) {
      f.store.createInbox(owner, { ...f.inbox, ...change });
      await assert.rejects(f.prepare(), /DENIED/);
    }
    assert.equal(f.consent.list().revision, 0);
  } finally {
    f.close();
  }
});
test("current Inbox identity, binding, expiry and explicit revocation invalidate already resolved conversation handles", async () => {
  const f = await conversationFixture();
  try {
    let grant = f.approve(await f.prepare()).grant;
    let provider = await f.consent.resolve(grant.id);
    f.store.createInbox(owner, f.inbox);
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    await assert.rejects(f.consent.resolve(grant.id), /DENIED/);
    grant = f.approve(await f.prepare()).grant;
    provider = await f.consent.resolve(grant.id);
    f.setBinding(null);
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    f.setBinding(f.binding);
    assert.ok(provider.access(scope(grant), "messagesToMac"));
    f.time(grant.choices.expiresAt);
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    f.setBinding(null); // Revocation and export still work offline.
    const before = f.consent.list();
    f.consent.revoke({
      permissionId: grant.id,
      expectedRevision: before.revision,
      confirmed: true,
    });
    assert.equal(f.consent.list().grants[0]?.revoked, true);
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    assert.throws(
      () =>
        f.consent.revoke({
          permissionId: grant.id,
          expectedRevision: before.revision,
          confirmed: true,
        }),
      /CONFLICT/,
    );
  } finally {
    f.close();
  }
});
test("renewal keeps the opaque thread reference but replaces permission identity and fences old handles", async () => {
  const f = await conversationFixture();
  try {
    const first = f.approve(await f.prepare()).grant;
    const old = await f.consent.resolve(first.id);
    const second = f.approve(
      await f.prepare({
        permissions: {
          ...f.choices.permissions,
          questionsToBrowser: true,
          answersToMac: true,
        },
      }),
    ).grant;
    assert.equal(second.conversationRef, first.conversationRef);
    assert.notEqual(second.id, first.id);
    assert.equal(old.access(scope(first), "messagesToMac"), null);
    const current = await f.consent.resolve(second.id);
    assert.equal(current.access(scope(first), "messagesToMac"), null);
    assert.ok(current.access(scope(second), "answersToMac"));
    const nextThread = randomUUID();
    f.store.appendMessage(
      owner,
      {
        conversationId: nextThread,
        recipientInboxId: f.inbox.id,
        type: "notification",
        content: "SECOND_THREAD",
      },
      randomUUID(),
    );
    const third = f.approve(
      await f.prepare({ conversationId: nextThread }),
    ).grant;
    assert.notEqual(third.conversationRef, first.conversationRef);
    assert.equal(f.consent.list().grants.length, 2);
    assert.ok(current.access(scope(second), "messagesToMac"));
  } finally {
    f.close();
  }
});
test("conversation review expires on wall or monotonic time and is invalidated by scope changes or concurrent reviews", async () => {
  const f = await conversationFixture();
  try {
    let r = await f.prepare();
    f.monotonic(300000);
    assert.throws(() => f.approve(r), /DENIED/);
    r = await f.prepare();
    f.time(f.clock() - 1);
    assert.throws(() => f.approve(r), /DENIED/);
    f.time(1800000000000);
    r = await f.prepare();
    f.store.createInbox(owner, f.inbox);
    assert.throws(() => f.approve(r), /DENIED/);
    r = await f.prepare();
    f.consent.invalidate();
    assert.throws(() => f.approve(r), /DENIED/);
    r = await f.prepare();
    const competing = f.build().consent;
    f.approve(await f.prepare({}, competing), competing);
    assert.throws(() => f.approve(r), /CONFLICT/);
    assert.equal(f.consent.list().grants.length, 1);
  } finally {
    f.close();
  }
});
test("restore locks conversation access and re-review never revives other restored grants", async () => {
  const f = await conversationFixture();
  try {
    const first = f.approve(await f.prepare()).grant;
    const nextThread = randomUUID();
    f.store.appendMessage(
      owner,
      {
        conversationId: nextThread,
        recipientInboxId: f.inbox.id,
        type: "notification",
        content: "SECOND_THREAD",
      },
      randomUUID(),
    );
    const second = f.approve(
      await f.prepare({ conversationId: nextThread }),
    ).grant;
    const backup = join(f.dir, "backup.aib"),
      restoredPath = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restoredPath);
    const restored = new Store(restoredPath, f.vault, f.clock);
    try {
      const c = f.build(restored).consent;
      assert.equal(c.list().needsReview, true);
      assert.equal(c.list().grants.length, 2);
      await assert.rejects(c.resolve(first.id), /DENIED/);
      // Isolate consent's restore lock using still-valid original key proofs;
      // actual restored keys and peer checks are independently locked as well.
      const provider = await f.consent.resolve(second.id);
      f.store.db
        .prepare(
          "UPDATE private_conversation_consents SET locked=1,revision=revision+1",
        )
        .run();
      assert.equal(provider.access(scope(second), "messagesToMac"), null);
      const fresh = f.approve(await f.prepare()).grant;
      assert.notEqual(fresh.id, first.id);
      assert.equal(f.consent.list().needsReview, false);
      assert.equal(
        f.consent.list().grants.find((g) => g.id === second.id)?.revoked,
        true,
      );
      assert.equal(provider.access(scope(second), "messagesToMac"), null);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});
test("deletion leaves a revision tombstone and corrupt consent denies access without silently recreating it", async () => {
  const f = await conversationFixture();
  try {
    const grant = f.approve(await f.prepare()).grant;
    const provider = await f.consent.resolve(grant.id);
    f.store.db
      .prepare("UPDATE private_conversation_consents SET payload=?")
      .run(Buffer.from("corrupt"));
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    assert.throws(() => f.consent.list(), /STORAGE_UNAVAILABLE/);
    await assert.rejects(
      f.consent.prepare({ expectedRevision: 1, choices: f.choices }),
      /STORAGE_UNAVAILABLE/,
    );
    f.store.deleteAll(owner);
    const after = f.store.exportPrivateConversationConsent(owner);
    assert.equal(after.revision, 2);
    assert.equal(after.needsReview, true);
    assert.deepEqual(after.grants, []);
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
  } finally {
    f.close();
  }
});
test("pending native key resolution cannot approve after invalidation and a revoked peer invalidates resolved access", async () => {
  const f = await conversationFixture();
  try {
    for (const slot of f.slots.values())
      slot.key.beforeRead = async () => f.consent.invalidate();
    await assert.rejects(f.prepare(), /CONFLICT/);
    assert.equal(f.consent.list().revision, 0);
    for (const slot of f.slots.values()) slot.key.beforeRead = undefined;
    const grant = f.approve(await f.prepare()).grant;
    const provider = await f.consent.resolve(grant.id);
    f.peers.revoke({
      peerId: f.peerId,
      expectedRevision: f.peers.list().revision,
      confirmed: true,
    });
    assert.equal(provider.access(scope(grant), "messagesToMac"), null);
    await assert.rejects(f.consent.resolve(grant.id), /DENIED/);
  } finally {
    f.close();
  }
});
test("conversation grant capacity is bounded while renewing an existing thread remains possible", async () => {
  const f = await conversationFixture();
  try {
    for (let i = 0; i < 64; i++) {
      const conversationId = i === 0 ? f.choices.conversationId : randomUUID();
      if (i)
        f.store.appendMessage(
          owner,
          {
            conversationId,
            recipientInboxId: f.inbox.id,
            type: "notification",
            content: "CAPACITY",
          },
          randomUUID(),
        );
      f.approve(await f.prepare({ conversationId }));
    }
    await assert.rejects(
      f.prepare({ conversationId: randomUUID() }),
      /CAPACITY/,
    );
    f.approve(await f.prepare());
    assert.equal(f.consent.list().grants.length, 64);
    assert.equal(f.consent.list().revision, 65);
  } finally {
    f.close();
  }
});
