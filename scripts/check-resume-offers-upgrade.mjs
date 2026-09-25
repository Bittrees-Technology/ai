/** Actual compiled schema37 ->39; disposable synthetic storage only. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const oldRoot = join(root, ".legacy-resume-offers/dist"),
  currentRoot = join(root, "dist");
const legacyHashes = {
  "modules/storage/store.js":
    "6ac8f9026c179e32487c37e07d3f13a6fff88e582e06976f54843d3ed29db997",
  "modules/storage/backup.js":
    "a939a53ef1a6aeaee463f50d12eb3647cf3e071e982670d6c558c9a24568b7f7",
  "modules/remote/private-resume-consent.js":
    "c2ebd5f09b60ff693a90bd40ee603251823b5a14cf55673f4ab8e4b79a588700",
  "modules/remote/private-resume-delivery.js":
    "c7099f635aaf589fe502bad6489076f357f5e1bd6f00cc192e6e9c3daeaa227c",
  "modules/storage/remote-resumes.js":
    "62cb235efa99560496b8c0a3d3cab7844bf4555b99c0294bb31b8280f1b567c8",
  "tests/helpers/conversation-fixture.js":
    "2b97fee93aaec4ca07633654a45d4a5f56e25c8d52fb2b2fbbb420d7fea5b6a9",
};
for (const [file, hash] of Object.entries(legacyHashes))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(oldRoot, file)))
      .digest("hex"),
    hash,
  );
const load = (base, file) =>
  import(pathToFileURL(join(base, file + ".js")).href);
const { conversationFixture, owner } = await load(
    oldRoot,
    "tests/helpers/conversation-fixture",
  ),
  { PrivateResumeConsent: OldConsent } = await load(
    oldRoot,
    "modules/remote/private-resume-consent",
  ),
  { PrivateResumeDelivery: OldDelivery } = await load(
    oldRoot,
    "modules/remote/private-resume-delivery",
  ),
  { Store: OldStore } = await load(oldRoot, "modules/storage/store"),
  { Store } = await load(currentRoot, "modules/storage/store"),
  { Vault } = await load(currentRoot, "modules/storage/vault"),
  { sealPrivateEnvelope, privateEnvelopeSuite } = await load(
    oldRoot,
    "modules/remote/private-envelope",
  ),
  oldBackup = await load(oldRoot, "modules/storage/backup"),
  backup = await load(currentRoot, "modules/storage/backup");
const f = await conversationFixture(),
  opened = [];
try {
  const consent = new OldConsent(
    f.store,
    f.vault,
    owner,
    f.current,
    f.keys,
    f.peers,
    f.clock,
  );
  const profile = {
    id: "resume",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 1000,
    temperature: 0,
  };
  f.store.addProfile(owner, profile);
  async function approve(label) {
    let task = f.store.create(
      owner,
      {
        conversationId: randomUUID(),
        kind: "query",
        prompt: "SYNTHETIC_" + label,
        modelProfileId: profile.id,
      },
      randomUUID(),
    );
    task = f.store.command(owner, task.id, {
      command: "pause",
      expectedRevision: task.revision,
    });
    const review = await consent.prepare({
      expectedRevision: consent.list().revision,
      choices: {
        peerId: f.peerId,
        peerKeyEpoch: 1,
        taskId: task.id,
        taskRevision: task.revision,
        modelDigest: "a".repeat(64),
        expiresAt: f.clock() + 600000,
      },
    });
    const grant = consent.approve({
      reviewId: review.id,
      expectedRevision: review.revision,
      confirmed: true,
      acknowledged: true,
    });
    return { task, grant: grant.grant };
  }
  const unused = await approve("UNUSED"),
    used = await approve("USED"),
    local = await f.keys.resolve();
  const command = {
    version: 1,
    id: randomUUID(),
    deviceId: f.binding.deviceId,
    permissionId: used.grant.id,
    taskId: used.task.id,
    expectedRevision: used.task.revision,
    command: "resume",
    issuedAt: new Date(f.clock()).toISOString(),
    expiresAt: new Date(f.clock() + 60000).toISOString(),
  };
  const h = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: f.binding.ownerId,
    senderId: f.peerId,
    recipientId: f.binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: command.id,
    sequence: 50,
    issuedAt: f.clock(),
    expiresAt: f.clock() + 60000,
  };
  const envelope = await sealPrivateEnvelope(
    h,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, type: "task.resume", command }),
    ),
    { senderKey: f.sender, recipientPublicKey: local.pair.publicKey },
    f.clock,
  );
  const delivery = new OldDelivery(
    f.store,
    f.vault,
    owner,
    consent,
    async () => () => {},
    f.clock,
  );
  const receipt = await delivery.receive({
    permissionId: used.grant.id,
    envelope,
    confirmed: true,
  });
  const reply = await delivery.receipt({
    permissionId: used.grant.id,
    commandId: command.id,
    confirmed: true,
  });
  const snapshot = (s) => ({
    task: s.get(owner, unused.task.id),
    used: s.get(owner, used.task.id),
    profile: s.profile(owner, profile.id),
    consent: s.exportPrivateResumeConsent(owner),
    delivery: s.exportPrivateResumeDelivery(owner),
    permissions: s.remoteResumes.history(owner),
  });
  const expected = snapshot(f.store);
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 37);
  const oldCopy = join(f.dir, "old.backup");
  await oldBackup.encryptedBackup(f.store, f.vault, oldCopy);
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  const unchanged = new OldStore(f.path, f.vault, f.clock);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 37);
  unchanged.close();
  const s = new Store(f.path, f.vault, f.clock);
  opened.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 39);
  assert.deepEqual(snapshot(s), expected);
  assert.deepEqual(s.exportPrivateResumeOffers(owner), []);
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  const currentCopy = join(f.dir, "current.backup");
  await backup.encryptedBackup(s, f.vault, currentCopy);
  const restoredPath = join(f.dir, "restored.db");
  await backup.restoreBackup(currentCopy, f.vault, restoredPath);
  const restored = new Store(restoredPath, f.vault, f.clock);
  opened.push(restored);
  assert.equal(restored.exportPrivateResumeConsent(owner).needsReview, true);
  assert.ok(restored.exportPrivateResumeDelivery(owner).every((v) => v.locked));
  assert.ok(
    restored.remoteResumes.history(owner).every((v) => v.permission === null),
  );
  assert.deepEqual(restored.exportPrivateResumeOffers(owner), []);
  const rollbackPath = join(f.dir, "rollback.db");
  await oldBackup.restoreBackup(oldCopy, f.vault, rollbackPath);
  const rollback = new OldStore(rollbackPath, f.vault, f.clock);
  opened.push(rollback);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 37);
  assert.equal(rollback.exportPrivateResumeConsent(owner).needsReview, true);
  assert.equal(rollback.get(owner, unused.task.id).id, unused.task.id);
  const report = {
    status: "passed",
    from: 37,
    to: 39,
    legacySourceCommit: "59804e6febfb35a62ceb3abee0c9a73ae673780f",
    legacyArchiveSha256:
      "5b888c1705af5dbeb98e49c3d0eafce1291fe0ef384e2caf754eaac8aad42155",
    legacyHashes,
    assertions: [
      "wrong key leaves actual37 storage unchanged",
      "unused and consumed private grants, original encrypted command/reply, tasks and profiles preserved exactly",
      "new offers start empty without authority",
      "actual37 writer refuses39",
      "current backup restore locks consent/delivery and strips resume authority",
      "untouched old backup rolls back to37 with authority locked",
    ],
  };
  await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(
    join(root, "test-results/resume-offers-upgrade.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  for (const s of opened) s.close();
  f.close();
}
