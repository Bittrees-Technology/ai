import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin")
  throw Error("Run on disposable macOS CI only");
const resources = process.argv[2],
  probe = process.argv[3];
assert.ok(resources?.startsWith("/") && probe?.startsWith("/"));
const load = (name) =>
  import(pathToFileURL(join(resources, "engine/dist", name + ".js")).href);
const { Store } = await load("modules/storage/store"),
  { Vault } = await load("modules/storage/vault"),
  { PrivateRelayCustody } = await load("modules/remote/private-relay-custody"),
  { macPrivateRelayEntries } = await load("apps/companion/private-relay-entry"),
  { macPrivateKeyEntries, privateKeyAccount } = await load(
    "apps/companion/private-key-entry",
  ),
  { endpointKeyOwner } = await load("modules/remote/private-key-lifecycle"),
  { encryptedBackup, restoreBackup } = await load("modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "packaged-relay-custody-")),
  owner = { userId: "synthetic", tenantId: "personal" },
  profile = "relay-test-" + randomUUID(),
  helper = join(resources, "PrivateKeyInstall"),
  vault = new Vault(randomBytes(32)),
  provider = macPrivateRelayEntries(helper, profile),
  path = join(dir, "tasks.db");
const stores = [],
  slots = new Set();
const db = (p) => {
  const store = new Store(p, vault);
  stores.push(store);
  return store;
};
const store = db(path),
  now = Date.now(),
  credential = randomBytes(32).toString("base64url"),
  binding = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: now + 3600000,
  };
let grant = {
  id: randomUUID(),
  ownerId: binding.ownerId,
  endpointKind: "mac",
  endpointId: binding.deviceId,
  credentialEpoch: 1,
  operationId: randomUUID(),
  revision: 1,
  state: "pending",
  createdAt: now - 1,
  expiresAt: now + 1800000,
  approvalExpiresAt: now + 120000,
  revokedAt: null,
};
const enrollment = {
  async withPrivateRelayEnrollment(action) {
    let closed = false;
    try {
      return await action({
        current: () => (closed ? null : { ...binding }),
        inspect: async () => structuredClone(grant),
        accept: async (raw) => {
          assert.deepEqual(raw, {
            id: grant.id,
            expectedRevision: 1,
            confirmed: true,
          });
          assert.equal(grant.state, "pending");
          grant = {
            ...grant,
            state: "active",
            revision: 2,
            approvalExpiresAt: null,
          };
          return {
            grant: structuredClone(grant),
            credential,
            scope: "private:relay",
          };
        },
        identifyRelay: async (value) => {
          assert.equal(value, credential);
          return {
            version: 1,
            scope: "private:relay",
            ownerId: binding.ownerId,
            endpointId: binding.deviceId,
            endpointKind: "mac",
            credentialEpoch: 1,
            permissionId: grant.id,
            expiresAt: grant.expiresAt,
          };
        },
        revokeRelay: async (value, raw) => {
          assert.equal(value, credential);
          assert.equal(raw.expectedRevision, 2);
          grant = {
            ...grant,
            state: "revoked",
            revision: 3,
            revokedAt: Date.now(),
          };
          return structuredClone(grant);
        },
      });
    } finally {
      closed = true;
    }
  },
};
const entries = {
  forSlot(scope, id) {
    slots.add(id);
    return provider.forSlot(scope, id);
  },
};
const custody = (database) =>
  new PrivateRelayCustody(
    database,
    vault,
    owner,
    entries,
    enrollment,
    async () => {
      throw Error("No message transport in custody probe");
    },
  );
let phase = "setup";
const watchdog = setTimeout(() => {
  console.error("Packaged relay custody timed out: " + phase);
  process.exit(1);
}, 60000);
try {
  const c = custody(store),
    review = await c.review({ id: grant.id }),
    active = await c.confirm({ reviewId: review.reviewId, confirmed: true });
  phase = "native reopen";
  const reopened = custody(db(path));
  assert.equal(
    await reopened.withClient(
      { id: active.id, expectedRevision: active.revision },
      async () => "verified",
    ),
    "verified",
  );
  assert.equal(
    await provider
      .forSlot(owner, active.id)
      .key.addSecretIfAbsent(new Uint8Array([1, 2, 3])),
    false,
  );
  assert.equal(
    await macPrivateKeyEntries(
      helper,
      profile,
      endpointKeyOwner(owner),
      active.id,
    ).key.getSecret(),
    undefined,
    "Endpoint keys and relay credentials use separate native account domains",
  );
  assert.ok(!JSON.stringify(reopened.list()).includes(credential));
  const account = privateKeyAccount(
    profile,
    "private-relay:" +
      createHash("sha256")
        .update(JSON.stringify([owner.tenantId, owner.userId]))
        .digest("hex"),
    active.id,
  );
  phase = "untrusted native reader";
  const denied = spawnSync(probe, [account, helper], {
    timeout: 15000,
    encoding: "utf8",
  });
  assert.equal(
    denied.status,
    0,
    "untrusted native reader must be denied relay credential bytes",
  );
  assert.equal(denied.stdout.trim(), "UNTRUSTED_READ_DENIED");
  phase = "backup restore lock";
  await encryptedBackup(store, vault, join(dir, "backup.aib"));
  await restoreBackup(join(dir, "backup.aib"), vault, join(dir, "restored.db"));
  const restored = custody(db(join(dir, "restored.db"))),
    row = restored.list().items[0];
  assert.equal(row.locked, true);
  await assert.rejects(
    restored.withClient(
      { id: row.id, expectedRevision: row.revision },
      async () => "must not run",
    ),
    /DENIED/,
  );
  phase = "reviewed revoke and native deletion";
  const revoked = await reopened.revoke({
    id: active.id,
    expectedRevision: active.revision,
    confirmed: true,
  });
  assert.equal(revoked.remoteRevocationConfirmed, true);
  await reopened.remove({
    id: active.id,
    expectedRevision: revoked.revision,
    confirmed: true,
  });
  assert.equal(
    await provider.forSlot(owner, active.id).key.getSecret(),
    undefined,
  );
  assert.ok(await provider.forSlot(owner, active.id).attempt.getSecret());
  assert.ok(await provider.forSlot(owner, active.id).deleted.getSecret());
  console.log(
    "Packaged private relay custody: native add-only storage, distinct endpoint-key account, untrusted-reader denial, SQLite reopen, restore lock, synthetic revocation and native cleanup passed",
  );
} finally {
  for (const id of slots)
    await provider.forSlot(owner, id).key.deleteCredential();
  for (const database of stores) database.close();
  await rm(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
}
