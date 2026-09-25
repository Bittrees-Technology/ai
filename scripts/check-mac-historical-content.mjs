/** Actual schema31 keys through the current authenticated loopback API.
 * Temporary synthetic stores/credentials only; no native Keychain or inference.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
const legacy = resolve(
  process.argv[2] ?? join(repo, ".legacy-mac-key-boundary/dist"),
);
const current = join(repo, "dist");
const hashes = {
  "modules/storage/store.js":
    "d9f95264dfb4304fe3aaaa944a20d5d964cd461b8cb6e4ecfe961a325d5b64fa",
  "modules/remote/private-key-lifecycle.js":
    "284a32749861b5a7d1b5fb1a701f8c7888641f865a3e8c0005fe5b9554bfe6f4",
  "modules/remote/private-endpoint-keys.js":
    "b20e924ef9f8e7d6df500dc42703c05fb7246c836872577a5e7ffab4e281ddb3",
};
for (const [file, hash] of Object.entries(hashes))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(legacy, file)))
      .digest("hex"),
    hash,
  );
const load = (base, file) =>
  import(pathToFileURL(join(base, file + ".js")).href);
const { conversationOfferEndpoints } = await load(
  legacy,
  "tests/helpers/conversation-offer-endpoints",
);
const { Store: OldStore } = await load(legacy, "modules/storage/store");
const { Store } = await load(current, "modules/storage/store");
const { CompanionPrivateKeys } = await load(
  current,
  "apps/companion/private-keys",
);
const { PrivateKeyLifecycle } = await load(
  current,
  "modules/remote/private-key-lifecycle",
);
const { localApi } = await load(current, "apps/companion/http");
const { conversationTaskAccess } = await load(
  current,
  "apps/companion/conversation-access",
);
const { SourceTasks } = await load(current, "modules/connectors/source-tasks");
const { sealPrivateEnvelope, openPrivateEnvelope, privateEnvelopeSuite } =
  await load(current, "modules/remote/private-envelope");
const { conversationContentSchema } = await load(
  current,
  "modules/remote/private-conversation-contracts",
);
const { encryptedBackup, restoreBackup } = await load(
  current,
  "modules/storage/backup",
);
const f = await conversationOfferEndpoints();
const stores = [],
  server = createServer();
let endpoint,
  sequence = 100;
const token = randomBytes(32).toString("hex");
const upgrade = (old, path) => {
  const store = new Store(path, old.vault, f.clock);
  stores.push(store);
  const e = {
    store,
    vault: old.vault,
    owner: old.owner,
    entries: old.entries,
    remote: old.remote,
    grant: old.grant,
  };
  e.keys = (current) =>
    new PrivateKeyLifecycle(
      store,
      e.vault,
      e.owner,
      current,
      e.entries,
      undefined,
      f.clock,
    );
  e.controls = new CompanionPrivateKeys(
    store,
    e.vault,
    e.owner,
    e.entries,
    e.remote,
    true,
    f.clock,
    true,
    {
      enabled: true,
      taskAccess: conversationTaskAccess(
        store,
        e.owner,
        new SourceTasks(),
        undefined,
        f.clock,
      ),
    },
  );
  return e;
};
const key = (e) =>
  e.remote.withVerifiedDevice((scope) => e.keys(scope.current).resolve());
const snapshot = () => ({
  messages: endpoint.store.db
    .prepare("SELECT * FROM messages ORDER BY id")
    .all(),
  journal: endpoint.store.exportPrivateConversationContent(endpoint.owner),
  replay: endpoint.store.db
    .prepare("SELECT * FROM private_incoming_replay")
    .all(),
});
let permission;
const message = () => ({
  version: 1,
  type: "conversation.message",
  scope: {
    permissionId: permission.id,
    conversationRef: permission.conversationRef,
  },
  id: randomUUID(),
  parentId: null,
  content: "SYNTHETIC_HISTORICAL_MAC_MESSAGE",
});
const seal = async (sender, recipient, body) => {
  conversationContentSchema.parse(body);
  const a = await key(sender),
    b = await key(recipient);
  return sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: sender.grant.ownerId,
      senderId: sender.grant.deviceId,
      recipientId: recipient.grant.deviceId,
      senderKeyEpoch: a.proof.keyEpoch,
      recipientKeyEpoch: b.proof.keyEpoch,
      messageId: randomUUID(),
      operationId: body.id,
      sequence: sequence++,
      issuedAt: f.clock(),
      expiresAt: f.clock() + 60000,
    },
    new TextEncoder().encode(JSON.stringify(body)),
    { senderKey: a.pair, recipientPublicKey: b.pair.publicKey },
    f.clock,
  );
};
const pin = async (source, dest) => {
  const inv = await source.controls.peerInvitation({
    recipientId: dest.grant.deviceId,
    expectedKeyRevision: source.controls.peerStatus().keyRevision,
    confirmed: true,
  });
  const state = dest.controls.peerStatus();
  const review = await dest.controls.preparePeer({
    action: "approve",
    expectedRevision: state.revision,
    expectedKeyRevision: state.keyRevision,
    invitation: inv.invitation,
  });
  await dest.controls.confirmPeer({
    reviewId: review.id,
    confirmed: true,
    acknowledged: true,
    comparedFingerprint: inv.fingerprint,
  });
};
const verify = async (source, dest) => {
  const state = source.controls.peerStatus();
  const check = await source.controls.beginPeerCheck({
    peerId: dest.grant.deviceId,
    expectedKeyRevision: state.keyRevision,
    expectedPeerRevision: state.revision,
    confirmed: true,
  });
  const challenge = await source.controls.peerCheckEnvelope({
    id: check.id,
    confirmed: true,
  });
  const response = await dest.controls.respondPeerCheck({
    envelope: challenge,
    confirmed: true,
  });
  const reply = await dest.controls.peerCheckEnvelope({
    id: response.id,
    confirmed: true,
  });
  await source.controls.completePeerCheck({ envelope: reply, confirmed: true });
};
const renew = async (sender) => {
  const state = endpoint.controls.conversationPermissionStatus();
  const review = await endpoint.controls.prepareConversationPermission({
    action: "grant",
    expectedRevision: state.revision,
    expectedKeyRevision: state.keyRevision,
    expectedPeerRevision: state.peerRevision,
    peerId: sender.grant.deviceId,
    peerKeyEpoch: (await key(sender)).proof.keyEpoch,
    conversationId: f.conversationId,
    inboxId: f.inbox.id,
    minutes: 15,
    permissions: {
      messagesToMac: true,
      messagesToBrowser: true,
      questionsToBrowser: false,
      answersToMac: false,
    },
  });
  const stateAfter = await endpoint.controls.confirmConversationPermission({
    reviewId: review.id,
    confirmed: true,
    acknowledged: true,
  });
  const saved = stateAfter.grants.filter((g) => g.state === "saved");
  assert.equal(saved.length, 1);
  permission = endpoint.store
    .exportPrivateConversationConsent(endpoint.owner)
    .grants.find((g) => g.id === saved[0].id);
  assert.ok(permission?.conversationRef);
};
try {
  assert.equal(f.e.store.db.pragma("user_version", { simple: true }), 31);
  permission = f.e.store.exportPrivateConversationConsent(f.e.owner).grants[0];
  const oldKey = await key(f.e),
    senderKey = await key(f.a);
  const originalBytes = f.e.entries(oldKey.proof.keyId).key.bytes.slice();
  const oldBody = message(),
    oldWire = await seal(f.a, f.e, oldBody);
  const messages = f.e.store.db
    .prepare("SELECT * FROM messages ORDER BY id")
    .all();
  f.a.store.close();
  f.e.store.close();
  const sender = upgrade(f.a, join(f.dir, "sender.db"));
  endpoint = upgrade(f.e, join(f.dir, "mac.db"));
  assert.equal(endpoint.store.db.pragma("user_version", { simple: true }), 35);
  assert.deepEqual(snapshot().messages, messages);
  const preserved = await key(endpoint);
  assert.deepEqual(preserved.proof, oldKey.proof);
  assert.equal(
    endpoint.keys(() => null).validateReplayCoverage(preserved.proof),
    false,
  );
  const opened = await openPrivateEnvelope(
    oldWire,
    oldWire.header,
    { recipientKey: preserved.pair, senderPublicKey: senderKey.pair.publicKey },
    f.clock,
  );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(opened.plaintext)),
    oldBody,
  );
  opened.plaintext.fill(0);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const bind = () => {
    server.removeAllListeners("request");
    server.on(
      "request",
      localApi({
        store: endpoint.store,
        owner: endpoint.owner,
        privateKeys: endpoint.controls,
        token,
        port,
      }),
    );
  };
  bind();
  const call = async (path, body, authorization = `Bearer ${token}`) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/private-conversation-content${path}`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, body: await res.json() };
  };
  const receive = (envelope) => ({
    permissionId: permission.id,
    envelope,
    confirmed: true,
  });
  const denyUnchanged = async (path, body, auth) => {
    const before = snapshot(),
      result = await call(path, body, auth);
    assert.equal(
      result.status,
      auth === "" ? 401 : 400,
      JSON.stringify(result),
    );
    if (auth !== "")
      assert.equal(result.body.error, "DENIED", JSON.stringify(result));
    assert.doesNotMatch(
      JSON.stringify(result),
      /SYNTHETIC_HISTORICAL_MAC_MESSAGE|ciphertext|publicKey/,
    );
    assert.deepEqual(snapshot(), before);
    return result;
  };
  assert.equal(
    (await denyUnchanged("/receive", receive(oldWire), "")).status,
    401,
  );
  await denyUnchanged("/receive", receive(oldWire));
  const prepare = () => ({
    id: randomUUID(),
    permissionId: permission.id,
    expectedConsentRevision:
      endpoint.controls.conversationPermissionStatus().revision,
    localMessageId: messages[0].id,
    kind: "message",
    parentId: null,
    expiresAt: f.clock() + 60000,
    confirmed: true,
  });
  await denyUnchanged("/prepare", prepare());
  await renew(sender);
  await denyUnchanged(
    "/receive",
    receive(await seal(sender, endpoint, message())),
  );
  await denyUnchanged("/prepare", prepare());
  const replacement = await endpoint.controls.prepare({
    action: "replace",
    expectedRevision: endpoint.controls.status().state.revision,
  });
  await endpoint.controls.confirm({
    reviewId: replacement.id,
    confirmed: true,
    acknowledged: true,
  });
  const freshKey = await key(endpoint);
  assert.equal(freshKey.proof.keyEpoch, oldKey.proof.keyEpoch + 1);
  assert.notEqual(freshKey.proof.publicKey, oldKey.proof.publicKey);
  await denyUnchanged("/receive", receive(oldWire));
  await pin(endpoint, sender);
  await verify(sender, endpoint);
  await verify(endpoint, sender);
  await denyUnchanged(
    "/receive",
    receive(await seal(sender, endpoint, message())),
  );
  await renew(sender);
  const freshBody = message(),
    freshWire = await seal(sender, endpoint, freshBody);
  const accepted = await call("/receive", receive(freshWire));
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.body.duplicate, false);
  assert.equal(
    endpoint.store.message(endpoint.owner, accepted.body.entry.localMessageId)
      .input.content,
    freshBody.content,
  );
  assert.doesNotMatch(
    JSON.stringify(accepted),
    /SYNTHETIC_HISTORICAL_MAC_MESSAGE|ciphertext|publicKey/,
  );
  const after = snapshot();
  assert.equal(
    (await call("/receive", receive(freshWire))).body.duplicate,
    true,
  );
  assert.deepEqual(snapshot(), after);
  await denyUnchanged("/receive", receive(oldWire));
  const outgoing = await call("/prepare", prepare());
  assert.equal(outgoing.status, 200, JSON.stringify(outgoing));
  const encrypted = await call("/envelope", {
    id: outgoing.body.entry.id,
    permissionId: permission.id,
    expectedRevision: outgoing.body.entry.revision,
    confirmed: true,
  });
  assert.equal(encrypted.status, 200, JSON.stringify(encrypted));
  const retained = snapshot();
  await encryptedBackup(
    endpoint.store,
    endpoint.vault,
    join(f.dir, "current.aib"),
  );
  endpoint.store.close();
  assert.throws(
    () => new OldStore(join(f.dir, "mac.db"), endpoint.vault, f.clock),
    /Unsupported database version/,
  );
  endpoint = upgrade(endpoint, join(f.dir, "mac.db"));
  bind();
  assert.deepEqual(snapshot(), retained);
  assert.equal(
    (await call("/receive", receive(freshWire))).body.duplicate,
    true,
  );
  await denyUnchanged("/receive", receive(oldWire));
  await restoreBackup(
    join(f.dir, "current.aib"),
    endpoint.vault,
    join(f.dir, "restored.db"),
  );
  endpoint = upgrade(endpoint, join(f.dir, "restored.db"));
  bind();
  assert.equal(endpoint.controls.status().state.needsFreshPairing, true);
  assert.ok(snapshot().journal.every((entry) => entry.locked));
  assert.deepEqual(snapshot().messages, retained.messages);
  await denyUnchanged("/receive", receive(freshWire));
  await denyUnchanged("/prepare", prepare());
  assert.deepEqual(f.e.entries(oldKey.proof.keyId).key.bytes, originalBytes);
  const result = {
    verifiedAt: new Date().toISOString(),
    legacySourceHead: "d3ee4a9e5f82533509fde131e2e284906ed2d9fe",
    from: 31,
    to: 35,
    compiledHashes: hashes,
    checks: [
      "actual historical ciphertext decrypts with preserved native material but current authenticated API denies without Inbox, replay or journal changes",
      "independent fresh conversation consent does not promote historical key coverage",
      "explicit key replacement, peer re-verification and new consent permit fresh incoming and outgoing content",
      "duplicate incoming content preserves one Inbox outcome across reopen; old ciphertext remains denied",
      "current encrypted backup preserves history while restored authenticated content access remains locked",
      "original synthetic key bytes survive; actual prior writer refuses upgraded store",
    ],
    boundaries: [
      "temporary synthetic stores and in-memory credentials; literal-loopback ephemeral HTTP only",
      "no personal Keychain, browser/native automation, inference, installed app, deployment or Acer changes",
      "does not establish historical all-time ID uniqueness, remote relay acceptance or personal-device release readiness",
    ],
  };
  const output = resolve(
    process.argv[3] ?? join(repo, "test-results/mac-historical-content.json"),
  );
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((r) => server.close(r));
  for (const store of stores) if (store.db.open) store.close();
  for (const e of [f.a, f.e]) if (e.store.db.open) e.store.close();
  await rm(f.dir, { recursive: true, force: true });
}
