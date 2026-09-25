/** Actual compiled schema35 writer -> schema39; synthetic temporary files only. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  legacy = join(root, ".legacy-resume-authority/dist"),
  current = join(root, "dist");
const hashes = {
  "modules/storage/store.js":
    "480d3e6300b68e48c6a84bbf7f042755f688adbe449a9239ecbbed18d3146076",
  "modules/storage/backup.js":
    "94ea72f6c8aa4b76285013a4559439ede07c54aad6a0b54ed1f68c383b369c95",
};
for (const [file, hash] of Object.entries(hashes))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(legacy, file)))
      .digest("hex"),
    hash,
  );
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: OldStore } = await load(legacy, "modules/storage/store"),
  { Vault } = await load(current, "modules/storage/vault"),
  { Store } = await load(current, "modules/storage/store"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(current, "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "bittrees-resume-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" },
  now = 2000000,
  stores = [];
try {
  const old = new OldStore(path, vault, () => now);
  stores.push(old);
  old.addProfile(owner, {
    id: "test",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 1000,
    temperature: 0,
  });
  const created = old.create(
      owner,
      {
        conversationId: "synthetic",
        kind: "query",
        prompt: "PRIVATE_UPGRADE_TASK",
        modelProfileId: "test",
      },
      randomUUID(),
    ),
    paused = old.command(owner, created.id, {
      command: "pause",
      expectedRevision: 1,
    });
  const control = {
    remoteOwnerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    controlId: randomUUID(),
    expiresAt: now + 600000,
  };
  old.allowRemoteControls(owner, control);
  assert.equal(old.db.pragma("user_version", { simple: true }), 35);
  await oldBackup.encryptedBackup(old, vault, join(dir, "old.enc"));
  old.close();
  assert.throws(() => new Store(path, new Vault(randomBytes(32)), () => now));
  const unchanged = new OldStore(path, vault, () => now);
  stores.push(unchanged);
  assert.deepEqual(unchanged.get(owner, paused.id), paused);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 35);
  unchanged.close();
  let s = new Store(path, vault, () => now);
  stores.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 39);
  assert.deepEqual(s.get(owner, paused.id), paused);
  assert.equal(
    s.remoteControlsAllowed(owner, {
      remoteOwnerId: control.remoteOwnerId,
      deviceId: control.deviceId,
      epoch: 1,
      controlId: control.controlId,
    }),
    true,
  );
  assert.deepEqual(s.remoteResumes.history(owner), []);
  const identity = {
      scope: "tasks:resume",
      remoteOwnerId: control.remoteOwnerId,
      deviceId: control.deviceId,
      epoch: 1,
      permissionId: randomUUID(),
    },
    approval = {
      identity,
      taskId: paused.id,
      taskRevision: paused.revision,
      modelDigest: "a".repeat(64),
      expiresAt: now + 600000,
      confirmed: true,
    },
    command = {
      version: 1,
      id: randomUUID(),
      deviceId: identity.deviceId,
      permissionId: identity.permissionId,
      taskId: paused.id,
      expectedRevision: paused.revision,
      command: "resume",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    };
  await assert.rejects(
    s.remoteResumes.execute(owner, control, command, async () => () => {}),
  );
  await assert.rejects(
    s.remoteResumes.execute(owner, identity, command, async () => () => {}),
    /NOT_FOUND/,
  );
  s.remoteResumes.approve(owner, approval);
  const first = await s.remoteResumes.execute(
    owner,
    identity,
    command,
    async () => () => {},
  );
  assert.equal(first.receipt.outcome, "queued");
  await backup.encryptedBackup(s, vault, join(dir, "new.enc"));
  s.close();
  assert.throws(
    () => new OldStore(path, vault, () => now),
    /Unsupported database version/,
  );
  s = new Store(path, vault, () => now);
  stores.push(s);
  assert.deepEqual(await s.remoteResumes.execute(owner, identity, command), {
    ...first,
    duplicate: true,
  });
  s.close();
  await backup.restoreBackup(
    join(dir, "new.enc"),
    vault,
    join(dir, "restored.db"),
  );
  const restored = new Store(join(dir, "restored.db"), vault, () => now);
  stores.push(restored);
  assert.equal(restored.remoteResumes.history(owner)[0].revoked, true);
  assert.deepEqual(restored.remoteResumes.receipts(owner), [first.receipt]);
  await assert.rejects(
    restored.remoteResumes.execute(
      owner,
      identity,
      command,
      async () => () => {},
    ),
    /NOT_FOUND/,
  );
  await oldBackup.restoreBackup(
    join(dir, "old.enc"),
    vault,
    join(dir, "rollback.db"),
  );
  const rolled = new OldStore(join(dir, "rollback.db"), vault, () => now);
  stores.push(rolled);
  assert.equal(rolled.db.pragma("user_version", { simple: true }), 35);
  assert.equal(rolled.get(owner, paused.id).status, "paused");
  assert.equal(
    rolled.remoteControlsAllowed(owner, {
      remoteOwnerId: control.remoteOwnerId,
      deviceId: control.deviceId,
      epoch: 1,
      controlId: control.controlId,
    }),
    false,
  );
  const evidence = {
    legacySourceHead: "3dbcf4e02ef22a2f4851779b11ba4255e8f6a4ae",
    compiledHashes: hashes,
    from: 35,
    to: 39,
    checks: [
      "actual old writer preserves task and pause/cancel grant; migration creates no resume authority",
      "wrong vault leaves prior schema and content unchanged",
      "fresh separate approval executes once and receipt survives reopen",
      "actual old writer refuses schema39",
      "current encrypted restore locks resume permission while retaining receipt",
      "untouched actual schema35 backup rolls back with restored control authority locked",
    ],
    limitations: [
      "companion-side authority core only; source/model provider, credential delivery, remote UI and end-to-end acceptance remain separate",
      "no personal data, live service, native automation or Acer access",
    ],
  };
  await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(
    join(root, "test-results/resume-authority-upgrade.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  for (const s of stores) if (s.db.open) s.close();
  await rm(dir, { recursive: true, force: true });
}
