import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStorageKey } from "../modules/storage/keychain.js";
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
