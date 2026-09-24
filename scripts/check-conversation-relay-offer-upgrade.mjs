/** Actual compiled schema30 -> 31; synthetic consent/offer, no services or Keychain. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error("Supply the verified compiled task30 directory");
const repo = fileURLToPath(new URL("../", import.meta.url));
const legacy = resolve(process.argv[2]),
  current = join(repo, "dist");
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const storeHash = await hash(join(legacy, "modules/storage/store.js"));
const offersHash = await hash(
  join(legacy, "modules/remote/private-conversation-offers.js"),
);
assert.equal(
  storeHash,
  "ea792bcb6f1fb2695a9a05c2ddaf2ff2e30714a2878930f2115e17eea459217c",
);
assert.equal(
  offersHash,
  "42681fa9ae7c7b6ad9a31b4c11b58cfe013f125d81f6b27a92dbfaae92ae7900",
);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { conversationFixture, owner } = await load(
  legacy,
  "tests/helpers/conversation-fixture",
);
const { PrivateConversationOffers: OldOffers } = await load(
  legacy,
  "modules/remote/private-conversation-offers",
);
const { Store: OldStore } = await load(legacy, "modules/storage/store");
const { Store } = await load(current, "modules/storage/store");
const { Vault } = await load(current, "modules/storage/vault");
const { PrivateConversationOffers } = await load(
  current,
  "modules/remote/private-conversation-offers",
);
const { PrivateConversationConsent } = await load(
  current,
  "modules/remote/private-conversation-consent",
);
const { PrivateKeyLifecycle } = await load(
  current,
  "modules/remote/private-key-lifecycle",
);
const { PrivatePeerEnrollment } = await load(
  current,
  "modules/remote/private-peers",
);
const { privateRelayEnvelopeHash } = await load(
  current,
  "modules/remote/private-relay-contracts",
);
const backup = await load(current, "modules/storage/backup");
const oldBackup = await load(legacy, "modules/storage/backup");
const f = await conversationFixture();
const command = (e) => ({
  id: e.id,
  expectedRevision: e.revision,
  confirmed: true,
});
const build = (s) => {
  const keys = new PrivateKeyLifecycle(
    s,
    f.vault,
    owner,
    f.current,
    f.entries,
    undefined,
    f.clock,
  );
  const peers = new PrivatePeerEnrollment(
    s,
    f.vault,
    owner,
    f.current,
    f.clock,
  );
  const consent = new PrivateConversationConsent(
    s,
    f.vault,
    owner,
    f.current,
    keys,
    peers,
    f.clock,
  );
  return new PrivateConversationOffers(s, f.vault, owner, consent, f.clock);
};
let upgraded, restored, rollback, reopened;
try {
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 30);
  const grant = f.approve(await f.prepare());
  const old = new OldOffers(f.store, f.vault, owner, f.consent, f.clock);
  const ready = await old.resume(
    command(
      await old.prepare({
        clientRequestId: randomUUID(),
        permissionId: grant.grant.id,
        expectedConsentRevision: grant.revision,
        confirmed: true,
      }),
    ),
  );
  assert.equal(ready.value.relay, undefined);
  const consentBefore = f.store.exportPrivateConversationConsent(owner);
  const offersBefore = f.store.exportPrivateConversationOffers(owner);
  const replayBefore = f.store.db
    .prepare("SELECT * FROM private_incoming_replay")
    .all();
  assert.ok(replayBefore.length > 0);
  const sequenceBefore = f.store.db
    .prepare("SELECT * FROM private_send_channels")
    .all();
  await oldBackup.encryptedBackup(
    f.store,
    f.vault,
    join(f.dir, "original.aib"),
  );
  f.store.close();
  assert.throws(() => new Store(f.path, new Vault(randomBytes(32)), f.clock));
  reopened = new OldStore(f.path, f.vault, f.clock);
  assert.equal(reopened.db.pragma("user_version", { simple: true }), 30);
  assert.deepEqual(
    reopened.exportPrivateConversationOffers(owner),
    offersBefore,
  );
  reopened.close();
  reopened = undefined;
  upgraded = new Store(f.path, f.vault, f.clock);
  assert.equal(upgraded.db.pragma("user_version", { simple: true }), 33);
  assert.deepEqual(
    upgraded.exportPrivateConversationOffers(owner),
    offersBefore,
  );
  assert.deepEqual(
    upgraded.exportPrivateConversationConsent(owner),
    consentBefore,
  );
  assert.deepEqual(
    upgraded.db.prepare("SELECT * FROM private_incoming_replay").all(),
    replayBefore,
  );
  const offers = build(upgraded);
  const attempt = await offers.beginRelayDelivery({
    ...command(ready),
    deliveryExpiresAt: ready.value.header.expiresAt,
  });
  assert.equal(attempt.value.relay.attempts, 1);
  assert.equal(attempt.value.relay.observation, null);
  assert.deepEqual(attempt.value.envelope, ready.value.envelope);
  const receipt = {
    version: 1,
    messageId: ready.value.header.messageId,
    envelopeHash: await privateRelayEnvelopeHash(ready.value.envelope),
    revision: 1,
    storedAt: f.clock(),
    state: "stored",
  };
  const saved = await offers.recordRelayDelivery({
    id: attempt.id,
    expectedRevision: attempt.revision,
    receipt,
  });
  assert.deepEqual(saved.value.relay.observation.receipt, receipt);
  assert.deepEqual(
    upgraded.db.prepare("SELECT * FROM private_send_channels").all(),
    sequenceBefore,
  );
  assert.deepEqual(
    upgraded.exportPrivateConversationConsent(owner),
    consentBefore,
  );
  await backup.encryptedBackup(upgraded, f.vault, join(f.dir, "current.aib"));
  upgraded.close();
  upgraded = undefined;
  assert.throws(
    () => new OldStore(f.path, f.vault, f.clock),
    /Unsupported database version/,
  );
  await backup.restoreBackup(
    join(f.dir, "current.aib"),
    f.vault,
    join(f.dir, "restored.db"),
  );
  restored = new Store(join(f.dir, "restored.db"), f.vault, f.clock);
  const lockedOffers = build(restored),
    locked = lockedOffers.get(saved.id);
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.value, saved.value);
  assert.equal(
    restored.exportPrivateConversationConsent(owner).needsReview,
    true,
  );
  await assert.rejects(
    lockedOffers.beginRelayDelivery({
      ...command(locked),
      deliveryExpiresAt: ready.value.header.expiresAt,
    }),
    /DENIED/,
  );
  restored.deleteAll({ ...owner, userId: "other" });
  assert.equal(restored.exportPrivateConversationOffers(owner).length, 1);
  restored.deleteAll(owner);
  assert.deepEqual(restored.exportPrivateConversationOffers(owner), []);
  await oldBackup.restoreBackup(
    join(f.dir, "original.aib"),
    f.vault,
    join(f.dir, "rollback.db"),
  );
  rollback = new OldStore(join(f.dir, "rollback.db"), f.vault, f.clock);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 30);
  const oldRestored = new OldOffers(
    rollback,
    f.vault,
    owner,
    f.build(rollback).consent,
    f.clock,
  ).get(ready.id);
  assert.equal(oldRestored.locked, true);
  assert.deepEqual(oldRestored.value, ready.value);
  const proof = {
    verifiedAt: new Date().toISOString(),
    from: 30,
    to: 33,
    legacySourceHead: "10c57250ea180205286bca5ee60d5063a3bf6382",
    legacyStoreSha256: storeHash,
    legacyOffersSha256: offersHash,
    checks: [
      "genuine prior consent, encrypted offer and incoming replay records preserved",
      "legacy offers acquire no invented relay history",
      "wrong-key upgrade leaves schema30 store usable",
      "new upload attempt and receipt retain original ciphertext and outgoing sequence",
      "upload receipt does not change conversation consent",
      "schema30 writer refuses upgraded schema32",
      "backup/restore preserves receipt history and locks sending authority",
      "owner deletion removes retained offers and relay history without crossing owner scope",
      "untouched schema30 backup remains readable by actual old writer with restored authority locked",
    ],
    boundaries: [
      "synthetic temporary stores and in-memory keys only",
      "no service, browser, Keychain, installed app, inference or Acer changes",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/conversation-relay-offer-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const s of [upgraded, restored, rollback, reopened]) s?.close();
  if (f.store.db.open) f.store.close();
  await rm(f.dir, { recursive: true, force: true });
}
