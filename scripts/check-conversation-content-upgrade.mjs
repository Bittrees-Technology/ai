/** Actual compiled schema32 -> current; synthetic temporary stores only. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const legacy = resolve(process.argv[2] ?? "missing-schema32"),
  current = fileURLToPath(new URL("../dist", import.meta.url));
const expected = {
  "modules/storage/store.js":
    "1fc50d83f55b7077c3d8e7728e7d80a0579f30199a74977d5d9514b8980ffedd",
  "modules/remote/private-key-lifecycle.js":
    "b949a643644ada7b67a67ab36f054885e27ac168e3cd0b9214bf0de794f02c21",
  "modules/remote/private-endpoint-keys.js":
    "31431ef3613d3f69524321f9a2cc7c471c8f7f1fc283580c653eaa9f36b34539",
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
const { PrivateConversationOffers } = await load(
  legacy,
  "modules/remote/private-conversation-offers",
);
const backup = await load(current, "modules/storage/backup");
const { privateEnvelopeSuite, sealPrivateEnvelope } = await load(
  current,
  "modules/remote/private-envelope",
);
const f = await conversationFixture(),
  stores = [];
try {
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 32);
  const { grant } = f.approve(await f.prepare()),
    offers = new PrivateConversationOffers(
      f.store,
      f.vault,
      owner,
      f.consent,
      f.clock,
    );
  const prepared = await offers.prepare({
    clientRequestId: randomUUID(),
    permissionId: grant.id,
    expectedConsentRevision: f.consent.list().revision,
    confirmed: true,
  });
  await offers.resume({
    id: prepared.id,
    expectedRevision: prepared.revision,
    confirmed: true,
  });
  const originalOffers = f.store.exportPrivateConversationOffers(owner),
    originalMessage = f.store.message(owner, f.message.id),
    originalKeys = f.entries(grant.local.keyId).key.value.slice();
  const snapshot = join(f.dir, "original32.enc");
  await oldBackup.encryptedBackup(f.store, f.vault, snapshot);
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  const unchanged = new OldStore(f.path, f.vault, f.clock);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 32);
  unchanged.close();
  const s = new Store(f.path, f.vault, f.clock);
  stores.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 35);
  assert.deepEqual(s.exportPrivateConversationContent(owner), []);
  assert.deepEqual(s.exportPrivateConversationOffers(owner), originalOffers);
  assert.deepEqual(s.message(owner, f.message.id), originalMessage);
  assert.deepEqual(f.entries(grant.local.keyId).key.value, originalKeys);
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
    );
  assert.equal(keys.validateReplayCoverage((await keys.resolve()).proof), true);
  const content = new PrivateConversationContent(
      s,
      f.vault,
      owner,
      consent,
      keys,
      undefined,
      f.clock,
    ),
    id = randomUUID();
  const body = {
    version: 1,
    type: "conversation.message",
    scope: { permissionId: grant.id, conversationRef: grant.conversationRef },
    id,
    parentId: null,
    content: "SYNTHETIC_SCHEMA33_CONTENT",
  };
  const env = await sealPrivateEnvelope(
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
  );
  const accepted = await content.accept({
    permissionId: grant.id,
    envelope: env,
    confirmed: true,
  });
  assert.equal(
    s.message(owner, accepted.entry.value.localMessageId).input.content,
    body.content,
  );
  assert.equal(
    (
      await content.accept({
        permissionId: grant.id,
        envelope: env,
        confirmed: true,
      })
    ).duplicate,
    true,
  );
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  const newBackup = join(f.dir, "schema33.enc"),
    restoredPath = join(f.dir, "restored33.db");
  await backup.encryptedBackup(s, f.vault, newBackup);
  await backup.restoreBackup(newBackup, f.vault, restoredPath);
  const restored = new Store(restoredPath, f.vault, f.clock);
  stores.push(restored);
  const copy = restored.exportPrivateConversationContent(owner)[0];
  assert.equal(copy.locked, true);
  assert.deepEqual(copy.value, accepted.entry.value);
  assert.equal(
    restored.message(owner, copy.value.localMessageId).input.content,
    body.content,
  );
  restored.deleteAll({ ...owner, userId: "other" });
  assert.equal(restored.exportPrivateConversationContent(owner).length, 1);
  restored.deleteAll(owner);
  assert.deepEqual(restored.exportPrivateConversationContent(owner), []);
  const rollbackPath = join(f.dir, "rollback32.db");
  await oldBackup.restoreBackup(snapshot, f.vault, rollbackPath);
  const rollback = new OldStore(rollbackPath, f.vault, f.clock);
  stores.push(rollback);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 32);
  assert.deepEqual(rollback.message(owner, f.message.id), originalMessage);
  assert.equal(rollback.exportPrivateConversationOffers(owner)[0].locked, true);
  const result = {
    verifiedAt: new Date().toISOString(),
    from: 32,
    to: 35,
    legacyHead: "45c32caa452a0d63e67503c1cf1da165d7686ab3",
    compiledHashes: expected,
    checks: [
      "actual prior offers, Inbox and key bytes preserved",
      "wrong-key upgrade leaves prior writer usable",
      "no invented content journal history",
      "real encrypted content enters existing Inbox once",
      "older writer refuses schema33",
      "encrypted backup preserves journal and Inbox with restore lock",
      "owner-isolated journal deletion",
      "untouched original schema32 backup remains usable with prior writer",
    ],
    boundaries: [
      "synthetic temporary stores and in-memory keys",
      "no browser/native automation, installed app, personal data, live service or Acer changes",
    ],
  };
  const output = resolve(
    process.argv[3] ??
      "docs/evidence/conversation-content-schema-compatibility-2026-09-24.json",
  );
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  for (const s of stores) s.close();
  f.close();
}
