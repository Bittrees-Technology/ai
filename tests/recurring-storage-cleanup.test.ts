import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import {
  StorageCleanupJournal,
  type StorageCleanupProof,
} from "../modules/workflows/recurring-storage-cleanup.js";
const proof: StorageCleanupProof = {
  path: homedir() + "/.npm/_cacache",
  measuredAt: 10000000,
  availableBytes: 10 * 1024 ** 3,
  snapshotHash: "a".repeat(64),
  oldestChangeAgeMs: 3600001,
  noSymlinksOrSpecialFiles: true,
  noOpenFiles: true,
  noBuildOrPackageProcesses: true,
  stableSnapshot: true,
};
const result = {
  removed: true as const,
  repositoryStatusUnchanged: true as const,
  afterAvailableBytes: proof.availableBytes + 1024,
  completedAt: proof.measuredAt + 100,
  sourceReceiptHash: "b".repeat(64),
};
test("scope rejection never reaches deletion, including dependency/source and traversal paths", async () => {
  let calls = 0;
  const j = new StorageCleanupJournal(":memory:", new Vault(randomBytes(32)), {
    authorized: () => true,
    now: () => proof.measuredAt,
    revalidate: async (p) => p,
    removeVerifiedCache: async () => {
      calls++;
      return result;
    },
  });
  try {
    for (const path of [
      homedir() + "/.npm",
      homedir() + "/.npm/_cacache/../secrets",
      homedir() + "/project/node_modules",
      homedir() + "/project/sources",
    ]) {
      await assert.rejects(
        j.execute(
          "1".repeat(64),
          { ...proof, path },
          new AbortController().signal,
        ),
      );
    }
    assert.equal(calls, 0);
  } finally {
    j.close();
  }
});
test("stale, changing, busy, recently changing, and healthy-volume proofs fail closed", async () => {
  let calls = 0;
  const changes = [
    { measuredAt: proof.measuredAt - 6000 },
    { snapshotHash: "c".repeat(64) },
    { noOpenFiles: false },
    { noBuildOrPackageProcesses: false },
    { noSymlinksOrSpecialFiles: false },
    { oldestChangeAgeMs: 3599999 },
    { availableBytes: 20 * 1024 ** 3 },
  ];
  for (const change of changes) {
    const j = new StorageCleanupJournal(
      ":memory:",
      new Vault(randomBytes(32)),
      {
        authorized: () => true,
        now: () => proof.measuredAt,
        revalidate: async () =>
          ({ ...proof, ...change }) as StorageCleanupProof,
        removeVerifiedCache: async () => {
          calls++;
          return result;
        },
      },
    );
    try {
      await assert.rejects(
        j.execute("1".repeat(64), proof, new AbortController().signal),
      );
    } finally {
      j.close();
    }
  }
  assert.equal(calls, 0);
});
test("confirmed operation survives restart and cannot replay or change target", async () => {
  const dir = await mkdtemp(tmpdir() + "/cleanup-journal-");
  const vault = new Vault(randomBytes(32));
  let calls = 0;
  const host = {
    authorized: () => true,
    now: () => proof.measuredAt,
    revalidate: async (p: StorageCleanupProof) => p,
    removeVerifiedCache: async () => {
      calls++;
      return result;
    },
  };
  let j = new StorageCleanupJournal(dir + "/journal.db", vault, host);
  try {
    const saved = await j.execute(
      "1".repeat(64),
      proof,
      new AbortController().signal,
    );
    assert.equal(saved.actualFreeBytesChange, 1024);
    j.close();
    j = new StorageCleanupJournal(dir + "/journal.db", vault, host);
    assert.deepEqual(
      await j.execute("1".repeat(64), proof, new AbortController().signal),
      saved,
    );
    await assert.rejects(
      j.execute(
        "1".repeat(64),
        { ...proof, path: homedir() + "/Library/Caches/Yarn" },
        new AbortController().signal,
      ),
      /conflicts/,
    );
    assert.equal(calls, 1);
  } finally {
    j.close();
    await rm(dir, { recursive: true });
  }
});
test("uncertain deletion blocks different operation IDs after restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/cleanup-uncertain-");
  const vault = new Vault(randomBytes(32));
  let calls = 0;
  const host = {
    authorized: () => true,
    now: () => proof.measuredAt,
    revalidate: async (p: StorageCleanupProof) => p,
    removeVerifiedCache: async () => {
      calls++;
      throw Error("lost receipt after mutation");
    },
  };
  let j = new StorageCleanupJournal(dir + "/journal.db", vault, host);
  try {
    await assert.rejects(
      j.execute("1".repeat(64), proof, new AbortController().signal),
      /uncertain/,
    );
    j.close();
    j = new StorageCleanupJournal(dir + "/journal.db", vault, host);
    await assert.rejects(
      j.execute("2".repeat(64), proof, new AbortController().signal),
      /reconciliation/,
    );
    assert.equal(calls, 1);
  } finally {
    j.close();
    await rm(dir, { recursive: true });
  }
});
test("approval revoked during inspection stops mutation", async () => {
  let allowed = true,
    calls = 0;
  const j = new StorageCleanupJournal(":memory:", new Vault(randomBytes(32)), {
    authorized: () => allowed,
    now: () => proof.measuredAt,
    revalidate: async (p) => {
      allowed = false;
      return p;
    },
    removeVerifiedCache: async () => {
      calls++;
      return result;
    },
  });
  try {
    await assert.rejects(
      j.execute("1".repeat(64), proof, new AbortController().signal),
      /approval changed/,
    );
    assert.equal(calls, 0);
  } finally {
    j.close();
  }
});

test("independent instances cannot both mutate the same cache concurrently", async () => {
  const dir = await mkdtemp(tmpdir() + "/cleanup-race-");
  const vault = new Vault(randomBytes(32));
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = {
    authorized: () => true,
    now: () => proof.measuredAt,
    revalidate: async (p: StorageCleanupProof) => p,
    removeVerifiedCache: async () => {
      calls++;
      entered();
      await gate;
      return result;
    },
  };
  const a = new StorageCleanupJournal(dir + "/journal.db", vault, host);
  const b = new StorageCleanupJournal(dir + "/journal.db", vault, host);
  try {
    const pending = a.execute(
      "1".repeat(64),
      proof,
      new AbortController().signal,
    );
    await started;
    await assert.rejects(
      b.execute("2".repeat(64), proof, new AbortController().signal),
      /reconciliation/,
    );
    release();
    await pending;
    assert.equal(calls, 1);
  } finally {
    release();
    a.close();
    b.close();
    await rm(dir, { recursive: true });
  }
});
