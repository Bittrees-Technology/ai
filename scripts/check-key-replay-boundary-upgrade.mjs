/** Actual compiled schema31 -> current; temporary synthetic stores/in-memory keys. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error("Supply the verified compiled schema31 directory");
const repo = fileURLToPath(new URL("../", import.meta.url));
const legacy = resolve(process.argv[2]),
  current = join(repo, "dist");
const expectedHashes = {
  "modules/storage/store.js":
    "d9f95264dfb4304fe3aaaa944a20d5d964cd461b8cb6e4ecfe961a325d5b64fa",
  "modules/remote/private-key-lifecycle.js":
    "284a32749861b5a7d1b5fb1a701f8c7888641f865a3e8c0005fe5b9554bfe6f4",
  "modules/remote/private-endpoint-keys.js":
    "b20e924ef9f8e7d6df500dc42703c05fb7246c836872577a5e7ffab4e281ddb3",
};
for (const [file, expected] of Object.entries(expectedHashes))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(legacy, file)))
      .digest("hex"),
    expected,
  );
const load = (base, file) =>
  import(pathToFileURL(join(base, file + ".js")).href);
const { conversationFixture, owner } = await load(
  legacy,
  "tests/helpers/conversation-fixture",
);
const { PrivateKeyLifecycle: OldLifecycle, endpointKeyOwner } = await load(
  legacy,
  "modules/remote/private-key-lifecycle",
);
const { PrivateEndpointKeys: OldEndpointKeys } = await load(
  legacy,
  "modules/remote/private-endpoint-keys",
);
const { Store: OldStore } = await load(legacy, "modules/storage/store");
const { Store } = await load(current, "modules/storage/store");
const { Vault } = await load(current, "modules/storage/vault");
const { PrivateKeyLifecycle } = await load(
  current,
  "modules/remote/private-key-lifecycle",
);
const oldBackup = await load(legacy, "modules/storage/backup");
const backup = await load(current, "modules/storage/backup");
const { sealPrivateEnvelope, privateEnvelopeSuite } = await load(
  legacy,
  "modules/remote/private-envelope",
);
const { openPrivateEnvelope } = await load(
  current,
  "modules/remote/private-envelope",
);
const f = await conversationFixture();
const stores = [];
const review = (keys) => ({
  expectedRevision: keys.list().revision,
  confirmed: true,
});
const command = (slot) => ({
  keyId: slot.keyId,
  expectedRevision: slot.revision,
  confirmed: true,
});
const build = (Type, store, scope = owner) =>
  new Type(store, f.vault, scope, f.current, f.entries, undefined, f.clock);
const open = (Type, path = f.path) => {
  const s = new Type(path, f.vault, f.clock);
  stores.push(s);
  return s;
};
try {
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 31);
  f.approve(await f.prepare());
  const active = (await f.keys.resolve()).proof;
  const activeBytes = f.entries(active.keyId).key.value.slice();
  const oldHeader = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: f.binding.ownerId,
    senderId: f.peerId,
    recipientId: f.binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: active.keyEpoch,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 100,
    issuedAt: f.clock(),
    expiresAt: f.clock() + 60000,
  };
  const oldWire = await sealPrivateEnvelope(
    oldHeader,
    new TextEncoder().encode("synthetic old-key content"),
    {
      senderKey: f.sender,
      recipientPublicKey: (await f.keys.resolve()).pair.publicKey,
    },
    f.clock,
  );
  const pendingOwner = { ...owner, userId: "legacy-preparing" };
  const emptyOwner = { ...owner, userId: "legacy-never-generated" };
  const preparing = build(OldLifecycle, f.store, pendingOwner);
  const pending = preparing.begin(review(preparing));
  const native = new OldEndpointKeys(
    endpointKeyOwner(pendingOwner),
    f.entries,
    () => ({
      localOwner: endpointKeyOwner(pendingOwner),
      binding: f.binding,
      keyId: pending.keyId,
      keyEpoch: pending.keyEpoch,
      creationAllowed: true,
    }),
    f.clock,
  );
  await native.create({
    keyId: pending.keyId,
    keyEpoch: pending.keyEpoch,
    confirmed: true,
  });
  const pendingBytes = f.entries(pending.keyId).key.value.slice();
  const neverGenerated = build(OldLifecycle, f.store, emptyOwner);
  const empty = neverGenerated.begin(review(neverGenerated));
  const history = f.keys.list();
  const consent = f.store.exportPrivateConversationConsent(owner);
  const incoming = f.store.db
    .prepare("SELECT * FROM private_incoming_replay")
    .all();
  assert.ok(incoming.length > 0);
  const messages = f.store.db.prepare("SELECT * FROM messages").all();
  await oldBackup.encryptedBackup(
    f.store,
    f.vault,
    join(f.dir, "original.aib"),
  );
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  const unchanged = open(OldStore);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 31);
  assert.deepEqual(build(OldLifecycle, unchanged).list(), history);
  unchanged.close();
  const upgraded = open(Store);
  assert.equal(upgraded.db.pragma("user_version", { simple: true }), 36);
  const keys = build(PrivateKeyLifecycle, upgraded);
  assert.deepEqual(keys.list(), history);
  const prior = await keys.resolve();
  assert.deepEqual(prior.proof, active);
  assert.equal(keys.validateReplayCoverage(prior.proof), false);
  const oldOpened = await openPrivateEnvelope(
    oldWire,
    oldHeader,
    { recipientKey: prior.pair, senderPublicKey: f.sender.publicKey },
    f.clock,
  );
  assert.equal(
    new TextDecoder().decode(oldOpened.plaintext),
    "synthetic old-key content",
  );
  oldOpened.plaintext.fill(0);
  const resumed = build(PrivateKeyLifecycle, upgraded, pendingOwner);
  await resumed.provision(command(pending));
  assert.equal(
    resumed.validateReplayCoverage((await resumed.resolve()).proof),
    false,
  );
  assert.deepEqual(f.entries(pending.keyId).key.value, pendingBytes);
  // A reservation that never generated material can safely generate a new key now.
  const firstGeneration = build(PrivateKeyLifecycle, upgraded, emptyOwner);
  await firstGeneration.provision(command(empty));
  assert.equal(
    firstGeneration.validateReplayCoverage(
      (await firstGeneration.resolve()).proof,
    ),
    true,
  );
  const replacement = keys.begin(review(keys));
  await keys.provision(command(replacement));
  const fresh = await keys.resolve();
  assert.equal(keys.validateReplayCoverage(fresh.proof), true);
  assert.equal(keys.validateReplayCoverage(active), false);
  assert.notEqual(fresh.proof.publicKey, active.publicKey);
  await assert.rejects(
    openPrivateEnvelope(
      oldWire,
      oldHeader,
      { recipientKey: fresh.pair, senderPublicKey: f.sender.publicKey },
      f.clock,
    ),
    /PRIVATE_ENVELOPE_INVALID/,
  );
  await assert.rejects(
    openPrivateEnvelope(
      oldWire,
      { ...oldHeader, recipientKeyEpoch: fresh.proof.keyEpoch },
      { recipientKey: fresh.pair, senderPublicKey: f.sender.publicKey },
      f.clock,
    ),
    /PRIVATE_ENVELOPE_INVALID/,
  );
  assert.equal(fresh.proof.keyEpoch, active.keyEpoch + 1);
  assert.deepEqual(f.entries(active.keyId).key.value, activeBytes);
  assert.deepEqual(upgraded.exportPrivateConversationConsent(owner), consent);
  assert.deepEqual(
    upgraded.db.prepare("SELECT * FROM private_incoming_replay").all(),
    incoming,
  );
  assert.deepEqual(
    upgraded.db.prepare("SELECT * FROM messages").all(),
    messages,
  );
  const freshHistory = keys.list();
  await backup.encryptedBackup(upgraded, f.vault, join(f.dir, "new.aib"));
  upgraded.close();
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  const reopened = open(Store);
  assert.equal(
    build(PrivateKeyLifecycle, reopened).validateReplayCoverage(fresh.proof),
    true,
  );
  reopened.close();
  await backup.restoreBackup(
    join(f.dir, "new.aib"),
    f.vault,
    join(f.dir, "restored.db"),
  );
  const restored = open(Store, join(f.dir, "restored.db"));
  const restoredKeys = build(PrivateKeyLifecycle, restored);
  assert.deepEqual(restoredKeys.list().slots, freshHistory.slots);
  assert.equal(restoredKeys.list().needsFreshPairing, true);
  assert.equal(restoredKeys.validateReplayCoverage(fresh.proof), false);
  await assert.rejects(restoredKeys.resolve(), /DENIED/);
  restored.deleteAll({ ...owner, userId: "unrelated" });
  assert.deepEqual(restoredKeys.list().slots, freshHistory.slots);
  restored.deleteAll(owner);
  assert.equal(restoredKeys.list().slots.length, 0);
  assert.equal(restoredKeys.validateReplayCoverage(fresh.proof), false);
  assert.equal(
    build(PrivateKeyLifecycle, restored, pendingOwner).list().slots.length,
    1,
  );
  await oldBackup.restoreBackup(
    join(f.dir, "original.aib"),
    f.vault,
    join(f.dir, "rollback.db"),
  );
  const rollback = open(OldStore, join(f.dir, "rollback.db"));
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 31);
  const rollbackKeys = build(OldLifecycle, rollback);
  assert.deepEqual(rollbackKeys.list().slots, history.slots);
  assert.equal(rollbackKeys.list().needsFreshPairing, true);
  assert.deepEqual(
    rollback.db.prepare("SELECT * FROM messages").all(),
    messages,
  );
  assert.deepEqual(f.entries(active.keyId).key.value, activeBytes);
  const evidence = {
    verifiedAt: new Date().toISOString(),
    from: 31,
    to: 36,
    legacySourceHead: "d3ee4a9e5f82533509fde131e2e284906ed2d9fe",
    legacyCompiledHashes: expectedHashes,
    checks: [
      "actual prior active and generated-but-preparing keys remain uncovered; native bytes unchanged",
      "actual prior empty reservation gains provenance only after new cryptographic generation",
      "explicit new key/epoch obtains coverage while old proof fails and old key bytes survive",
      "actual legacy ciphertext opens with its preserved key but fails with new key and current epoch",
      "messages, current consent records and shared incoming replay are preserved exactly",
      "wrong vault key cannot publish the upgrade; old writer still opens unchanged schema31",
      "schema31 writer refuses schema32; fresh coverage survives current writer reopen",
      "encrypted backup retains provenance as history but restore locks runtime authority",
      "owner deletion removes eligibility without affecting another owner",
      "untouched schema31 backup rolls back using actual prior writer with restored authority locked",
    ],
    limitations: [
      "Mac generation provenance/current-proof prerequisite only; browser boundary and content admission not implemented",
      "no reconstruction or all-time uniqueness guarantee for unknown historical message IDs",
      "no personal data, native Keychain, browser, installed application, service or Acer changes",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/key-replay-boundary-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  for (const s of stores) if (s.db.open) s.close();
  if (f.store.db.open) f.store.close();
  await rm(f.dir, { recursive: true, force: true });
}
