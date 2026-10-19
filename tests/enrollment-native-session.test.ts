import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { nativeEnrollmentSessionFactory } from "../modules/task-sync/enrollment-native-session.js";

test("native session requires admission before storage and never reads credentials on construction or denial", async () => {
  const dir = mkdtempSync(tmpdir() + "/enrollment-native-");
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const review = {
    epoch: randomUUID(),
    expiresAt: 400000,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey,
    ownerWallet: "0x" + "a".repeat(40),
  };
  let allowed = false,
    reads = 0;
  const options = {
    path: dir + "/state.db",
    vault: new Vault(randomBytes(32)),
    pinnedSigner: publicKey,
    credential: () => {
      reads++;
      throw Error("Must not read");
    },
    admitted: () => allowed,
    now: () => 100000,
  };
  try {
    assert.throws(() =>
      nativeEnrollmentSessionFactory({ ...options, path: "relative.db" }),
    );
    assert.throws(() =>
      nativeEnrollmentSessionFactory({ ...options, pinnedSigner: "invalid" }),
    );
    const factory = nativeEnrollmentSessionFactory(options);
    assert.equal(existsSync(options.path), false);
    assert.throws(() => factory(() => review), /admission/);
    assert.equal(existsSync(options.path), false);
    allowed = true;
    const session = factory(() => review);
    try {
      assert.equal(reads, 0);
      allowed = false;
      await assert.rejects(
        session.execute(
          { operation: "heartbeat" },
          new AbortController().signal,
        ),
      );
      assert.equal(reads, 0);
    } finally {
      session.close();
    }
    assert.equal(existsSync(options.path + ".enrollment-owner"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
