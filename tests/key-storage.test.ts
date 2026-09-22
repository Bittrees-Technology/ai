import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStorageKey,
  normalizeKeychainSecret,
} from "../modules/storage/keychain.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
test("missing/locked key stores never replace a key for existing data", async () => {
  let secret: Uint8Array | undefined;
  const entry = {
    getSecret: async () => secret,
    setSecret: async (v: Uint8Array) => {
      secret = v;
    },
  };
  await assert.rejects(loadStorageKey(entry, true), /unavailable/);
  assert.equal(secret, undefined);
  const key = await loadStorageKey(entry, false);
  assert.deepEqual(await loadStorageKey(entry, true), key);
  await assert.rejects(
    loadStorageKey(
      {
        getSecret: async () => {
          throw new Error("locked");
        },
        setSecret: async () => {
          throw new Error("must not run");
        },
      },
      false,
    ),
    /locked/,
  );
});
test("encrypted backup restores with the right key and never overwrites data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-backup-test-"));
  const vault = new Vault(randomBytes(32));
  const s = new Store(join(dir, "source.db"), vault);
  let restored: Store | undefined;
  try {
    const owner = { userId: "private-user-name", tenantId: "personal" };
    s.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "PRIVATE_PAYLOAD",
        modelProfileId: "m",
      },
      "k",
    );
    const file = join(dir, "backup.aib");
    await encryptedBackup(s, vault, file);
    assert.equal(readFileSync(file).includes("private-user-name"), false);
    await assert.rejects(
      restoreBackup(file, new Vault(randomBytes(32)), join(dir, "bad.db")),
    );
    const target = join(dir, "restored.db");
    await restoreBackup(file, vault, target);
    restored = new Store(target, vault);
    assert.equal(restored.list(owner)[0]?.input.prompt, "PRIVATE_PAYLOAD");
    await assert.rejects(restoreBackup(file, vault, target), /EEXIST/);
  } finally {
    restored?.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore preparation failure leaves no published database or staging files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-restore-failure-"));
  const vault = new Vault(randomBytes(32));
  const source = new Store(join(dir, "source.db"), vault);
  try {
    // A real database that this engine cannot migrate must never be published.
    source.db.pragma("user_version = 999");
    const backup = join(dir, "backup.aib");
    await encryptedBackup(source, vault, backup);
    const before = readdirSync(dir).sort();
    const destination = join(dir, "restore.db");
    await assert.rejects(restoreBackup(backup, vault, destination));
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(dir).sort(), before);
  } finally {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore rejects existing SQLite sidecars without modifying them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-restore-sidecar-"));
  const vault = new Vault(randomBytes(32));
  const source = new Store(join(dir, "source.db"), vault);
  try {
    const backup = join(dir, "backup.aib");
    await encryptedBackup(source, vault, backup);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const destination = join(dir, `restore${suffix}.db`);
      const sidecar = destination + suffix;
      writeFileSync(sidecar, "existing database state");
      await assert.rejects(restoreBackup(backup, vault, destination), /EEXIST/);
      assert.equal(existsSync(destination), false);
      assert.equal(readFileSync(sidecar, "utf8"), "existing database state");
    }
  } finally {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native Keychain arrays and null normalize to owned typed bytes without permissive coercion", () => {
  assert.equal(normalizeKeychainSecret(null), undefined);
  assert.equal(normalizeKeychainSecret(undefined), undefined);
  for (const raw of [
    Array.from({ length: 32 }, (_, i) => i),
    Uint8Array.from({ length: 32 }, (_, i) => i),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  ]) {
    const normalized = normalizeKeychainSecret(raw)!;
    assert.ok(normalized instanceof Uint8Array);
    assert.equal(normalized.byteLength, 32);
    assert.deepEqual(Buffer.from(normalized), Buffer.from(raw));
    normalized.fill(0);
    assert.equal(raw[31], 31);
  }
  for (const invalid of [
    "secret",
    {},
    [256],
    [-1],
    [1.2],
    [NaN],
    [undefined],
    new Array(2),
    ["1"],
    new Int16Array([1]),
  ])
    assert.throws(
      () => normalizeKeychainSecret(invalid),
      /Invalid key-store response/,
    );
});
