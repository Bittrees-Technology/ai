/** Compare an actual compiled task21 engine with current task23 using disposable data. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error(
    "Provide the actual PR137 compiled directory after building current source.",
  );
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault");
const oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(join(repo, "dist"), "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "news-journal-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" };
let old, current, restored, rollback;
try {
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 21);
  old.addProfile(owner, {
    id: "synthetic",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 512,
    temperature: 0,
  });
  const task = old.create(
    owner,
    {
      conversationId: randomUUID(),
      kind: "query",
      prompt: "Retain task and exact result",
      modelProfileId: "synthetic",
    },
    randomUUID(),
  );
  const claim = old.claim(owner, "synthetic-worker");
  old.complete(owner, task.id, "synthetic-worker", claim.generation, {
    text: "Retained result",
  });
  const before = old.export(owner),
    profiles = old.profiles(owner);
  await oldBackup.encryptedBackup(old, vault, join(dir, "original.aib"));
  old.close();
  old = undefined;
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 21);
  assert.deepEqual(old.export(owner), before);
  old.close();
  old = undefined;
  current = new Current(path, vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 23);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(current.profiles(owner), profiles);
  assert.deepEqual(current.newsPublications.list(owner), []);
  const item = {
    id: "a".repeat(64),
    source_id: "synthetic",
    url: "https://example.org/story",
    title: "Synthetic review",
    topic: "science",
    kind: "article",
    published_at: "2026-09-23T00:00:00.000Z",
    excerpt: "Exact source excerpt",
    summary_kind: "excerpt",
  };
  const intent = {
    operationId: randomUUID(),
    identity: { accountId: randomUUID(), credentialId: randomUUID() },
    review: {
      contractVersion: "news-reviewed-publication-v1",
      revision: 1,
      publicationVersion: 0,
      reviewDigest: "b".repeat(64),
      url: "https://news.bittrees.org/synthetic",
      content: {
        name: "Synthetic",
        slug: "synthetic",
        description: "",
        navigation: [],
        snapshot: { front: [item], feeds: [] },
      },
      eligibility: { eligible: true, blockedItemIds: [] },
      previousPublication: {
        published: false,
        lastPublishedAt: null,
        snapshotDigest: null,
      },
      observedAt: "2026-09-23T00:00:00.000Z",
    },
    confirmed: true,
    audience: "public",
  };
  const pending = current.newsPublications.reserve(owner, intent);
  await backup.encryptedBackup(current, vault, join(dir, "pending.aib"));
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, vault), /Unsupported database version/);
  current = new Current(path, vault);
  assert.deepEqual(
    current.newsPublications.read(owner, intent.operationId),
    pending,
  );
  await backup.restoreBackup(
    join(dir, "pending.aib"),
    vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), vault);
  assert.deepEqual(restored.export(owner), before);
  assert.deepEqual(
    restored.newsPublications.read(owner, intent.operationId),
    pending,
  );
  restored.close();
  restored = undefined;
  assert.throws(
    () => new Old(join(dir, "restored.db"), vault),
    /Unsupported database version/,
  );
  await oldBackup.restoreBackup(
    join(dir, "original.aib"),
    vault,
    join(dir, "rollback.db"),
  );
  rollback = new Old(join(dir, "rollback.db"), vault);
  assert.deepEqual(rollback.export(owner), before);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 21);
  const sha = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const evidence = {
    verifiedAt: new Date().toISOString(),
    runtime: process.version,
    fromTaskSchema: 21,
    toTaskSchema: 23,
    legacySourceCommit: "855a034dee926315d4e318adbc3f3a49d83e1f7f",
    legacyCompiledStoreSha256: await sha(
      join(legacy, "modules/storage/store.js"),
    ),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "modules/storage/store.ts",
          "modules/storage/news-publications.ts",
          "modules/connectors/news.ts",
          "modules/connectors/news-publication-contracts.ts",
        ].map(async (f) => [f, await sha(join(repo, f))]),
      ),
    ),
    checks: [
      "Actual PR137 task21 task/result/model-profile preservation under task23 upgrade.",
      "Wrong-key upgrade rolls back without changing the task21 database.",
      "Pending encrypted exact News intent survives reopen and encrypted backup/restore.",
      "Actual task21 engine rejects upgraded and restored task23 databases.",
      "Original backup opens separately with actual old task21 helpers; later pending publication is absent from historical rollback.",
    ],
    limits: [
      "Synthetic module/database checks only; no personal app/key/data or source publication.",
      "No installed-app update, native UI acceptance, new archive, model changes or Acer operations.",
      "Restoring or deleting history does not cancel source work, recreate consent or dispatch anything. Historical rollback can lose newer tracking; preserve/export it before rolling back.",
    ],
  };
  await writeFile(
    process.argv[3] ||
      join(
        repo,
        "docs/evidence/news-publication-task23-compatibility-2026-09-23.json",
      ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "Actual PR137 task21→23 preservation, wrong-key rollback, encrypted pending intent restore, old-engine refusal and separate original-backup rollback passed.",
  );
} finally {
  old?.close();
  current?.close();
  restored?.close();
  rollback?.close();
  await rm(dir, { recursive: true, force: true });
}
