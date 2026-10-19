import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { savedEnrollmentIdentity } from "../modules/task-sync/enrollment-saved-identity.js";
test("saved identity reads a consistent public snapshot without creating or changing state", () => {
  const dir = mkdtempSync(tmpdir() + "/enrollment-identity-");
  const path = dir + "/task.db",
    vault = new Vault(randomBytes(32));
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const principal = "agent:" + randomUUID(),
    sourceWorkspace = randomUUID();
  try {
    assert.throws(() => savedEnrollmentIdentity(path, vault));
    assert.equal(existsSync(path), false);
    const db = new Database(path);
    db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    const put = (key: string, value: unknown) =>
      db
        .prepare("INSERT OR REPLACE INTO state VALUES (?,?)")
        .run(key, vault.seal(value, "task-sync:" + key));
    try {
      assert.throws(() => savedEnrollmentIdentity(path, vault));
      put("key", { ...pair, principal });
      put("review", { sourceWorkspace, tasks: [] });
      const before = readFileSync(path);
      assert.deepEqual(savedEnrollmentIdentity(path, vault), {
        principal,
        publicKey: pair.publicKey,
        sourceWorkspace,
      });
      assert.deepEqual(readFileSync(path), before);
      assert.throws(() =>
        savedEnrollmentIdentity(path, new Vault(randomBytes(32))),
      );
      symlinkSync(path, dir + "/alias.db");
      assert.throws(() => savedEnrollmentIdentity(dir + "/alias.db", vault));
      put("key", {
        ...pair,
        principal,
        privateKey: generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      });
      assert.throws(() => savedEnrollmentIdentity(path, vault), /inconsistent/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
