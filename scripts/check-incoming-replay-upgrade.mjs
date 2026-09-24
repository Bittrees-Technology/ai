/** Actual compiled task29 -> task30, including genuine retained task/check history. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error("Supply verified compiled task29 engine directory");
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
const hash = createHash("sha256")
  .update(await readFile(join(legacy, "modules/storage/store.js")))
  .digest("hex");
assert.equal(
  hash,
  "587c3a4d12f206285a9d71b1d43e1c7d41d5438502cdad1772388879c4e40f73",
);
const load = (base, name) =>
  import(pathToFileURL(join(base, name + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault"),
  { PrivateTaskReceiver } = await load(
    join(repo, "dist"),
    "modules/remote/private-task-receiver",
  ),
  { privateEndpoints } = await load(legacy, "tests/helpers/private-endpoints"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(join(repo, "dist"), "modules/storage/backup"),
  { privateReplayIdentity } = await load(
    join(repo, "dist"),
    "modules/remote/private-replay",
  ),
  { consumePrivateIncomingReplay } = await load(
    join(repo, "dist"),
    "modules/remote/private-incoming-replay",
  );
const dir = await mkdtemp(join(tmpdir(), "bittrees-incoming-upgrade-")),
  path = join(dir, "tasks.db"),
  f = await privateEndpoints();
let current, restored, rollback, prior;
try {
  const task = await f.submit();
  await f.b.controls.receiveTask(task.envelope);
  const before = f.b.store.export(f.b.owner),
    receipts = f.b.store.exportPrivateTaskReceipts(f.b.owner),
    checks = f.b.store.exportPrivatePeerChecks(f.b.owner),
    consent = f.b.store.exportPrivateTaskConsent(f.b.owner);
  assert.equal(f.b.store.db.pragma("user_version", { simple: true }), 29);
  assert.equal(receipts.length, 1);
  assert.equal(checks.length, 2);
  await f.b.store.backup(path);
  await oldBackup.encryptedBackup(
    f.b.store,
    f.b.vault,
    join(dir, "original.aib"),
  );
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  prior = new Old(path, f.b.vault);
  assert.equal(prior.db.pragma("user_version", { simple: true }), 29);
  prior.close();
  prior = undefined;
  current = new Current(path, f.b.vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 30);
  assert.deepEqual(current.export(f.b.owner), before);
  assert.deepEqual(current.exportPrivateTaskReceipts(f.b.owner), receipts);
  assert.deepEqual(current.exportPrivatePeerChecks(f.b.owner), checks);
  assert.deepEqual(current.exportPrivateTaskConsent(f.b.owner), consent);
  assert.deepEqual(current.exportPrivateIncomingReplay(f.b.owner), []);
  // Reauthenticate an actual legacy retry through the new receiver; preserve
  // its old outcome while adding shared evidence without creating another task.
  const identity = await privateReplayIdentity(task.envelope, "task.submit"),
    outcome = { collection: "private_task_receipts", id: receipts[0].id };
  await f.b.remote.withVerifiedDevice(async (scope) => {
    const providers = await f.b
      .consent(scope.current)
      .resolve(f.a.grant.deviceId);
    const receiver = new PrivateTaskReceiver(
      current,
      f.b.vault,
      f.b.owner,
      scope.current,
      providers.receive,
      f.clock,
    );
    assert.deepEqual(await receiver.accept(task.envelope), receipts[0]);
    assert.deepEqual(await receiver.accept(task.envelope), receipts[0]);
  });
  const replay = current.exportPrivateIncomingReplay(f.b.owner);
  assert.deepEqual(replay, [{ identity, outcome }]);
  assert.deepEqual(current.export(f.b.owner), before);
  await backup.encryptedBackup(current, f.b.vault, join(dir, "current.aib"));
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, f.b.vault), /Unsupported database version/);
  await backup.restoreBackup(
    join(dir, "current.aib"),
    f.b.vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), f.b.vault);
  assert.deepEqual(restored.export(f.b.owner), before);
  assert.deepEqual(restored.exportPrivateIncomingReplay(f.b.owner), replay);
  assert.throws(
    () =>
      restored.db
        .transaction(() =>
          consumePrivateIncomingReplay(
            restored,
            f.b.vault,
            f.b.owner,
            { ...identity, envelope: "0".repeat(64) },
            outcome,
          ),
        )
        .immediate(),
    /CONFLICT/,
  );
  assert.equal(restored.exportPrivateTaskConsent(f.b.owner).needsReview, true);
  assert.ok(restored.exportPrivatePeerChecks(f.b.owner).every((v) => v.locked));
  await oldBackup.restoreBackup(
    join(dir, "original.aib"),
    f.b.vault,
    join(dir, "rollback.db"),
  );
  rollback = new Old(join(dir, "rollback.db"), f.b.vault);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 29);
  assert.deepEqual(rollback.export(f.b.owner), before);
  assert.deepEqual(rollback.exportPrivateTaskReceipts(f.b.owner), receipts);
  const proof = {
    verifiedAt: new Date().toISOString(),
    from: 29,
    to: 30,
    legacyStoreSha256: hash,
    checks: [
      "actual legacy task, receipt, device checks and task consent preserved",
      "new shared ledger starts empty without retroactive historical coverage claims",
      "actual legacy ciphertext retry adds one shared replay record and preserves its original receipt without duplicating work",
      "wrong-key upgrade leaves schema29 usable",
      "schema29 writer refuses schema30",
      "encrypted backup retains replay denial and locks restored authority",
      "original encrypted backup restores with actual schema29 engine",
    ],
    boundaries: [
      "Synthetic temporary stores and memory-backed keys only",
      "Mac task admission integrated; peer checks, Mac receipt receiver and browser shared ledger remain unfinished",
      "Historical peer-check incoming IDs were not retained; reconciliation or a fresh-key epoch boundary is required before conversation activation",
      "No installed app, personal keys/content, model/runtime, live service or Acer changes",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/incoming-replay-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const s of [current, restored, rollback, prior]) s?.close();
  f.close();
  await rm(dir, { recursive: true, force: true });
}
