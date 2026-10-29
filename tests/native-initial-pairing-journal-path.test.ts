import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { openNativeInitialPairingJournal } from "../modules/task-sync/initial-pairing-native-journal.js";
import { initialPairingJournalApplicationId } from "../modules/workflows/chat-journal-path.js";

const identity = {
  principal: "agent:" + randomUUID(),
  keyFingerprint: "a".repeat(64),
};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "native-pairing-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    path: join(dir, "pairing.db"),
    vault: new Vault(randomBytes(32)),
  };
}
function snapshot(path: string) {
  const st = lstatSync(path);
  return {
    bytes: readFileSync(path).toString("hex"),
    mode: st.mode,
    ino: st.ino,
    mtime: st.mtimeMs,
    nlink: st.nlink,
  };
}
test("native pairing journal durably reopens encrypted held operation without another start", async (t) => {
  const f = fixture(t),
    journal = openNativeInitialPairingJournal(f.path, f.vault, identity);
  const state = {
    phase: "held",
    request: { ...identity, operationId: randomUUID() },
    consentId: randomUUID(),
    calls: 1,
    lastPoll: 0,
    marker: "PRIVATE_SYNTHETIC_PAIRING",
  } as any;
  assert.equal(await journal.store.load(), null);
  await journal.store.save(state);
  journal.close();
  journal.close();
  assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.path).includes(Buffer.from(state.marker)), false);
  const reopened = openNativeInitialPairingJournal(f.path, f.vault, identity);
  try {
    assert.deepEqual(await reopened.store.load(), state);
  } finally {
    reopened.close();
  }
});
test("invalid identity and noncanonical/in-memory paths create no journal", (t) => {
  const f = fixture(t);
  assert.throws(() =>
    openNativeInitialPairingJournal(f.path, f.vault, {
      ...identity,
      principal: "agent:invalid",
    }),
  );
  assert.equal(existsSync(f.path), false);
  for (const path of [":memory:", "relative.db", f.dir + "/./pairing.db"])
    assert.throws(() =>
      openNativeInitialPairingJournal(path, f.vault, identity),
    );
  assert.equal(existsSync(f.path), false);
});
for (const alias of ["symlink", "hardlink"])
  test(`${alias} journal rejected without modifying target`, (t) => {
    const f = fixture(t),
      target = join(f.dir, "preserve.db");
    writeFileSync(target, "preserve", { mode: 0o600 });
    if (alias === "symlink") symlinkSync(target, f.path);
    else linkSync(target, f.path);
    const before = snapshot(target);
    assert.throws(() =>
      openNativeInitialPairingJournal(f.path, f.vault, identity),
    );
    assert.deepEqual(snapshot(target), before);
  });
test("writable parent and symlink ancestor are not repaired or used", (t) => {
  const f = fixture(t);
  chmodSync(f.dir, 0o770);
  assert.throws(() =>
    openNativeInitialPairingJournal(f.path, f.vault, identity),
  );
  assert.equal(lstatSync(f.dir).mode & 0o777, 0o770);
  assert.equal(existsSync(f.path), false);
  chmodSync(f.dir, 0o700);
  const alias = f.dir + "-alias";
  symlinkSync(f.dir, alias);
  t.after(() => rmSync(alias));
  assert.throws(() =>
    openNativeInitialPairingJournal(
      join(alias, "pairing.db"),
      f.vault,
      identity,
    ),
  );
  assert.equal(existsSync(f.path), false);
});
for (const marked of [false, true])
  test(`foreign SQLite ${marked ? "with matching marker but wrong schema" : "without marker"} remains byte-identical`, (t) => {
    const f = fixture(t),
      db = new Database(f.path);
    db.exec(
      "CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('untouched')",
    );
    if (marked) {
      db.pragma(`application_id = ${initialPairingJournalApplicationId}`);
      db.pragma("user_version = 1");
    }
    db.close();
    chmodSync(f.path, 0o600);
    const before = snapshot(f.path);
    assert.throws(() =>
      openNativeInitialPairingJournal(f.path, f.vault, identity),
    );
    assert.deepEqual(snapshot(f.path), before);
  });
test("hostile WAL symlink is denied before SQLite can follow it", (t) => {
  const f = fixture(t),
    j = openNativeInitialPairingJournal(f.path, f.vault, identity);
  j.close();
  const target = join(f.dir, "preserve");
  writeFileSync(target, "PRIVATE_UNRELATED", { mode: 0o600 });
  symlinkSync(target, f.path + "-wal");
  const before = snapshot(target),
    original = snapshot(f.path);
  assert.throws(() =>
    openNativeInitialPairingJournal(f.path, f.vault, identity),
  );
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual(snapshot(f.path), original);
});
