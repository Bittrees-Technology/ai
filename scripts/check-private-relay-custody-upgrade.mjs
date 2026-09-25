/** Actual compiled task23 -> current task26; disposable data, no Keychain or network. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2])
  throw Error(
    "Provide the verified compiled task23 engine directory after building current source.",
  );
const repo = fileURLToPath(new URL("../", import.meta.url)),
  legacy = resolve(process.argv[2]);
const legacyHash = createHash("sha256")
  .update(await readFile(join(legacy, "modules/storage/store.js")))
  .digest("hex");
assert.equal(
  legacyHash,
  "57abe5e2b90b7dacca190921127994615b4a5c0e910e7e44274954c3f8af5113",
  "Use the verified task23 compiled store",
);
const load = (base, path) =>
  import(pathToFileURL(join(base, path + ".js")).href);
const { Store: Old } = await load(legacy, "modules/storage/store"),
  { Store: Current } = await load(join(repo, "dist"), "modules/storage/store"),
  { Vault } = await load(join(repo, "dist"), "modules/storage/vault"),
  oldBackup = await load(legacy, "modules/storage/backup"),
  currentBackup = await load(join(repo, "dist"), "modules/storage/backup");
const dir = await mkdtemp(join(tmpdir(), "relay-custody-upgrade-")),
  path = join(dir, "tasks.db"),
  vault = new Vault(randomBytes(32)),
  owner = { userId: "synthetic", tenantId: "personal" };
let old, current, restored, rollback;
try {
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 23);
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
      prompt: "Preserve synthetic task history",
      modelProfileId: "synthetic",
    },
    randomUUID(),
  );
  const claim = old.claim(owner, "worker");
  old.complete(owner, task.id, "worker", claim.generation, {
    text: "Preserve exact response",
  });
  const before = old.export(owner),
    profiles = old.profiles(owner);
  await oldBackup.encryptedBackup(old, vault, join(dir, "original.aib"));
  old.close();
  old = undefined;
  assert.throws(() => new Current(path, new Vault(randomBytes(32))));
  old = new Old(path, vault);
  assert.equal(old.db.pragma("user_version", { simple: true }), 23);
  assert.deepEqual(old.export(owner), before);
  assert.equal(
    old.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='private_relay_credentials'",
      )
      .get().n,
    0,
  );
  old.close();
  old = undefined;
  current = new Current(path, vault);
  assert.equal(current.db.pragma("user_version", { simple: true }), 37);
  assert.deepEqual(current.export(owner), before);
  assert.deepEqual(current.profiles(owner), profiles);
  assert.deepEqual(current.exportPrivateRelayCredentials(owner), {
    version: 1,
    restoreAuthority: false,
    items: [],
  });
  await currentBackup.encryptedBackup(
    current,
    vault,
    join(dir, "upgraded.aib"),
  );
  current.close();
  current = undefined;
  assert.throws(() => new Old(path, vault), /Unsupported database version/);
  await currentBackup.restoreBackup(
    join(dir, "upgraded.aib"),
    vault,
    join(dir, "restored.db"),
  );
  restored = new Current(join(dir, "restored.db"), vault);
  assert.deepEqual(restored.export(owner), before);
  await oldBackup.restoreBackup(
    join(dir, "original.aib"),
    vault,
    join(dir, "rollback.db"),
  );
  rollback = new Old(join(dir, "rollback.db"), vault);
  assert.equal(rollback.db.pragma("user_version", { simple: true }), 23);
  assert.deepEqual(rollback.export(owner), before);
  const result = {
    verifiedAt: new Date().toISOString(),
    legacyStoreSha256: legacyHash,
    from: 23,
    to: 37,
    checks: [
      "actual task23 history/result/profile preserved",
      "wrong-key migration rolls back without new table",
      "empty custody journal grants no authority",
      "old writer rejects current schema26",
      "upgraded backup restores history",
      "original backup remains usable by old writer",
    ],
    boundaries: [
      "disposable synthetic database only",
      "no OS credential access, app installation, runtime or Acer change",
    ],
  };
  await writeFile(
    join(
      repo,
      "docs/evidence/private-relay-custody-schema-compatibility-2026-09-24.json",
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  for (const s of [old, current, restored, rollback]) s?.close();
  await rm(dir, { recursive: true, force: true });
}
