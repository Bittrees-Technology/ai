import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { conversationFixture, owner } from "./helpers/conversation-fixture.js";
import { PrivateResumeConsent } from "../modules/remote/private-resume-consent.js";
import { PrivateResumeOffers } from "../modules/remote/private-resume-offers.js";
import { privateResumeOfferSchema } from "../modules/remote/private-resume-contracts.js";
import { openPrivateEnvelope } from "../modules/remote/private-envelope.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
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
async function offersFixture() {
  const f = await fixture();
  const grant = await f.approve(await f.prepare());
  const offers = new PrivateResumeOffers(
    f.store,
    f.vault,
    owner,
    f.consent,
    f.clock,
  );
  const request = {
    clientRequestId: randomUUID(),
    permissionId: grant.grant.id,
    expectedConsentRevision: f.consent.list().revision,
    confirmed: true,
  };
  return { ...f, offers, request, grant };
}
const action = (e: { id: string; revision: number }) => ({
  id: e.id,
  expectedRevision: e.revision,
  confirmed: true,
});
test("resume offer retains exact original ciphertext across concurrent encryption, delivery and reopen without task text", async () => {
  const f = await offersFixture();
  try {
    const prepared = await f.offers.prepare(f.request);
    assert.equal(prepared.value.state, "preparing");
    assert.equal(prepared.value.envelope, null);
    assert.deepEqual(await f.offers.prepare(f.request), prepared);
    const [a, b] = await Promise.all([
      f.offers.resume(action(prepared)),
      new PrivateResumeOffers(
        f.store,
        f.vault,
        owner,
        f.buildResume(),
        f.clock,
      ).resume(action(prepared)),
    ]);
    assert.deepEqual(a, b);
    const envelope = await f.offers.delivery(action(a));
    const local = await f.keys.resolve();
    const opened = await openPrivateEnvelope(
      envelope,
      envelope.header,
      { recipientKey: f.sender, senderPublicKey: local.pair.publicKey },
      f.clock,
    );
    try {
      const offer = privateResumeOfferSchema.parse(
        JSON.parse(new TextDecoder().decode(opened.plaintext)),
      );
      assert.deepEqual(offer, {
        version: 1,
        type: "task.resume.offer",
        permissionId: f.request.permissionId,
        taskId: f.task.id,
        taskRevision: f.task.revision,
        modelDigest: f.choices.modelDigest,
        issuedAt: f.clock(),
        expiresAt: f.choices.expiresAt,
      });
      assert.equal(
        new TextDecoder().decode(opened.plaintext).includes("SYNTHETIC_RESUME"),
        false,
      );
    } finally {
      opened.plaintext.fill(0);
    }
    const reopened = new Store(f.path, f.vault, f.clock);
    try {
      const api = new PrivateResumeOffers(
        reopened,
        f.vault,
        owner,
        f.buildResume(reopened),
        f.clock,
      );
      assert.deepEqual(await api.delivery(action(a)), envelope);
      assert.equal(reopened.get(owner, f.task.id).status, "paused");
      assert.equal(reopened.exportPrivateResumeOffers(owner).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test("resume offer conflicts reject changed requests and revisions without allocating another record", async () => {
  const f = await offersFixture();
  try {
    const p = await f.offers.prepare(f.request);
    await assert.rejects(
      f.offers.prepare({ ...f.request, expiresAt: f.clock() + 100000 }),
    );
    await assert.rejects(
      f.offers.resume({ ...action(p), expectedRevision: 99 }),
    );
    await assert.rejects(f.offers.delivery(action(p)));
    await assert.rejects(
      f.offers.prepare({
        ...f.request,
        clientRequestId: randomUUID(),
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.offers.prepare({
        ...f.request,
        clientRequestId: randomUUID(),
        taskId: randomUUID(),
      }),
    );
    assert.equal(f.store.exportPrivateResumeOffers(owner).length, 1);
  } finally {
    f.close();
  }
});
test("resume offer cannot be encrypted or revealed after local resume changes the task", async () => {
  const f = await offersFixture();
  try {
    const p = await f.offers.prepare(f.request);
    const ready = await f.offers.resume(action(p));
    f.store.command(owner, f.task.id, {
      command: "resume",
      expectedRevision: f.task.revision,
    });
    await assert.rejects(f.offers.delivery(action(ready)));
    await assert.rejects(
      f.offers.prepare({ ...f.request, clientRequestId: randomUUID() }),
    );
    assert.equal(f.store.exportPrivateResumeOffers(owner).length, 1);
  } finally {
    f.close();
  }
});
test("stopped and expired resume offers never reseal or extend the original lease", async () => {
  const f = await offersFixture();
  try {
    const p = await f.offers.prepare(f.request);
    const ready = await f.offers.resume(action(p));
    const stopped = f.offers.stop(action(ready));
    await assert.rejects(f.offers.delivery(action(stopped)));
    await assert.rejects(f.offers.prepare(f.request));
    const second = await f.offers.prepare({
      ...f.request,
      clientRequestId: randomUUID(),
      expiresAt: f.clock() + 1000,
    });
    f.time(f.clock() + 1001);
    await assert.rejects(f.offers.resume(action(second)));
    assert.equal(f.offers.get(second.id).value.state, "preparing");
  } finally {
    f.close();
  }
});
test("resume offers are owner scoped, encrypted at rest, locked by recovery and erased by deletion", async () => {
  const f = await offersFixture();
  let restored: Store | undefined;
  try {
    const p = await f.offers.prepare(f.request);
    const ready = await f.offers.resume(action(p));
    const row = f.store.db
      .prepare("SELECT payload FROM private_resume_offers WHERE id=?")
      .get(p.id) as { payload: Buffer };
    assert.equal(
      row.payload.includes(Buffer.from(f.choices.modelDigest)),
      false,
    );
    const other = new PrivateResumeOffers(
      f.store,
      f.vault,
      { ...owner, userId: "other" },
      f.consent,
      f.clock,
    );
    assert.throws(() => other.get(p.id));
    const backup = join(f.dir, "resume-offers.backup");
    await encryptedBackup(f.store, f.vault, backup);
    const restoredPath = join(f.dir, "restored.db");
    await restoreBackup(backup, f.vault, restoredPath);
    restored = new Store(restoredPath, f.vault, f.clock);
    assert.equal(restored.exportPrivateResumeOffers(owner)[0]?.locked, true);
    const api = new PrivateResumeOffers(
      restored,
      f.vault,
      owner,
      f.buildResume(restored),
      f.clock,
    );
    await assert.rejects(
      api.delivery({ ...action(ready), expectedRevision: ready.revision + 1 }),
    );
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateResumeOffers(owner), []);
  } finally {
    restored?.close();
    f.close();
  }
});
test("resume offer schema excludes authority widening, task content and invalid lease bounds", () => {
  const value = {
    version: 1,
    type: "task.resume.offer",
    permissionId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 1,
    modelDigest: "a".repeat(64),
    issuedAt: 1000,
    expiresAt: 2000,
  };
  assert.equal(privateResumeOfferSchema.safeParse(value).success, true);
  for (const patch of [
    { content: "text" },
    { permissions: { publish: true } },
    { type: "conversation.offer" },
    { modelDigest: "model" },
    { expiresAt: 1000 },
    { expiresAt: 86401001 },
    { taskRevision: 0 },
  ])
    assert.equal(
      privateResumeOfferSchema.safeParse({ ...value, ...patch }).success,
      false,
    );
});

test("resume offer revocation during key resolution prevents publication", async () => {
  const f = await offersFixture();
  try {
    const p = await f.offers.prepare(f.request);
    const slot = f.entries(f.grant.grant.local.keyId).key;
    slot.beforeRead = async () => {
      slot.beforeRead = undefined;
      f.consent.revoke({
        permissionId: f.request.permissionId,
        expectedRevision: f.consent.list().revision,
        confirmed: true,
      });
    };
    await assert.rejects(f.offers.resume(action(p)));
    assert.equal(f.offers.get(p.id).value.envelope, null);
    assert.equal(f.offers.get(p.id).value.state, "preparing");
  } finally {
    f.close();
  }
});
test("resume offer failed insertion rolls back its shared outgoing sequence reservation", async () => {
  const f = await offersFixture();
  try {
    const before = f.store.db
      .prepare("SELECT * FROM private_send_channels ORDER BY channel_hash")
      .all();
    f.store.db.exec(
      "CREATE TRIGGER fail_resume_offer BEFORE INSERT ON private_resume_offers BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    await assert.rejects(f.offers.prepare(f.request));
    assert.deepEqual(f.store.exportPrivateResumeOffers(owner), []);
    assert.deepEqual(
      f.store.db
        .prepare("SELECT * FROM private_send_channels ORDER BY channel_hash")
        .all(),
      before,
    );
    f.store.db.exec("DROP TRIGGER fail_resume_offer");
    const p = await f.offers.prepare(f.request);
    assert.equal(p.value.state, "preparing");
  } finally {
    f.close();
  }
});
