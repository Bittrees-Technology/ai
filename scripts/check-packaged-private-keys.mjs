import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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
const { AsyncEntry } = createRequire(join(resources, "engine/package.json"))(
  "@napi-rs/keyring",
);
const profile = "endpoint-test-" + randomUUID(),
  localOwner = "synthetic-endpoint-owner",
  keyId = randomUUID();
const account = privateKeyAccount(profile, localOwner, keyId),
  services = [
    "org.bittrees.ai.endpoint-keys",
    "org.bittrees.ai.endpoint-key-attempts",
    "org.bittrees.ai.endpoint-key-deletions",
  ];
const credentials = services.map((service) => new AsyncEntry(service, account));
for (const entry of credentials)
  assert.equal((await entry.getSecret()) == null, true);
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
      return read();
    };
    item.addSecretIfAbsent = async (value) => {
      phase = kind + " add";
      return add(value);
    };
  }
  return entries;
};
const manager = () =>
  new PrivateEndpointKeys(localOwner, entryFor, () => authority);
try {
  const first = await manager().create({ keyId, keyEpoch: 1, confirmed: true });
  const reopened = manager(),
    key = await reopened.resolve();
  assert.equal(key.publicKey, first.publicKey);
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
  assert.equal((await credentials[0].getSecret()) == null, true);
  assert.ok(await credentials[1].getSecret());
  assert.ok(await credentials[2].getSecret());
  console.log(
    "Packaged endpoint keys: native add-only storage, reopen, nonextractable runtime handles, HPKE and reviewed deletion passed",
  );
} finally {
  // Only the three random synthetic test entries, never a personal profile.
  for (const entry of credentials)
    if (await entry.getSecret()) await entry.deleteCredential();
  for (const entry of credentials)
    assert.equal((await entry.getSecret()) == null, true);
  clearTimeout(watchdog);
}
