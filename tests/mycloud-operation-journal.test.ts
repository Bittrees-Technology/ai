import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MyCloudOperationJournal } from "../modules/workflows/mycloud-operation-journal.js";
const revision = "a".repeat(64),
  now = Date.now();
test("restart retains pending/confirmed/uncertain IDs without raw source data or replay", () => {
  const root = mkdtempSync(join(tmpdir(), "mycloud-journal-")),
    path = join(root, "journal.db");
  try {
    const pending = randomUUID(),
      completed = "b".repeat(64),
      failed = "verify:" + randomUUID();
    let journal = new MyCloudOperationJournal(path);
    journal.reserve(pending, revision, now);
    journal.reserve(completed, revision, now + 60000);
    journal.confirm(completed, revision, "private-health-reading");
    journal.reserve(failed, revision, now + 120000);
    journal.uncertain(failed, revision);
    journal.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(
      !readFileSync(path).includes(Buffer.from("private-health-reading")),
    );
    journal = new MyCloudOperationJournal(path);
    try {
      for (const id of [pending, completed, failed])
        assert.throws(
          () => journal.reserve(id, revision, now + 180000),
          /already recorded/,
        );
      assert.equal(journal.get(pending)?.state, "pending");
      assert.equal(journal.get(failed)?.state, "uncertain");
      assert.ok(
        journal.matchesCached(completed, revision, "private-health-reading"),
      );
      assert.ok(
        !journal.matchesCached(completed, revision, "different reading"),
      );
      assert.ok(
        !journal.matchesCached(
          completed,
          "c".repeat(64),
          "private-health-reading",
        ),
      );
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rate limit survives restart and revision mismatch cannot accept an operation", () => {
  const root = mkdtempSync(join(tmpdir(), "mycloud-journal-")),
    path = join(root, "journal.db"),
    id = randomUUID();
  try {
    let journal = new MyCloudOperationJournal(path);
    journal.reserve(id, revision, now);
    journal.close();
    journal = new MyCloudOperationJournal(path);
    try {
      assert.throws(
        () => journal.reserve(randomUUID(), revision, now + 1000),
        /rate limit/,
      );
      assert.throws(
        () => journal.confirm(id, "b".repeat(64), "data"),
        /approval changed/,
      );
      assert.equal(journal.get(id)?.state, "pending");
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("capacity and invalid IDs fail closed without removing operation history", () => {
  const journal = new MyCloudOperationJournal(":memory:");
  try {
    assert.throws(() => journal.reserve("shell:run", revision, now));
    for (let i = 0; i < 10000; i++)
      journal.reserve(
        i.toString(16).padStart(64, "0"),
        revision,
        now + i * 60000,
      );
    assert.throws(
      () => journal.reserve(randomUUID(), revision, now + 10000 * 60000),
      /journal full/,
    );
    assert.equal(journal.count(), 10000);
  } finally {
    journal.close();
  }
});
test("journal rejects symlink targets before opening them", () => {
  const root = mkdtempSync(join(tmpdir(), "mycloud-journal-")),
    path = join(root, "link.db");
  try {
    symlinkSync(join(root, "other.db"), path);
    assert.throws(() => new MyCloudOperationJournal(path), /identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
