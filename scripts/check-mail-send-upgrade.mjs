/** Actual prepared PR139 task22 -> current task23; disposable data, no Keychain or network. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error(
    "Provide the verified PR139 compiled engine directory after building current source.",
  );
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
assert.equal(
  createHash("sha256")
    .update(await readFile(join(legacy, "modules/storage/store.js")))
    .digest("hex"),
  "48bc0ac7f309973a30fc33d2f6ecd10748dfa2526cb1581a8c675448021565ee",
  "Use the verified PR139 compiled store",
);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault");
const oldBackup = await load(legacy, "modules/storage/backup"),
  backup = await load(join(repo, "dist"), "modules/storage/backup"),
  { mailSendDigest } = await load(
    join(repo, "dist"),
    "modules/connectors/mail-send-contracts",
  );
const dir = await mkdtemp(join(tmpdir(), "mail-send-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" };
let old, current, restored, rollback;
try {
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 22);
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
        prompt: "Retain exact task",
        modelProfileId: "synthetic",
      },
      randomUUID(),
    ),
    claim = old.claim(owner, "worker");
  old.complete(owner, task.id, "worker", claim.generation, {
    text: "Retain exact result",
  });
  const news = old.newsPublications.reserve(owner, {
    operationId: randomUUID(),
    identity: { accountId: randomUUID(), credentialId: randomUUID() },
    confirmed: true,
    audience: "public",
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
        snapshot: {
          front: [
            {
              id: "a".repeat(64),
              source_id: "synthetic",
              url: "https://example.org/story",
              title: "Synthetic review",
              topic: "science",
              kind: "article",
              published_at: "2026-09-23T00:00:00.000Z",
              excerpt: "Exact source excerpt",
              summary_kind: "excerpt",
            },
          ],
          feeds: [],
        },
      },
      eligibility: { eligible: true, blockedItemIds: [] },
      previousPublication: {
        published: false,
        lastPublishedAt: null,
        snapshotDigest: null,
      },
      observedAt: "2026-09-23T00:00:00.000Z",
    },
  });
  const before = old.export(owner),
    profiles = old.profiles(owner),
    newsBefore = old.newsPublications.list(owner);
  assert.equal(newsBefore.length, 1);
  await oldBackup.encryptedBackup(old, vault, join(dir, "original.aib"));
  old.close();
  old = undefined;
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 22);
  assert.deepEqual(old.export(owner), before);
  old.close();
  old = undefined;
  current = new Current(path, vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 23);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(current.profiles(owner), profiles);
  assert.deepEqual(current.newsPublications.list(owner), newsBefore);
  assert.deepEqual(current.mailSends.list(owner), []);
  const identity = {
      wallet: "0x" + "1".repeat(40),
      mailbox: "fixture@bittrees.org",
    },
    envelope = {
      contractVersion: "mail-ai-send-v1",
      operationId: randomUUID(),
      from: identity.mailbox,
      to: ["recipient@example.org"],
      cc: [],
      bcc: ["hidden@example.org"],
      subject: "Exact reviewed subject",
      text: "Exact body\n",
      attachments: [
        {
          filename: "fixture.bin",
          contentType: "application/octet-stream",
          content: Buffer.from([0, 1, 255]).toString("base64"),
        },
      ],
      reply: null,
    };
  current.mailSends.create(owner, { identity, envelope });
  current.mailSends.reserve(owner, envelope.operationId, {
    digest: mailSendDigest(envelope),
    grantId: "c".repeat(64),
    confirmed: true,
  });
  current.mailSends.create(owner, {
    identity,
    envelope: { ...envelope, operationId: randomUUID() },
  });
  const records = current.mailSends.list(owner);
  await backup.encryptedBackup(current, vault, join(dir, "current.aib"));
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, vault), /Unsupported database version/);
  current = new Current(path, vault);
  assert.deepEqual(current.mailSends.list(owner), records);
  await backup.restoreBackup(
    join(dir, "current.aib"),
    vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), vault);
  assert.deepEqual(restored.export(owner), before);
  assert.deepEqual(restored.newsPublications.list(owner), newsBefore);
  assert.deepEqual(
    restored.mailSends.list(owner),
    records.map((r) => ({ ...r, reconciliationOnly: true })),
  );
  for (const r of restored.mailSends.list(owner))
    assert.throws(() =>
      restored.mailSends.reserve(owner, r.envelope.operationId, {
        digest: mailSendDigest(r.envelope),
        grantId: "d".repeat(64),
        confirmed: true,
      }),
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
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 22);
  assert.deepEqual(rollback.export(owner), before);
  assert.deepEqual(rollback.newsPublications.list(owner), newsBefore);
  const sha = async (p) =>
    createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
  const evidence = {
    verifiedAt: new Date().toISOString(),
    runtime: process.version,
    fromTaskSchema: 22,
    toTaskSchema: 23,
    legacySourceCommit: "94c61849444c1081f133d83022810e37e5fb78fa",
    legacyCompiledStoreSha256: await sha(
      join(legacy, "modules/storage/store.js"),
    ),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "modules/storage/store.ts",
          "modules/storage/mail-sends.ts",
          "modules/storage/backup.ts",
          "modules/connectors/mail-send-contracts.ts",
          "modules/connectors/mail-send.ts",
        ].map(async (f) => [f, await sha(join(repo, f))]),
      ),
    ),
    checks: [
      "Actual PR139 task22 task/result/model-profile and pending News intent preserved under task23 upgrade.",
      "Wrong-key upgrade leaves task22 readable by the actual old engine.",
      "Prepared and reserved encrypted exact Mail records survive reopen.",
      "Encrypted restore marks ALL Mail records reconciliation-only, including prepared records backed up before a possible later send.",
      "Actual old task22 engine rejects upgraded and restored task23 databases.",
      "Separate original backup opens with actual old helpers and preserves original News intent; later Mail history is absent.",
    ],
    limits: [
      "Synthetic data only; no personal key/data, installed app, source deployment, real email or Acer operations.",
      "Historical rollback lacks newer messages and send tracking. Export/preserve newer records before rollback; never interpret missing old history as permission to resend.",
      "No native or personal acceptance, model change or new app archive.",
    ],
  };
  await writeFile(
    process.argv[3] ||
      join(
        repo,
        "docs/evidence/mail-send-task23-compatibility-2026-09-23.json",
      ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "Actual task22→23 preservation, restore reconciliation lock, wrong-key isolation, old-engine refusal and separate original backup rollback passed.",
  );
} finally {
  old?.close();
  current?.close();
  restored?.close();
  rollback?.close();
  await rm(dir, { recursive: true, force: true });
}
