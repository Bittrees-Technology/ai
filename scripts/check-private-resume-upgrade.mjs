/** Actual compiled schema36 to39 acceptance; disposable synthetic storage only. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const legacy = join(root, ".legacy-private-resume/dist"),
  current = join(root, "dist");
const hashes = {
  "modules/storage/store.js":
    "7a4b34f6ab40e7683ef294f72cf6b894a03646a097796c9e1ae89bc96242ecdb",
  "modules/storage/backup.js":
    "f760a546c49db26c18ded81390f5dc9b70264e4645726d800711c55c512ed26c",
  "modules/storage/remote-resumes.js":
    "810059ac07690c0453c4dd1b27e978c954dfc894707b4b0c6961ceb9c384ddeb",
  "modules/remote/resume-contracts.js":
    "7cd29bbe881b13b270412a06bb5e68fd3f6b5448f9bac3b008f6e9b28b6c29b5",
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
  { Store } = await load(current, "modules/storage/store"),
  { Vault } = await load(current, "modules/storage/vault"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(current, "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "private-resume-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" },
  now = 2000000,
  stores = [];
const profile = {
  id: "test",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
try {
  const old = new OldStore(path, vault, () => now);
  stores.push(old);
  old.addProfile(owner, profile);
  function pausedGrant(label) {
    let task = old.create(
      owner,
      {
        conversationId: label,
        kind: "query",
        prompt: "SYNTHETIC_" + label,
        modelProfileId: profile.id,
      },
      randomUUID(),
    );
    task = old.command(owner, task.id, {
      command: "pause",
      expectedRevision: task.revision,
    });
    const identity = {
      scope: "tasks:resume",
      remoteOwnerId: randomUUID(),
      deviceId: randomUUID(),
      epoch: 1,
      permissionId: randomUUID(),
    };
    const approval = {
      identity,
      taskId: task.id,
      taskRevision: task.revision,
      modelDigest: "a".repeat(64),
      expiresAt: now + 600000,
      confirmed: true,
    };
    old.remoteResumes.approve(owner, approval);
    const command = {
      version: 1,
      id: randomUUID(),
      deviceId: identity.deviceId,
      permissionId: identity.permissionId,
      taskId: task.id,
      expectedRevision: task.revision,
      command: "resume",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    };
    return { task, identity, approval, command };
  }
  const unused = pausedGrant("UNUSED"),
    used = pausedGrant("USED");
  const receipt = await old.remoteResumes.execute(
    owner,
    used.identity,
    used.command,
    async () => () => {},
  );
  const history = old.remoteResumes.history(owner),
    receipts = old.remoteResumes.receipts(owner),
    usedTask = old.get(owner, used.task.id);
  assert.equal(old.db.pragma("user_version", { simple: true }), 36);
  await oldBackup.encryptedBackup(old, vault, join(dir, "old.enc"));
  old.close();
  const oldBackupHash = createHash("sha256")
    .update(await readFile(join(dir, "old.enc")))
    .digest("hex");
  assert.throws(() => new Store(path, new Vault(randomBytes(32)), () => now));
  const unchanged = new OldStore(path, vault, () => now);
  stores.push(unchanged);
  assert.equal(unchanged.db.pragma("user_version", { simple: true }), 36);
  assert.deepEqual(unchanged.remoteResumes.history(owner), history);
  unchanged.close();
  let s = new Store(path, vault, () => now);
  stores.push(s);
  assert.equal(s.db.pragma("user_version", { simple: true }), 39);
  assert.deepEqual(s.get(owner, unused.task.id), unused.task);
  assert.deepEqual(s.get(owner, used.task.id), usedTask);
  assert.deepEqual(s.profile(owner, profile.id), profile);
  assert.deepEqual(s.remoteResumes.history(owner), history);
  assert.deepEqual(s.remoteResumes.receipts(owner), receipts);
  assert.deepEqual(s.exportPrivateResumeConsent(owner), {
    revision: 0,
    needsReview: false,
    grants: [],
  });
  assert.equal(
    s.remoteResumes
      .history(owner)
      .some((x) => x.permission?.approval.privatePeerBound),
    false,
  );
  const duplicate = await s.remoteResumes.execute(
    owner,
    used.identity,
    used.command,
  );
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.receipt, receipt.receipt);
  const resumed = await s.remoteResumes.execute(
    owner,
    unused.identity,
    unused.command,
    async () => () => {},
  );
  assert.equal(resumed.duplicate, false);
  s.close();
  assert.throws(() => new OldStore(path, vault, () => now));
  s = new Store(path, vault, () => now);
  stores.push(s);
  assert.equal(
    (await s.remoteResumes.execute(owner, unused.identity, unused.command))
      .duplicate,
    true,
  );
  // Backup restore preserves receipts while disabling every old resume permission.
  await backup.encryptedBackup(s, vault, join(dir, "current.enc"));
  await backup.restoreBackup(
    join(dir, "current.enc"),
    vault,
    join(dir, "restored.db"),
  );
  const restored = new Store(join(dir, "restored.db"), vault, () => now);
  stores.push(restored);
  assert.equal(restored.remoteResumes.receipts(owner).length, 2);
  assert.equal(
    restored.remoteResumes.history(owner).every((x) => x.revoked),
    true,
  );
  await assert.rejects(
    restored.remoteResumes.execute(owner, used.identity, used.command),
    /NOT_FOUND/,
  );
  restored.close();
  s.close();
  await oldBackup.restoreBackup(
    join(dir, "old.enc"),
    vault,
    join(dir, "rollback.db"),
  );
  const rollback = new OldStore(join(dir, "rollback.db"), vault, () => now);
  stores.push(rollback);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 36);
  assert.deepEqual(rollback.get(owner, unused.task.id), unused.task);
  assert.deepEqual(rollback.get(owner, used.task.id), usedTask);
  assert.deepEqual(rollback.remoteResumes.receipts(owner), receipts);
  assert.equal(
    rollback.remoteResumes.history(owner).every((x) => x.revoked),
    true,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(dir, "old.enc")))
      .digest("hex"),
    oldBackupHash,
  );
  const evidence = {
    legacySourceCommit: "3c697c8388b0a06ab570db61637f6fe70ee687a6",
    legacyArchiveSha256:
      "234ad3525b4e59ae1f7eae97cfc2942b73c880ca8e57c9dbe9f1f3e7c9c1145e",
    legacyHashes: hashes,
    from: 36,
    to: 39,
    assertions: [
      "wrong key leaves actual36 store writable and unchanged",
      "existing tasks/profile/unconsumed and consumed grants/receipt preserved",
      "no implicit private resume consent",
      "old receipt duplicate stable; unconsumed internal grant applies once across reopen",
      "actual36 writer refuses39",
      "current recovery retains receipts and locks all resume authority",
      "untouched old encrypted backup supports36 rollback with authority locked",
    ],
    limits: [
      "Does not prove encrypted delivery or private UI; separate real-key consent/recovery tests cover new private grants.",
    ],
  };
  await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(
    join(root, "test-results/private-resume-upgrade.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const s of stores) {
    try {
      s.close();
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
}
