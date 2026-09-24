/** Actual compiled task25 -> task27; synthetic data only, no service or Keychain. */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error("Supply verified compiled task25 engine directory");
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
const legacyHash = createHash("sha256")
  .update(await readFile(join(legacy, "modules/storage/store.js")))
  .digest("hex");
assert.equal(
  legacyHash,
  "e9d5fd4f892d33531c20d62df1398459f8992c7e56b4d425e2c8c4f0156301c6",
);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(join(repo, "dist"), "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "bittrees-input-wait-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" };
let old, current, restored, rollback;
try {
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 25);
  old.createInbox(owner, {
    id: "personal",
    tenantId: owner.tenantId,
    ownerId: owner.userId,
    ownerType: "user",
    memberUserIds: [owner.userId],
  });
  const task = old.create(
      owner,
      {
        conversationId: "thread",
        kind: "query",
        prompt: "Synthetic preserved original",
        modelProfileId: "model",
      },
      "original",
    ),
    before = old.export(owner);
  await oldBackup.encryptedBackup(old, vault, join(dir, "original.aib"));
  old.close();
  old = undefined;
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 25);
  assert.equal(
    old.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='task_input_waits'",
      )
      .get().n,
    0,
  );
  old.close();
  old = undefined;
  current = new Current(path, vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 35);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(current.exportInputWaits(owner), []);
  const claim = current.claim(owner, "worker"),
    question = current.waitForInput(
      owner,
      task.id,
      "worker",
      claim.generation,
      {
        inboxId: "personal",
        question: "Synthetic question",
        replyDueAt: new Date(Date.now() + 60000).toISOString(),
      },
      "question",
    );
  await backup.encryptedBackup(current, vault, join(dir, "waiting.aib"));
  const history = current.exportInputWaits(owner);
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, vault), /Unsupported database version/);
  await backup.restoreBackup(
    join(dir, "waiting.aib"),
    vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), vault);
  assert.deepEqual(restored.exportInputWaits(owner), history);
  assert.equal(restored.get(owner, task.id).status, "awaiting_input");
  const answer = restored.answerInput(
    owner,
    task.id,
    {
      questionId: question.question.id,
      expectedRevision: question.task.revision,
      content: "Synthetic restored answer",
    },
    "answer",
  );
  assert.equal(answer.task.status, "queued");
  await oldBackup.restoreBackup(
    join(dir, "original.aib"),
    vault,
    join(dir, "rollback.db"),
  );
  rollback = new Old(join(dir, "rollback.db"), vault);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 25);
  assert.deepEqual(rollback.export(owner), before);
  const proof = {
    verifiedAt: new Date().toISOString(),
    legacyStoreSha256: legacyHash,
    from: 25,
    to: 35,
    checks: [
      "actual old-writer history preserved; empty wait table grants nothing",
      "wrong-key migration rolls back",
      "old writer rejects upgraded database",
      "encrypted backup preserves unanswered question and exact restored answer association",
      "untouched original backup remains usable with old writer",
    ],
    boundaries: [
      "synthetic temporary data only",
      "no inference, credentials, app installation, live or Acer change",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/task-input-wait-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const store of [old, current, restored, rollback]) store?.close();
  await rm(dir, { recursive: true, force: true });
}
