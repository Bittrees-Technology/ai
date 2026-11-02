import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { readCentralIdentity } from "../modules/workflows/central-identity-review.js";
import { launchWorkflowSetup } from "../apps/companion/workflow-setup-launch.js";

test("central review needs no Roles profile/config and preserves existing encrypted identity", async () => {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "central-identity-")),
    path = join(dir, "central-workflows.db"),
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
  const put = (value: unknown) => {
    const db = new Database(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    db.prepare("INSERT OR REPLACE INTO state VALUES('identity',?)").run(
      vault.seal(value, "central-workflows:identity"),
    );
    db.close();
  };
  let setup: Awaited<ReturnType<typeof launchWorkflowSetup>> | undefined;
  try {
    put(saved);
    const before = await readFile(path);
    setup = await launchWorkflowSetup(dir, async () => vault);
    const call = (
      body: unknown,
      token = setup!.environment.BITTREES_CENTRAL_IDENTITY_TOKEN,
    ) =>
      fetch(setup!.environment.BITTREES_CENTRAL_IDENTITY_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let r = await call({ action: "propose" });
    assert.equal(r.status, 200);
    const result = (await r.json()) as any;
    assert.equal(result.purpose, "central-workflows");
    assert.equal(result.principal, saved.principal);
    assert.equal(result.credentialId, saved.credentialId);
    assert.equal(result.permissionsGranted, false);
    assert.equal(result.rolesEnrollment, "unverified");
    assert.equal(Object.hasOwn(result, "privateKey"), false);
    assert.equal(Object.hasOwn(result, "profileId"), false);
    assert.equal(JSON.stringify(result).includes(saved.privateKey), false);
    assert.deepEqual(await readFile(path), before);
    r = await call({ action: "approve", digest: "a".repeat(64) });
    assert.equal(r.status, 400);
    r = await call(
      { action: "propose" },
      setup.environment.BITTREES_WORKFLOW_SETUP_TOKEN,
    );
    assert.equal(r.status, 403);
    r = await call({ action: "propose", profileId: randomUUID() });
    assert.equal(r.status, 400);
    assert.deepEqual(await readFile(path), before);
    put({ ...saved, credentialId: "f".repeat(64) });
    const corrupt = await readFile(path);
    assert.throws(() => readCentralIdentity(path, vault), /inconsistent/);
    assert.deepEqual(await readFile(path), corrupt);
    await symlink(path, join(dir, "link"));
    assert.throws(() => readCentralIdentity(join(dir, "link"), vault));
  } finally {
    await setup?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing central identity never creates a file/key or substitutes task-sync identity", async () => {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "central-missing-")),
    path = join(dir, "central-workflows.db"),
    vault = new Vault(randomBytes(32));
  let unlocks = 0;
  const db = new Database(join(dir, "task-sync.db"));
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  db.prepare("INSERT INTO state VALUES('key',?)").run(
    vault.seal({ principal: "do-not-substitute" }, "task-sync:key"),
  );
  db.close();
  const taskBefore = await readFile(join(dir, "task-sync.db"));
  const setup = await launchWorkflowSetup(dir, async () => {
    unlocks++;
    return vault;
  });
  try {
    assert.equal(unlocks, 0);
    const r = await fetch(setup.environment.BITTREES_CENTRAL_IDENTITY_URL, {
      method: "POST",
      headers: {
        authorization:
          "Bearer " + setup.environment.BITTREES_CENTRAL_IDENTITY_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "propose" }),
    });
    assert.equal(r.status, 200);
    const result = (await r.json()) as any;
    assert.equal(result.status, "missing");
    assert.equal(result.principal, null);
    assert.equal(result.publicKey, null);
    assert.equal(result.credentialId, null);
    assert.equal(result.permissionsGranted, false);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(dir, "task-sync.db")), taskBefore);
    const empty = new Database(path);
    empty.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    empty.close();
    const before = await readFile(path);
    assert.deepEqual(readCentralIdentity(path, vault), { status: "missing" });
    assert.deepEqual(await readFile(path), before);
  } finally {
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
