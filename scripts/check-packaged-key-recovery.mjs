import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const resources = process.argv[2];
assert.ok(resources?.startsWith("/"));
const load = (name) =>
  import(pathToFileURL(join(resources, "engine/dist", name)).href);
const { AsyncEntry } = createRequire(join(resources, "engine/package.json"))(
  "@napi-rs/keyring",
);
const { Store } = await load("modules/storage/store.js");
const { MemoryStore } = await load("modules/memory/store.js");
const { Vault } = await load("modules/storage/vault.js");
const { createContentBackup } = await load("modules/storage/content-backup.js");
const { prepareRecoverySetup } = await load("apps/companion/recovery-setup.js");
const { recoverKitRequest } = await load("apps/companion/kit-recovery.js");
const { macAddOnlyEntry } = await load("apps/companion/key-install.js");
const { resolveActiveContent } = await load("apps/companion/active-content.js");
const { localMemoryAccess } = await load("apps/companion/memory.js");
const { retainedContent } = await load("apps/companion/retained-content.js");
const { withCompanionStopped } = await load("apps/companion/recovery.js");
const temp = await mkdtemp(join(tmpdir(), "bittrees-packaged-kit-"));
const profile = "recovery-test-" + randomUUID();
const credential = new AsyncEntry("org.bittrees.ai.storage", profile);
const key = randomBytes(32),
  vault = new Vault(key);
