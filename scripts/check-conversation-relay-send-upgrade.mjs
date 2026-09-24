/** Actual compiled schema34 -> schema35. Synthetic temporary stores only. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const legacy = resolve(process.argv[2] ?? "missing-schema34"),
  current = fileURLToPath(new URL("../dist", import.meta.url));
const expected = {
  "modules/storage/store.js":
    "d1049596aca8953f39e762ab9f04728357cb3680cccac52ba42c5a5af5f07332",
  "modules/remote/private-conversation-content.js":
    "6cb3676da729a109e637bb83e0bb43f4e3e24503eda9417a3307665e8d5fcb07",
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
const { Store } = await load(current, "modules/storage/store"),
  { Vault } = await load(current, "modules/storage/vault");
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
const { sealPrivateEnvelope } = await load(
  legacy,
  "modules/remote/private-envelope",
);
const { privateRelayEnvelopeHash } = await load(
  current,
  "modules/remote/private-relay-contracts",
);
const backup = await load(current, "modules/storage/backup");
const f = await conversationFixture(),
  stores = [];
try {
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 34);
  const { grant } = f.approve(await f.prepare()),
    old = new OldContent(
      f.store,
      f.vault,
      owner,
      f.consent,
      f.keys,
      undefined,
      f.clock,
    );
  const id = randomUUID(),
    input = {
      permissionId: grant.id,
      id,
      expectedRevision: 1,
      confirmed: true,
    };
  await old.prepare({
    id,
    permissionId: grant.id,
    expectedConsentRevision: f.consent.list().revision,
    localMessageId: f.message.id,
    parentId: null,
    kind: "message",
    expiresAt: f.clock() + 60000,
    confirmed: true,
  });
  const original = await old.seal(input),
    h = original.header;
  const receipt = await sealPrivateEnvelope(
    {
      ...h,
      senderId: h.recipientId,
      recipientId: h.senderId,
      senderKeyEpoch: h.recipientKeyEpoch,
      recipientKeyEpoch: h.senderKeyEpoch,
      messageId: randomUUID(),
      sequence: 100,
    },
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        type: "conversation.received",
        scope: {
          permissionId: grant.id,
          conversationRef: grant.conversationRef,
        },
        acceptedId: id,
        acceptedType: "conversation.message",
        operationId: id,
        acceptedAt: f.clock(),
      }),
    ),
    {
      senderKey: f.sender,
      recipientPublicKey: (await f.keys.resolve()).pair.publicKey,
    },
    f.clock,
  );
  await old.reconcile({ ...input, expectedRevision: 2, envelope: receipt });
  const rows = f.store.exportPrivateConversationContent(owner),
    message = f.store.message(owner, f.message.id),
    keysBefore = f.entries(grant.local.keyId).key.value.slice(),
    replay = f.store.exportPrivateIncomingReplay(owner),
    originalBackup = join(f.dir, "original34.enc");
  await oldBackup.encryptedBackup(f.store, f.vault, originalBackup);
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  const unchanged = new OldStore(f.path, f.vault, f.clock);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 34);
  unchanged.close();
  const s = new Store(f.path, f.vault, f.clock);
  stores.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 35);
  assert.deepEqual(s.exportPrivateConversationContent(owner), rows);
  assert.deepEqual(s.exportPrivateIncomingReplay(owner), replay);
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
    engine = new PrivateConversationContent(
      s,
      f.vault,
      owner,
      consent,
      keys,
      undefined,
      f.clock,
    );
  const first = await engine.beginRelayDelivery({
    ...input,
    expectedRevision: 3,
    deliveryExpiresAt: h.expiresAt,
  });
  assert.deepEqual(first.envelope, original);
  assert.equal(first.entry.value.relay.attempts, 1);
  // A lost response leaves the attempt durable; explicit retry does not replace ciphertext.
  const second = await engine.beginRelayDelivery({
    ...input,
    expectedRevision: first.entry.revision,
    deliveryExpiresAt: h.expiresAt,
  });
  assert.deepEqual(second.envelope, original);
  assert.equal(second.entry.value.relay.attempts, 2);
  const observed = await engine.recordRelayDelivery({
    ...input,
    expectedRevision: second.entry.revision,
    receipt: {
      version: 1,
      messageId: h.messageId,
      envelopeHash: await privateRelayEnvelopeHash(original),
      storedAt: f.clock(),
      revision: 1,
      state: "stored",
    },
  });
  assert.deepEqual(observed.value.receiptEnvelope, receipt);
  assert.deepEqual(
    await engine.seal({ ...input, expectedRevision: observed.revision }),
    original,
  );
  assert.deepEqual(s.message(owner, f.message.id), message);
  assert.deepEqual(s.exportPrivateIncomingReplay(owner), replay);
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  const copyPath = join(f.dir, "relay35.db"),
    copyBackup = join(f.dir, "relay35.enc");
  await backup.encryptedBackup(s, f.vault, copyBackup);
  await backup.restoreBackup(copyBackup, f.vault, copyPath);
  const copy = new Store(copyPath, f.vault, f.clock);
  stores.push(copy);
  const retained = copy.exportPrivateConversationContent(owner)[0];
  assert.equal(retained.locked, true);
  assert.deepEqual(retained.value, observed.value);
  copy.deleteAll({ ...owner, userId: "unrelated" });
  assert.equal(copy.exportPrivateConversationContent(owner).length, 1);
  copy.deleteAll(owner);
  assert.deepEqual(copy.exportPrivateConversationContent(owner), []);
  const rollbackPath = join(f.dir, "rollback34.db");
  await oldBackup.restoreBackup(originalBackup, f.vault, rollbackPath);
  const rollback = new OldStore(rollbackPath, f.vault, f.clock);
  stores.push(rollback);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 34);
  assert.deepEqual(rollback.message(owner, f.message.id), message);
  assert.equal(
    rollback.exportPrivateConversationContent(owner)[0].locked,
    true,
  );
  assert.deepEqual(
    rollback.exportPrivateConversationContent(owner)[0].value,
    rows[0].value,
  );
  const proof = {
    verifiedAt: new Date().toISOString(),
    from: 34,
    to: 35,
    legacyHead: "4eafe8e83171fb298a6d4454ee6ce96dae0bf177",
    compiledHashes: expected,
    checks: [
      "actual34 original ciphertext and recipient receipt, Inbox, replay and key bytes preserved",
      "wrong-key upgrade leaves prior writer usable",
      "durable uncertain attempt and explicit retry retain original ciphertext",
      "server observation remains separate from authenticated recipient receipt",
      "prior writer refuses35",
      "encrypted backup restores locked delivery history",
      "owner-isolated deletion",
      "untouched original34 backup usable with prior writer",
    ],
    boundaries: [
      "synthetic temporary stores and in-memory keys",
      "no native/browser automation, installed app, personal data, live service or Acer changes",
    ],
  };
  await writeFile(
    resolve(
      process.argv[3] ??
        "docs/evidence/conversation-relay-send-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const s of stores) s.close();
  f.close();
}
