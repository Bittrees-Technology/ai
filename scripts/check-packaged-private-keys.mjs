import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin")
  throw Error("Run on disposable macOS CI only");
const resources = process.argv[2];
assert.ok(resources?.startsWith("/"));
const load = (name) =>
  import(pathToFileURL(join(resources, "engine/dist", name)).href);
const { PrivateEndpointKeys } = await load(
  "modules/remote/private-endpoint-keys.js",
);
const { macPrivateKeyEntries, privateKeyAccount } = await load(
  "apps/companion/private-key-entry.js",
);
const { sealPrivateEnvelope, openPrivateEnvelope, privateEnvelopeSuite } =
  await load("modules/remote/private-envelope.js");
const profile = "endpoint-test-" + randomUUID(),
  localOwner = "synthetic-endpoint-owner",
  keyId = randomUUID();
const account = privateKeyAccount(profile, localOwner, keyId);
let authority = {
  localOwner,
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
  keyId,
  keyEpoch: 1,
  creationAllowed: true,
};
let phase = "initializing";
const watchdog = setTimeout(() => {
  console.error("Packaged private-key operation timed out: " + phase);
  process.exit(1);
}, 45000);
const entryFor = (id) => {
  const entries = macPrivateKeyEntries(
    join(resources, "PrivateKeyInstall"),
    profile,
    localOwner,
    id,
  );
  for (const kind of ["key", "attempt", "deleted"]) {
    const item = entries[kind],
      read = item.getSecret.bind(item),
      add = item.addSecretIfAbsent.bind(item);
    item.getSecret = async () => {
      phase = kind + " read";
      console.log("Endpoint key probe: " + phase);
      return read();
    };
    item.addSecretIfAbsent = async (value) => {
      phase = kind + " add";
      console.log("Endpoint key probe: " + phase);
      return add(value);
    };
  }
  return entries;
};
const manager = () =>
  new PrivateEndpointKeys(localOwner, entryFor, () => authority);
try {
  const first = await manager().create({ keyId, keyEpoch: 1, confirmed: true });
  phase = "untrusted reader probe";
  assert.ok(process.argv[3]?.startsWith("/"));
  const denied = spawnSync(
    process.argv[3],
    [account, join(resources, "PrivateKeyInstall")],
    {
      timeout: 15000,
      encoding: "utf8",
    },
  );
  assert.equal(
    denied.status,
    0,
    "untrusted native probe must be denied secret bytes",
  );
  assert.equal(denied.stdout.trim(), "UNTRUSTED_READ_DENIED");
  const reopened = manager(),
    key = await reopened.resolve();
  assert.equal(key.publicKey, first.publicKey);
  assert.equal(key.incomingReplayCovered, true);
  assert.equal(key.pair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", key.pair.privateKey));
  assert.equal(
    await entryFor(keyId).key.addSecretIfAbsent(new Uint8Array([1, 2, 3])),
    false,
  );
  assert.equal((await manager().resolve()).publicKey, first.publicKey);
  const peer = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    recipientId = randomUUID(),
    now = Date.now();
  const invitation = await reopened.invitation({
    recipientId,
    confirmed: true,
  });
  assert.equal(invitation.invitation.publicKey, first.publicKey);
  const header = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: authority.binding.ownerId,
    senderId: authority.binding.deviceId,
    recipientId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const envelope = await sealPrivateEnvelope(
    header,
    new TextEncoder().encode("synthetic packaged private task"),
    { senderKey: key.pair, recipientPublicKey: peer.publicKey },
  );
  const result = await openPrivateEnvelope(envelope, header, {
    recipientKey: peer,
    senderPublicKey: key.pair.publicKey,
  });
  assert.equal(
    new TextDecoder().decode(result.plaintext),
    "synthetic packaged private task",
  );
  result.plaintext.fill(0);
  authority = null;
  const removed = await reopened.remove({ keyId, confirmed: true });
  assert.equal(removed.remoteRevocationConfirmed, false);
  assert.equal(await entryFor(keyId).key.getSecret(), undefined);
  assert.ok(await entryFor(keyId).attempt.getSecret());
  assert.ok(await entryFor(keyId).deleted.getSecret());
  const { PrivateKeyLifecycle, endpointKeyOwner } = await load(
    "modules/remote/private-key-lifecycle.js",
  );
  const { Store } = await load("modules/storage/store.js");
  const { Vault } = await load("modules/storage/vault.js");
  const { encryptedBackup, restoreBackup } = await load(
    "modules/storage/backup.js",
  );
  const folder = await mkdtemp(join(tmpdir(), "packaged-key-lifecycle-"));
  const scope = { userId: "synthetic", tenantId: "personal" },
    vault = new Vault(randomBytes(32));
  const binding = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  };
  const managedEntries = (id) =>
    macPrivateKeyEntries(
      join(resources, "PrivateKeyInstall"),
      profile,
      endpointKeyOwner(scope),
      id,
    );
  const stores = [];
  const db = (path) => {
    const store = new Store(path, vault);
    stores.push(store);
    return store;
  };
  const store = db(join(folder, "tasks.db"));
  const lifecycle = (database) =>
    new PrivateKeyLifecycle(
      database,
      vault,
      scope,
      () => binding,
      managedEntries,
    );
  const lifecycleManager = lifecycle(store);
  try {
    const reserved = lifecycleManager.begin({
      expectedRevision: 0,
      confirmed: true,
    });
    const active = await lifecycleManager.provision({
      keyId: reserved.keyId,
      expectedRevision: reserved.revision,
      confirmed: true,
    });
    const reopened = lifecycle(db(join(folder, "tasks.db")));
    const proof = (await reopened.resolve()).proof;
    assert.equal(proof.publicKey, active.publicKey);
    assert.equal(reopened.validateReplayCoverage(proof), true);
    await encryptedBackup(store, vault, join(folder, "backup.aib"));
    await restoreBackup(
      join(folder, "backup.aib"),
      vault,
      join(folder, "restored.db"),
    );
    const restored = lifecycle(db(join(folder, "restored.db")));
    assert.equal(restored.list().needsFreshPairing, true);
    assert.equal(restored.validateReplayCoverage(proof), false);
    await assert.rejects(restored.resolve(), /DENIED/);
    await reopened.clearAll({ confirmed: true });
    assert.equal(await managedEntries(active.keyId).key.getSecret(), undefined);
    assert.equal(reopened.list().pendingKeyDeletionCount, 0);
    assert.equal(reopened.validateReplayCoverage(proof), false);
    console.log(
      "Packaged key replay boundary: generation, native reopen, restore lock and deletion passed",
    );
    console.log(
      "Packaged key lifecycle: SQLite selection, native key reopen, restore lock and native cleanup passed",
    );
  } finally {
    await lifecycleManager.clearAll({ confirmed: true });
    for (const database of stores) database.close();
    await rm(folder, { recursive: true, force: true });
  }
  console.log(
    "Packaged endpoint keys: native add-only storage, denied untrusted reader, reopen, nonextractable runtime handles, HPKE and reviewed deletion passed",
  );
} finally {
  // Remove any remaining key bytes. Minimal safety markers remain until this
  // disposable CI runner is destroyed; no production marker-deletion API exists.
  await entryFor(keyId).key.deleteCredential();
  assert.equal(await entryFor(keyId).key.getSecret(), undefined);
  clearTimeout(watchdog);
}