const owner = { userId: "synthetic-kit", tenantId: "personal" };
const input = {
  conversationId: "synthetic",
  kind: "query",
  prompt: "synthetic packaged kit task",
  modelProfileId: "synthetic",
};
let created = false;
const opened = [];
try {
  assert.equal((await credential.getSecret()) == null, true);
  created = true; // Clean up the unique test profile even after an uncertain set acknowledgement.
  await credential.setSecret(key);
  const prepared = await prepareRecoverySetup(
    { operation: "prepare-recovery-kit-v1", confirmed: true },
    credential,
  );
  const kitFile = join(temp, "recovery.btkey");
  await writeFile(kitFile, Buffer.from(prepared.kitBase64, "base64"), {
    mode: 0o600,
    flag: "wx",
  });
  const source = join(temp, "source");
  await mkdir(source);
  const tasks = new Store(join(source, "tasks.db"), vault);
  opened.push(tasks);
  const memory = new MemoryStore(
    join(source, "memory.db"),
    vault,
    localMemoryAccess(tasks),
  );
  opened.push(memory);
  const task = tasks.create(owner, input, "seed"),
    claim = tasks.claim(owner, "seed");
  const done = tasks.complete(owner, task.id, "seed", claim.generation, {
    text: "synthetic recovered local source",
  });
  const item = await memory.add(owner, {
    type: "preference",
    text: "synthetic packaged memory",
    origin: "user",
    sources: [
      {
        app: "local",
        tenantId: owner.tenantId,
        resourceId: task.id,
        revision: String(done.revision),
      },
    ],
  });
  await memory.review(owner, item.id, 1, { approve: true });
  tasks.db
    .prepare("INSERT INTO remote_control_bindings VALUES(?,?,?,?)")
    .run(
      owner.userId,
      owner.tenantId,
      "synthetic-device",
      Buffer.from("old-consent"),
    );
  const backup = join(temp, "content.aib");
  await createContentBackup(tasks, memory, vault, backup);
  const request = {
    operation: "recover-with-kit-v1",
    confirmed: true,
    backup,
    kit: kitFile,
    code: prepared.recoveryCode,
  };
  const entry = macAddOnlyEntry(join(resources, "KeyInstall"), profile);
  const target = join(temp, "native-matching-key");
  const result = await recoverKitRequest(request, target, entry, 0);
  assert.deepEqual(result, {
    version: 1,
    activated: true,
    keyStatus: "already-present",
  });
  assert.equal(await entry.addSecretIfAbsent(randomBytes(32)), false);
  assert.deepEqual(Buffer.from(await credential.getSecret()), key);
  const first = await resolveActiveContent(target);
  const restored = new Store(join(first.directory, "tasks.db"), vault);
  opened.push(restored);
  const restoredMemory = new MemoryStore(
    join(first.directory, "memory.db"),
    vault,
    localMemoryAccess(restored),
  );
  opened.push(restoredMemory);
  assert.equal(
    restored.get(owner, task.id).result.text,
    "synthetic recovered local source",
  );
  assert.equal(
    (await restoredMemory.get(owner, item.id)).text,
    "synthetic packaged memory",
  );
  assert.deepEqual(
    restored.db.prepare("SELECT * FROM remote_control_bindings").all(),
    [],
  );
  assert.equal(
    tasks.db.prepare("SELECT * FROM remote_control_bindings").all().length,
    1,
  );
  restored.deleteAll(owner);
  await assert.rejects(restoredMemory.get(owner, item.id), /NOT_FOUND/);
  restoredMemory.close();
  opened.splice(opened.indexOf(restoredMemory), 1);
  restored.close();
  opened.splice(opened.indexOf(restored), 1);
  // Keep older copies, protect current/previous, delete only a reviewed synthetic old copy.
  await recoverKitRequest(request, target, entry, 0);
  await recoverKitRequest(request, target, entry, 0);
  const active = await resolveActiveContent(target);
  await withCompanionStopped(async () => {
    const copies = retainedContent(target, active.directory),
      page = await copies.list();
    assert.equal(page.items.length, 3);
    for (const protectedCopy of page.items.filter((v) => v.protectedAs))
      await assert.rejects(
        copies.remove(protectedCopy.id, protectedCopy.review),
        /CONFLICT/,
      );
    const old = page.items.find((v) => v.id === first.name);
    assert.equal(old.protectedAs, null);
    assert.deepEqual(await copies.remove(old.id, old.review), {
      deleted: true,
    });
    assert.equal((await copies.list()).items.length, 2);
  }, 0);
  const pointer = await readFile(join(target, "active-content.json"));
  await assert.rejects(
    recoverKitRequest(
      { ...request, code: "btr1_" + randomBytes(32).toString("base64url") },
      target,
      entry,
      0,
    ),
    /RECOVERY_KIT_REJECTED/,
  );
  assert.deepEqual(
    await readFile(join(target, "active-content.json")),
    pointer,
  );
  assert.deepEqual(Buffer.from(await credential.getSecret()), key);
  // Fresh lost-key behavior is checked with a simulated entry, without granting a new helper-created personal ACL.
  let saved;
  const simulated = {
    getSecret: async () => saved,
    addSecretIfAbsent: async (value) => {
      if (saved) return false;
      saved = Uint8Array.from(value);
      return true;
    },
  };
  const fresh = await recoverKitRequest(
    request,
    join(temp, "fresh-simulated-key"),
    simulated,
    0,
  );
  assert.deepEqual(fresh, {
    version: 1,
    activated: true,
    keyStatus: "created",
  });
  assert.deepEqual(Buffer.from(saved), key);
  saved.fill(0);
  assert.equal(await credential.deleteCredential(), true);
  created = false;
  assert.equal((await credential.getSecret()) == null, true);
  console.log(
    JSON.stringify({
      status: "passed",
      node: process.version,
      architecture: process.arch,
      sourceCommit: JSON.parse(
        await readFile(join(resources, "build-info.json"), "utf8"),
      ).sourceCommit,
      checks: [
        "bundled native addon setup with disposable profile",
        "bundled helper matching-key verification and conflicting-add preservation",
        "actual synthetic task and source-bound memory recovery",
        "cleared remote consent without source mutation",
        "source deletion hides restored memory",
        "retained-copy current/previous protection and reviewed old-copy deletion",
        "wrong code leaves selection and synthetic credential unchanged",
        "fresh-device recovery with simulated missing entry",
        "disposable credential removed and absence verified",
      ],
      personalDataUsed: false,
      personalKeychainAccessed: false,
      disposableKeychainUsed: true,
      nativeInteractionAccepted: false,
      limitations: [
        "fresh helper-created key and cross-binary access prompts remain unaccepted",
        "private worker personal-profile entry point not invoked",
        "no native UI or installed-app upgrade",
      ],
    }),
  );
} finally {
  for (const store of opened.reverse()) store.close();
  if (created) await credential.deleteCredential();
  key.fill(0);
  await rm(temp, { recursive: true, force: true });
}
