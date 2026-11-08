import test from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
  verify,
} from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { centralEnrollmentSigner } from "../modules/workflows/central-enrollment-signer.js";
import {
  runtimeHandoffMessage,
  runtimeEnrollmentMessage,
} from "../modules/task-sync/runtime-contract.js";

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "central-enrollment-")),
  );
  const path = join(directory, "central-workflows.db"),
    vault = new Vault(randomBytes(32));
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const saved = {
    ...pair,
    principal: "agent:" + randomUUID(),
    credentialId: createHash("sha256").update(pair.publicKey).digest("hex"),
  };
  const db = new Database(path);
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  db.prepare("INSERT INTO state VALUES('identity',?)").run(
    vault.seal(saved, "central-workflows:identity"),
  );
  db.close();
  const now = Date.now();
  let scope: any = {
    purpose: "central-workflows",
    epoch: randomUUID(),
    expiresAt: now + 60000,
    principal: saved.principal,
    publicKey: saved.publicKey,
    credentialId: saved.credentialId,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
  };
  const signer = () =>
    centralEnrollmentSigner(
      path,
      vault,
      () => scope,
      () => now,
    );
  return {
    directory,
    path,
    vault,
    saved,
    now,
    signer,
    scope: () => scope,
    set: (s: unknown) => {
      scope = s;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("central enrollment signs only the existing purpose-bound key without configuration, export or writes", () => {
  const f = fixture();
  try {
    const before = new Database(f.path, { readonly: true });
    const original = before
      .prepare("SELECT value FROM state WHERE key='identity'")
      .get() as { value: Buffer };
    before.close();
    const signer = f.signer(),
      packet = signer.start();
    assert.equal(
      verify(
        null,
        Buffer.from(runtimeHandoffMessage(packet.request)),
        f.saved.publicKey,
        Buffer.from(packet.signature, "base64"),
      ),
      true,
    );
    const request = {
      version: 1,
      audience: "https://mcp.bittrees.org",
      profileId: randomUUID(),
      principal: f.saved.principal,
      publicKey: f.saved.publicKey,
      authorityId: f.scope().authorityId,
      deviceId: f.scope().deviceId,
      sourceWorkspace: f.scope().sourceWorkspace,
      issuedAt: f.now,
      nonce: randomUUID(),
    };
    f.set({ ...f.scope(), approvedChallenge: request });
    const complete = signer.approved();
    assert.deepEqual(complete.request, request);
    assert.equal(
      verify(
        null,
        Buffer.from(runtimeEnrollmentMessage(request)),
        f.saved.publicKey,
        Buffer.from(complete.signature, "base64"),
      ),
      true,
    );
    assert.equal(
      JSON.stringify({
        packet,
        complete,
        identity: signer.identity(),
      }).includes("PRIVATE KEY"),
      false,
    );
    const after = new Database(f.path, { readonly: true });
    assert.deepEqual(
      (
        after.prepare("SELECT value FROM state WHERE key='identity'").get() as {
          value: Buffer;
        }
      ).value,
      original.value,
    );
    assert.equal(
      (after.prepare("SELECT COUNT(*) n FROM state").get() as { n: number }).n,
      1,
    );
    after.close();
    assert.equal(existsSync(join(f.directory, "task-sync.db")), false);
  } finally {
    f.cleanup();
  }
});
test("changed review or wrong/stale owner challenge cannot obtain a central possession signature", () => {
  for (const change of [
    "epoch",
    "sourceWorkspace",
    "purpose",
    "credentialId",
    "principal",
    "expiresAt",
  ]) {
    const f = fixture();
    try {
      const signer = f.signer();
      f.set({
        ...f.scope(),
        [change]: change === "expiresAt" ? f.now - 1 : randomUUID(),
      });
      assert.throws(() => signer.start());
    } finally {
      f.cleanup();
    }
  }
  for (const field of [
    "principal",
    "publicKey",
    "authorityId",
    "deviceId",
    "sourceWorkspace",
    "issuedAt",
  ]) {
    const f = fixture();
    try {
      const signer = f.signer();
      const scope = f.scope();
      const request = {
        version: 1,
        audience: "https://mcp.bittrees.org",
        profileId: randomUUID(),
        principal: scope.principal,
        publicKey: scope.publicKey,
        authorityId: scope.authorityId,
        deviceId: scope.deviceId,
        sourceWorkspace: scope.sourceWorkspace,
        issuedAt: f.now,
        nonce: randomUUID(),
      };
      Object.assign(request, {
        [field]:
          field === "issuedAt"
            ? f.now - 16000
            : field === "principal"
              ? "agent:" + randomUUID()
              : field === "publicKey"
                ? "wrong"
                : randomUUID(),
      });
      f.set({ ...scope, approvedChallenge: request });
      assert.throws(() => signer.approved());
    } finally {
      f.cleanup();
    }
  }
});
test("missing central identity never creates it or falls back to a task identity", () => {
  const f = fixture();
  try {
    const db = new Database(f.path);
    db.prepare("DELETE FROM state WHERE key='identity'").run();
    db.close();
    const other = new Database(join(f.directory, "task-sync.db"));
    other.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    other
      .prepare("INSERT INTO state VALUES('key',?)")
      .run(f.vault.seal(f.saved, "task-sync:key"));
    other.close();
    assert.throws(() => f.signer(), /Existing central/);
    const after = new Database(f.path, { readonly: true });
    assert.equal(
      (after.prepare("SELECT COUNT(*) n FROM state").get() as { n: number }).n,
      0,
    );
    after.close();
  } finally {
    f.cleanup();
  }
});
