/** Actual compiled task28 -> current schema31: retained conversation offers, synthetic only. */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error("Supply verified compiled task28 engine directory");
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
const legacyHash = createHash("sha256")
  .update(await readFile(join(legacy, "modules/storage/store.js")))
  .digest("hex");
assert.equal(
  legacyHash,
  "cd2ddd984a3372776fc07fe12a595ffd80900f33740e06412439973d4c717342",
);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(join(repo, "dist"), "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "bittrees-conversation-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" };
let old, current, restored, rollback;
try {
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 28);
  old.createInbox(owner, {
    id: "personal",
    tenantId: "personal",
    ownerId: "synthetic",
    ownerType: "user",
    memberUserIds: ["synthetic"],
  });
  const input = {
    conversationId: "thread",
    kind: "query",
    prompt: "Preserved original",
    modelProfileId: "model",
  };
  const task = old.create(owner, input, "original"),
    claim = old.claim(owner, "old-worker");
  old.waitForInput(
    owner,
    task.id,
    "old-worker",
    claim.generation,
    {
      inboxId: "personal",
      question: "Preserved question?",
      replyDueAt: new Date(Date.now() + 60000).toISOString(),
    },
    "original-question",
  );
  old.db
    .prepare("INSERT INTO private_conversation_consents VALUES(?,?,?,?,?)")
    .run(
      owner.userId,
      owner.tenantId,
      4,
      0,
      vault.seal(
        [],
        JSON.stringify([
          "private-conversation-consent:v1",
          owner.tenantId,
          owner.userId,
        ]),
      ),
    );
  const priorConsent = old.exportPrivateConversationConsent(owner);
  const before = old.export(owner),
    waits = old.exportInputWaits(owner);
  await oldBackup.encryptedBackup(old, vault, join(dir, "original.aib"));
  old.close();
  old = undefined;
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 28);
  old.close();
  old = undefined;
  current = new Current(path, vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 33);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(
    current.exportPrivateConversationConsent(owner),
    priorConsent,
  );
  assert.deepEqual(current.exportPrivateConversationOffers(owner), []);
  assert.deepEqual(current.exportInputWaits(owner), waits);
  assert.equal(current.get(owner, task.id).input.allowQuestions, undefined);
  const opted = current.create(
    owner,
    { ...input, conversationId: "opted", allowQuestions: true },
    "opted",
  );
  const next = current.claim(owner, "new-worker");
  assert.equal(next.task.id, opted.id);
  current.waitForOwnerInput(
    owner,
    opted.id,
    "new-worker",
    next.generation,
    "New opted-in question?",
  );
  const all = current.export(owner),
    allWaits = current.exportInputWaits(owner);
  await backup.encryptedBackup(current, vault, join(dir, "current.aib"));
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, vault), /Unsupported database version/);
  await backup.restoreBackup(
    join(dir, "current.aib"),
    vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), vault);
  assert.deepEqual(restored.export(owner), all);
  assert.deepEqual(restored.exportInputWaits(owner), allWaits);
  assert.equal(
    restored.exportPrivateConversationConsent(owner).needsReview,
    true,
  );
  assert.deepEqual(restored.exportPrivateConversationOffers(owner), []);
  assert.equal(restored.get(owner, opted.id).input.allowQuestions, true);
  await oldBackup.restoreBackup(
    join(dir, "original.aib"),
    vault,
    join(dir, "rollback.db"),
  );
  rollback = new Old(join(dir, "rollback.db"), vault);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 28);
  assert.deepEqual(rollback.export(owner), before);
  assert.deepEqual(rollback.exportInputWaits(owner), waits);
  const proof = {
    verifiedAt: new Date().toISOString(),
    from: 28,
    to: 33,
    legacyStoreSha256: legacyHash,
    checks: [
      "existing waiting task/question and omitted policy preserved",
      "existing conversation consent preserved; new offer table starts empty",
      "wrong-key upgrade leaves original usable",
      "task28 writer refuses current schema31",
      "encrypted backup/restore preserves old/new waits and explicit opt-in",
      "untouched original backup remains task28-compatible",
    ],
    boundaries: [
      "synthetic temporary stores only",
      "no inference, personal data, installed app, services or Acer changes",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/conversation-offer-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const s of [old, current, restored, rollback]) s?.close();
  await rm(dir, { recursive: true, force: true });
}
