import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ChatOperationJournal } from "../modules/workflows/recurring-chat-source.js";
import { prepareChatJournalPath } from "../modules/workflows/chat-journal-path.js";
function fixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "chat-path-safety-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function snapshot(path: string) {
  const s = lstatSync(path);
  return {
    bytes: readFileSync(path).toString("hex"),
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    ino: s.ino,
    dev: s.dev,
    nlink: s.nlink,
    mtime: s.mtimeMs,
    ctime: s.ctimeMs,
  };
}
function rejectsUnchanged(path: string, targets: string[]) {
  const before = targets.map(snapshot);
  assert.throws(() => new ChatOperationJournal(path));
  assert.deepEqual(targets.map(snapshot), before);
}
for (const mode of [0o640, 0o600])
  test(`hardlink mode ${mode.toString(8)} rejected without changing original or alias`, () =>
    fixture((dir) => {
      const original = join(dir, "original.db"),
        alias = join(dir, "alias.db");
      writeFileSync(original, "", { mode });
      linkSync(original, alias);
      rejectsUnchanged(alias, [original, alias]);
      assert.equal(existsSync(alias + "-wal"), false);
    }));
test("leaf symlink never changes target", () =>
  fixture((dir) => {
    const target = join(dir, "original"),
      alias = join(dir, "alias");
    writeFileSync(target, "preserve", { mode: 0o640 });
    symlinkSync(target, alias);
    rejectsUnchanged(alias, [target]);
  }));
test("symlink parent cannot create a journal in its target", () =>
  fixture((dir) => {
    const target = join(dir, "private"),
      alias = join(dir, "alias");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias);
    assert.throws(() => new ChatOperationJournal(join(alias, "new.db")));
    assert.equal(existsSync(join(target, "new.db")), false);
  }));
test("writable direct parent is not repaired or used", () =>
  fixture((dir) => {
    chmodSync(dir, 0o770);
    const before = lstatSync(dir);
    assert.throws(() => new ChatOperationJournal(join(dir, "new.db")));
    assert.equal(lstatSync(dir).mode, before.mode);
    assert.equal(existsSync(join(dir, "new.db")), false);
  }));
test("writable ancestor above private parent is denied", () =>
  fixture((dir) => {
    const parent = join(dir, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(dir, 0o777);
    assert.throws(() => new ChatOperationJournal(join(parent, "new.db")));
    assert.equal(existsSync(join(parent, "new.db")), false);
  }));
test("relative and noncanonical layouts are denied", () =>
  fixture((dir) => {
    assert.throws(() => new ChatOperationJournal("relative.db"));
    assert.throws(
      () =>
        new ChatOperationJournal(
          dir + "/../" + dir.split("/").at(-1) + "/new.db",
        ),
    );
    assert.equal(existsSync(join(dir, "new.db")), false);
  }));
test("unowned direct parent denied before creation", () => {
  if (process.geteuid?.() === 0) return;
  const parent = realpathSync("/tmp");
  assert.equal(lstatSync(parent).uid, 0);
  const leaf = join(parent, "chat-denied-" + process.pid + ".db");
  assert.equal(existsSync(leaf), false);
  assert.throws(() => new ChatOperationJournal(leaf));
  assert.equal(existsSync(leaf), false);
});
test("empty private foreign leaf is not initialized", () =>
  fixture((dir) => {
    const p = join(dir, "foreign.db");
    writeFileSync(p, "", { mode: 0o600 });
    rejectsUnchanged(p, [p]);
  }));
test("foreign SQLite database is never initialized or chmodded", () =>
  fixture((dir) => {
    const p = join(dir, "foreign.db"),
      db = new Database(p);
    db.exec(
      "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserve')",
    );
    db.close();
    chmodSync(p, 0o600);
    rejectsUnchanged(p, [p]);
    assert.equal(existsSync(p + "-wal"), false);
  }));
for (const kind of [
  "hardlink",
  "symlink",
  "foreign",
  "permissions",
  "rollback",
] as const)
  test(`unsafe ${kind} sidecar preserves all bytes and metadata`, () =>
    fixture((dir) => {
      const p = join(dir, "chat.db");
      new ChatOperationJournal(p).close();
      const sentinel = join(dir, "sentinel");
      writeFileSync(sentinel, "unrelated-data", { mode: 0o600 });
      const sibling = p + (kind === "rollback" ? "-journal" : "-wal");
      if (kind === "hardlink") linkSync(sentinel, sibling);
      else if (kind === "symlink") symlinkSync(sentinel, sibling);
      else
        writeFileSync(sibling, "foreign sidecar", {
          mode: kind === "permissions" ? 0o640 : 0o600,
        });
      const targets = [p, sentinel, ...(kind === "symlink" ? [] : [sibling])];
      rejectsUnchanged(p, targets);
    }));
test("replaced leaf identity is rejected by held no-follow descriptor", () =>
  fixture((dir) => {
    const p = join(dir, "chat.db"),
      saved = join(dir, "saved.db");
    new ChatOperationJournal(p).close();
    const guard = prepareChatJournalPath(p);
    try {
      renameSync(p, saved);
      writeFileSync(p, "replacement", { mode: 0o600 });
      const before = snapshot(p);
      assert.throws(() => guard.assertUnchanged());
      assert.deepEqual(snapshot(p), before);
    } finally {
      guard.close();
    }
  }));
test("valid private journal retains WAL/FULL and durable pending operation", () =>
  fixture((dir) => {
    const p = join(dir, "chat.db"),
      op = "a".repeat(64),
      rev = "b".repeat(64);
    let j = new ChatOperationJournal(p);
    j.reserve(op, rev, "chat_public", 100000);
    j.close();
    j = new ChatOperationJournal(p);
    assert.equal(j.load(op, rev, "chat_public")?.state, "pending");
    assert.throws(() => j.reserve(op, rev, "chat_public", 200000));
    j.close();
    assert.equal(lstatSync(p).mode & 0o777, 0o600);
  }));

test("foreign WAL index is rejected before SQLite mutation", () =>
  fixture((dir) => {
    const p = join(dir, "chat.db");
    new ChatOperationJournal(p).close();
    writeFileSync(p + "-shm", Buffer.alloc(32768), { mode: 0o600 });
    rejectsUnchanged(p, [p, p + "-shm"]);
  }));
test("orphan sidecar prevents new leaf creation", () =>
  fixture((dir) => {
    const p = join(dir, "new.db"),
      side = p + "-wal";
    writeFileSync(side, "preserve", { mode: 0o600 });
    const before = snapshot(side);
    assert.throws(() => new ChatOperationJournal(p));
    assert.deepEqual(snapshot(side), before);
    assert.equal(existsSync(p), false);
  }));
test("unclean process exit retains pending operation through real WAL recovery", () =>
  fixture((dir) => {
    const p = join(dir, "crashed.db"),
      op = "c".repeat(64),
      rev = "d".repeat(64);
    const code = `import {ChatOperationJournal} from ${JSON.stringify(new URL("../modules/workflows/recurring-chat-source.ts", import.meta.url).href)};const j=new ChatOperationJournal(${JSON.stringify(p)});j.reserve(${JSON.stringify(op)},${JSON.stringify(rev)},"chat_public",100000);process.exit(0);`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { timeout: 15000, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(existsSync(p + "-wal"));
    const j = new ChatOperationJournal(p);
    assert.equal(j.load(op, rev, "chat_public")?.state, "pending");
    assert.throws(() => j.reserve(op, rev, "chat_public", 200000));
    j.close();
  }));
