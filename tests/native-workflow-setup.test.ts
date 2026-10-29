import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import {
  readNativeWorkflowIdentity,
  nativeIdentityReviewActions,
  initializeNativeWorkflowIdentity,
} from "../modules/task-sync/native-identity-review.js";
import { launchWorkflowSetup } from "../apps/companion/workflow-setup-launch.js";

test("native identity inspection does not create missing state and never substitutes another identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-identity-")),
    path = join(dir, "task-sync.db"),
    vault = new Vault(randomBytes(32));
  try {
    assert.deepEqual(readNativeWorkflowIdentity(path, vault), {
      status: "missing",
    });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const db = new Database(path);
    db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    const pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const key = { principal: "agent:" + randomUUID(), ...pair };
    db.prepare("INSERT INTO state VALUES('key',?)").run(
      vault.seal(key, "task-sync:key"),
    );
    db.close();
    const before = await readFile(path),
      r = readNativeWorkflowIdentity(path, vault);
    assert.equal(r.status, "existing");
    if (r.status !== "existing") throw Error("fixture");
    assert.equal(r.principal, key.principal);
    assert.equal(r.sourceWorkspace, null);
    assert.equal(Object.hasOwn(r, "privateKey"), false);
    assert.equal(JSON.stringify(r).includes(key.privateKey), false);
    assert.deepEqual(await readFile(path), before);
    await symlink(path, join(dir, "link"));
    assert.throws(() => readNativeWorkflowIdentity(join(dir, "link"), vault));
    assert.throws(() =>
      readNativeWorkflowIdentity(path, new Vault(randomBytes(32))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("corrupted existing key is held rather than regenerated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-key-mismatch-")),
    path = join(dir, "task-sync.db"),
    vault = new Vault(randomBytes(32));
  try {
    const db = new Database(path);
    db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    const pair = () =>
      generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    db.prepare("INSERT INTO state VALUES('key',?)").run(
      vault.seal(
        {
          principal: "agent:" + randomUUID(),
          publicKey: pair().publicKey,
          privateKey: pair().privateKey,
        },
        "task-sync:key",
      ),
    );
    db.close();
    const before = await readFile(path);
    assert.throws(
      () => readNativeWorkflowIdentity(path, vault),
      /inconsistent/,
    );
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("native setup capability reads only after explicit native request, rejects browser/core/approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-setup-"));
  let unlocks = 0;
  const setup = await launchWorkflowSetup(dir, async () => {
    unlocks++;
    return new Vault(randomBytes(32));
  });
  const {
    BITTREES_WORKFLOW_SETUP_URL: url,
    BITTREES_WORKFLOW_SETUP_TOKEN: token,
  } = setup.environment;
  const call = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(unlocks, 0);
    assert.equal(
      (await call({ action: "propose" }, { origin: "http://127.0.0.1" }))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          { action: "propose" },
          { authorization: "Bearer " + "0".repeat(64) },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call({ action: "propose", principal: "agent:" + randomUUID() }))
        .status,
      400,
    );
    assert.equal(unlocks, 0);
    const r = await call({ action: "propose" });
    assert.equal(r.status, 200);
    const snapshot = (await r.json()) as any;
    assert.equal(snapshot.status, "missing");
    assert.equal(snapshot.rolesEnrollment, "unverified");
    assert.equal(snapshot.grantsAuthority, false);
    assert.equal(unlocks, 1);
    assert.equal(
      (await call({ action: "approve", digest: "a".repeat(64) })).status,
      400,
    );
    const source = await readFile(
      new URL("../apps/macos/Companion.swift", import.meta.url),
      "utf8",
    );
    const engine = source.slice(
      source.indexOf("func startEngine()"),
      source.indexOf("func startEngine()") + 10000,
    );
    assert.equal(
      engine.includes('inherited["BITTREES_WORKFLOW_SETUP_TOKEN"]'),
      false,
    );
  } finally {
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancelled or concurrent native review cannot publish stale identity", async () => {
  let resolve!: (v: { status: "missing" }) => void;
  const actions = nativeIdentityReviewActions(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = actions.propose();
  await assert.rejects(actions.propose(), /unavailable/);
  actions.revoke();
  resolve({ status: "missing" });
  await assert.rejects(pending, /cancelled/);
  actions.close();
  await assert.rejects(actions.propose(), /unavailable/);
  await assert.rejects(
    actions.approve("a".repeat(64)),
    /initialization review/,
  );
});
test("explicit native initialization encrypts one key and cannot replace existing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-initialize-")),
    path = join(dir, "task-sync.db"),
    vault = new Vault(randomBytes(32));
  try {
    let allowed = false;
    assert.throws(() =>
      initializeNativeWorkflowIdentity(path, vault, () => allowed),
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
    allowed = true;
    initializeNativeWorkflowIdentity(path, vault, () => allowed);
    const r = readNativeWorkflowIdentity(path, vault);
    assert.equal(r.status, "existing");
    const before = await readFile(path);
    assert.throws(
      () => initializeNativeWorkflowIdentity(path, vault, () => allowed),
      /Existing identity changed/,
    );
    assert.deepEqual(await readFile(path), before);
    assert.equal(before.includes(Buffer.from("PRIVATE KEY")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("initialization approval is exact, single-use and rechecked after async unlock", async () => {
  let at = 1000,
    initializations = 0,
    release!: () => void;
  const actions = nativeIdentityReviewActions(
    async () => ({ status: "missing" }),
    () => at,
    async (admitted) => {
      await new Promise<void>((r) => {
        release = r;
      });
      if (!admitted()) throw Error("expired before write");
      initializations++;
    },
  );
  const p = await actions.propose();
  const pending = actions.approve(p.reviewDigest);
  at = p.expiresAt;
  release();
  await assert.rejects(pending, /expired/);
  assert.equal(initializations, 0);
  await assert.rejects(
    actions.approve(p.reviewDigest),
    /initialization review/,
  );
  const q = await actions.propose();
  await assert.rejects(
    actions.approve("f".repeat(64)),
    /initialization review/,
  );
  await assert.rejects(
    actions.approve(q.reviewDigest),
    /initialization review/,
  );
});

test("native control creates the missing local key only for the reviewed digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-setup-approval-")),
    vault = new Vault(randomBytes(32));
  const setup = await launchWorkflowSetup(dir, async () => vault);
  const call = async (body: unknown) =>
    fetch(setup.environment.BITTREES_WORKFLOW_SETUP_URL, {
      method: "POST",
      headers: {
        authorization:
          "Bearer " + setup.environment.BITTREES_WORKFLOW_SETUP_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const preview = (await (await call({ action: "propose" })).json()) as any;
    assert.equal(preview.status, "missing");
    assert.equal(
      (await call({ action: "approve", digest: preview.reviewDigest })).status,
      200,
    );
    const existing = (await (await call({ action: "propose" })).json()) as any;
    assert.equal(existing.status, "existing");
    assert.equal(existing.rolesEnrollment, "unverified");
    assert.equal(Object.hasOwn(existing, "privateKey"), false);
    assert.equal(existing.grantsAuthority, false);
    assert.equal(
      (await call({ action: "approve", digest: preview.reviewDigest })).status,
      400,
    );
    assert.equal(
      readNativeWorkflowIdentity(join(dir, "task-sync.db"), vault).status,
      "existing",
    );
  } finally {
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
