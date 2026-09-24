/** Actual compiled schema33 -> current, using disposable synthetic stores only. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const legacy = resolve(process.argv[2] ?? "missing-schema33"),
  current = fileURLToPath(new URL("../dist", import.meta.url));
const expected = {
  "modules/storage/store.js":
    "dd7d907119c518c581cdc3b21388eb00ebe7d1bbeb78e0b73d233982d6fb8ae8",
  "modules/remote/private-conversation-content.js":
    "867d643bb0d04e509f725f0cd09427e31ee2d2629db87a12c08eef53433c4229",
  "modules/remote/private-key-lifecycle.js":
    "b949a643644ada7b67a67ab36f054885e27ac168e3cd0b9214bf0de794f02c21",
};
for (const [file, hash] of Object.entries(expected))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(legacy, file)))
      .digest("hex"),
    hash,
  );
const load = (root, name) =>
  import(pathToFileURL(join(root, name + ".js")).href);
const { conversationFixture, owner } = await load(
  legacy,
  "tests/helpers/conversation-fixture",
);
const { Store: OldStore } = await load(legacy, "modules/storage/store");
const { PrivateConversationContent: OldContent } = await load(
  legacy,
  "modules/remote/private-conversation-content",
);
const oldBackup = await load(legacy, "modules/storage/backup");
const { Store } = await load(current, "modules/storage/store");
const { Vault } = await load(current, "modules/storage/vault");
const { PrivateKeyLifecycle } = await load(
  current,
  "modules/remote/private-key-lifecycle",
);
const { PrivatePeerEnrollment } = await load(
  current,
  "modules/remote/private-peers",
);
const { PrivateConversationConsent } = await load(
  current,
  "modules/remote/private-conversation-consent",
);
const { PrivateConversationContent } = await load(
  current,
  "modules/remote/private-conversation-content",
);
const { sealPrivateEnvelope, privateEnvelopeSuite } = await load(
  current,
  "modules/remote/private-envelope",
);
const backup = await load(current, "modules/storage/backup");
const f = await conversationFixture(),
  stores = [];
try {
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 33);
  const { grant } = f.approve(await f.prepare()),
    old = new OldContent(
      f.store,
      f.vault,
      owner,
      f.consent,
      f.keys,
      undefined,
      f.clock,
    ),
    id = randomUUID(),
    prepared = await old.prepare({
      id,
      permissionId: grant.id,
      expectedConsentRevision: f.consent.list().revision,
      localMessageId: f.message.id,
      parentId: null,
      kind: "message",
      expiresAt: f.clock() + 60000,
      confirmed: true,
    }),
    original = await old.seal({
      permissionId: grant.id,
      id,
      expectedRevision: prepared.revision,
      confirmed: true,
    }),
    rows = f.store.exportPrivateConversationContent(owner),
    message = f.store.message(owner, f.message.id),
    keysBefore = f.entries(grant.local.keyId).key.value.slice(),
    incomingReplay = f.store.exportPrivateIncomingReplay(owner),
    originalBackup = join(f.dir, "original33.enc");
  await oldBackup.encryptedBackup(f.store, f.vault, originalBackup);
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  const unchanged = new OldStore(f.path, f.vault, f.clock);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 33);
  unchanged.close();
  const s = new Store(f.path, f.vault, f.clock);
  stores.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 35);
  assert.deepEqual(s.exportPrivateConversationContent(owner), rows);
  assert.deepEqual(s.exportPrivateIncomingReplay(owner), incomingReplay);
  assert.deepEqual(s.message(owner, f.message.id), message);
  assert.deepEqual(f.entries(grant.local.keyId).key.value, keysBefore);
  const keys = new PrivateKeyLifecycle(
      s,
      f.vault,
      owner,
      f.current,
      f.entries,
      undefined,
      f.clock,
    ),
    peers = new PrivatePeerEnrollment(s, f.vault, owner, f.current, f.clock),
    consent = new PrivateConversationConsent(
      s,
      f.vault,
      owner,
      f.current,
      keys,
      peers,
      f.clock,
    ),
    content = new PrivateConversationContent(
      s,
      f.vault,
      owner,
      consent,
      keys,
      undefined,
      f.clock,
    ),
    body = {
      version: 1,
      type: "conversation.received",
      scope: prepared.value.content.scope,
      acceptedId: id,
      acceptedType: "conversation.message",
      operationId: id,
      acceptedAt: f.clock(),
    },
    envelope = await sealPrivateEnvelope(
      {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: f.binding.ownerId,
        senderId: f.peerId,
        recipientId: f.binding.deviceId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: grant.local.keyEpoch,
        messageId: randomUUID(),
        operationId: id,
        sequence: 100,
        issuedAt: f.clock(),
        expiresAt: f.clock() + 60000,
      },
      new TextEncoder().encode(JSON.stringify(body)),
      {
        senderKey: f.sender,
        recipientPublicKey: (await keys.resolve()).pair.publicKey,
      },
      f.clock,
    ),
    result = await content.reconcile({
      permissionId: grant.id,
      id,
      expectedRevision: 2,
      envelope,
      confirmed: true,
    });
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.entry.value.receipt, body);
  assert.deepEqual(s.message(owner, f.message.id), message);
  assert.deepEqual(
    await content.seal({
      permissionId: grant.id,
      id,
      expectedRevision: 3,
      confirmed: true,
    }),
    original,
  );
  assert.equal(
    (
      await content.reconcile({
        permissionId: grant.id,
        id,
        expectedRevision: 3,
        envelope,
        confirmed: true,
      })
    ).duplicate,
    true,
  );
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  const copyPath = join(f.dir, "receipt34.db"),
    copyBackup = join(f.dir, "receipt34.enc");
  await backup.encryptedBackup(s, f.vault, copyBackup);
  await backup.restoreBackup(copyBackup, f.vault, copyPath);
  const copy = new Store(copyPath, f.vault, f.clock);
  stores.push(copy);
  const retained = copy.exportPrivateConversationContent(owner)[0];
  assert.equal(retained.locked, true);
  assert.deepEqual(retained.value, result.entry.value);
  assert.deepEqual(copy.message(owner, f.message.id), message);
  copy.deleteAll({ ...owner, userId: "unrelated" });
  assert.equal(copy.exportPrivateConversationContent(owner).length, 1);
  copy.deleteAll(owner);
  assert.deepEqual(copy.exportPrivateConversationContent(owner), []);
  const rollbackPath = join(f.dir, "rollback33.db");
  await oldBackup.restoreBackup(originalBackup, f.vault, rollbackPath);
  const rollback = new OldStore(rollbackPath, f.vault, f.clock);
  stores.push(rollback);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 33);
  assert.deepEqual(rollback.message(owner, f.message.id), message);
  const rollbackRow = rollback.exportPrivateConversationContent(owner)[0];
  assert.equal(rollbackRow.locked, true);
  assert.deepEqual(rollbackRow.value, rows[0].value);
  const resultProof = {
    verifiedAt: new Date().toISOString(),
    from: 33,
    to: 35,
    legacyHead: "7e9a7543f0da91f77cc101cead2a2e766e818fa7",
    compiledHashes: expected,
    checks: [
      "actual schema33 outgoing ciphertext, Inbox, replay and key bytes preserved",
      "wrong-key upgrade leaves prior writer usable",
      "authenticated receipt updates original outgoing row once",
      "original ciphertext retry unchanged after receipt",
      "no extra Inbox effect",
      "prior writer refuses current schema35",
      "encrypted backup retains receipt with restore lock",
      "owner-isolated deletion",
      "untouched original schema33 backup usable with prior writer",
    ],
    boundaries: [
      "synthetic temporary stores and in-memory keys",
      "no local browser/native automation, installed app, personal data, live service or Acer changes",
    ],
  };
  const output = resolve(
    process.argv[3] ??
      "docs/evidence/conversation-receipt-schema-compatibility-2026-09-24.json",
  );
  await writeFile(output, JSON.stringify(resultProof, null, 2) + "\n");
  console.log(JSON.stringify(resultProof));
} finally {
  for (const s of stores) s.close();
  f.close();
}
