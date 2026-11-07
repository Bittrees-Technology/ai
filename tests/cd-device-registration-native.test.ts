import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  cdDeviceRegistrationNative,
  cdNativeRegistrationMessage,
} from "../modules/research/cd-device-registration-native.js";

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
test("disabled CD signer rejects before touching custody", () => {
  let ownerCalls = 0;
  const native = cdDeviceRegistrationNative({
    path: "/missing/cryptodirectory-device.db",
    vault: new Vault(randomBytes(32)),
    currentOwner() {
      ownerCalls++;
      return null;
    },
  });
  assert.throws(() => native.review({}), /disabled/);
  assert.throws(() => native.approve({}), /disabled/);
  assert.throws(() => native.sign(), /disabled/);
  assert.equal(ownerCalls, 0);
});

test("only fresh native-approved CD registration signs once with read-only dedicated custody", () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "cd-native-registration."),
  );
  const path = join(root, "cryptodirectory-device.db");
  const vault = new Vault(randomBytes(32));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const actor = "agent:" + randomUUID(),
    credentialId = sha(keys.publicKey);
  let now = Date.now(),
    ownerAvailable = true;
  const raw = {
    request: {
      version: 1 as const,
      audience:
        "https://roles.bittrees.org/api/profile/mcp/devices/register" as const,
      purpose: "crypto-directory:read-access" as const,
      requestId: randomUUID(),
      deviceId: randomUUID(),
      ownerProfile: randomUUID(),
      principal: actor,
      credentialId,
      label: "Separate CD fixture Mac",
      sessionBinding: "a".repeat(64),
      issuedAt: now,
      expiresAt: now + 60000,
    },
    challenge: "opaque-sealed-server-challenge",
    registered: false as const,
    permissionsGranted: false as const,
  };
  const owner = {
    ownerProfile: raw.request.ownerProfile,
    sessionBinding: raw.request.sessionBinding,
    principal: actor,
    credentialId,
    enrolled: true as const,
    credentialKind: "non-lease" as const,
    preparedPacketDigest: sha(canonical(raw)),
    preparedEndpoint:
      "https://roles.bittrees.org/api/profile/mcp/devices/prepare" as const,
    authenticatedAt: now,
    sessionExpiresAt: now + 600000,
  };
  const seed = (change: object = {}) => {
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS cd_device_identity(id INTEGER PRIMARY KEY,value BLOB NOT NULL)",
      );
      db.prepare("INSERT OR REPLACE INTO cd_device_identity VALUES (1,?)").run(
        vault.seal(
          {
            purpose: "crypto-directory:read-access",
            credentialKind: "non-lease",
            principal: actor,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            ...change,
          },
          "crypto-directory-device:identity",
        ),
      );
    } finally {
      db.close();
    }
    chmodSync(path, 0o600);
  };
  const native = () =>
    cdDeviceRegistrationNative({
      enabled: true,
      path,
      vault,
      currentOwner: () => (ownerAvailable ? owner : null),
      now: () => now,
    });
  // Review confirmation takes exact digest fields, never arbitrary request text.
  const confirm = (device: ReturnType<typeof native>) => {
    const { id, requestDigest, packetDigest } = device.review(raw);
    device.approve({ id, requestDigest, packetDigest, confirmed: true });
  };
  try {
    seed();
    const before = sha(readFileSync(path));
    const device = native();
    assert.throws(() => device.sign(), /confirmation/);
    confirm(device);
    const signed = device.sign();
    assert.deepEqual(Object.keys(signed).sort(), ["challenge", "signature"]);
    assert.equal(signed.challenge, raw.challenge);
    assert.ok(
      verify(
        null,
        Buffer.from(cdNativeRegistrationMessage(raw.request)),
        keys.publicKey,
        Buffer.from(signed.signature, "base64"),
      ),
    );
    assert.equal(
      cdNativeRegistrationMessage(raw.request),
      "Bittrees CryptoDirectory device registration v1\n" +
        canonical(raw.request),
    );
    assert.throws(() => device.sign(), /confirmation/);
    assert.equal(sha(readFileSync(path)), before);

    for (const field of [
      "ownerProfile",
      "principal",
      "credentialId",
      "sessionBinding",
      "deviceId",
      "purpose",
      "audience",
      "label",
      "requestId",
    ] as const) {
      const changed = structuredClone(raw);
      (changed.request as Record<string, unknown>)[field] = [
        "ownerProfile",
        "deviceId",
        "requestId",
      ].includes(field)
        ? randomUUID()
        : "changed";
      assert.throws(() => native().review(changed));
    }
    const changedChallenge = {
      ...raw,
      challenge: "different-sealed-challenge",
    };
    assert.throws(() => native().review(changedChallenge), /Current CD owner/);

    const revoked = native();
    confirm(revoked);
    ownerAvailable = false;
    assert.throws(() => revoked.sign(), /Current CD owner/);
    ownerAvailable = true;
    const swapped = native();
    confirm(swapped);
    owner.sessionBinding = "b".repeat(64);
    assert.throws(() => swapped.sign(), /Current CD owner/);
    owner.sessionBinding = raw.request.sessionBinding;
    const expired = native();
    confirm(expired);
    now = raw.request.expiresAt;
    assert.throws(() => expired.sign(), /expired/);
    now = raw.request.issuedAt;
    const cancelled = native();
    confirm(cancelled);
    cancelled.revoke();
    assert.throws(() => cancelled.sign(), /confirmation/);
    const tooLong = structuredClone(raw);
    tooLong.request.expiresAt++;
    owner.preparedPacketDigest = sha(canonical(tooLong));
    assert.throws(() => native().review(tooLong), /expired/);
    owner.preparedPacketDigest = sha(canonical(raw));

    const keyChanged = native();
    confirm(keyChanged);
    seed({ principal: "agent:" + randomUUID() });
    assert.throws(() => keyChanged.sign(), /key changed/);
    seed({ credentialKind: "lease" });
    assert.throws(() => native().review(raw));
    seed({ purpose: "central-workflows" });
    assert.throws(() => native().review(raw));
    seed();
    chmodSync(path, 0o644);
    assert.throws(() => native().review(raw), /private CD/);
    assert.throws(
      () =>
        cdDeviceRegistrationNative({
          enabled: true,
          path: join(root, "central-workflows.db"),
          vault,
          currentOwner: () => owner,
          now: () => now,
        }).review(raw),
      /CD-purpose/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
