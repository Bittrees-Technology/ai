import { StorageCandidateSkip } from "../modules/workflows/recurring-storage-source.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  readdir,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { StorageMaintenance } from "../modules/workflows/recurring-storage-maintenance.js";
import type { StorageCleanupSource } from "../modules/workflows/recurring-storage-source.js";
const signal = () => new AbortController().signal;
test("complete typed plan executes once, saves reports and preserves restart receipts", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-task-"));
  const vault = new Vault(randomBytes(32));
  let calls = 0,
    at = Date.UTC(2026, 9, 18, 12);
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [{ path: "/fixture", checkout: null }],
      availableBytes: 10e9,
      measuredAt: at,
      scannedDirectories: 1,
    }),
    inspect: async () => ({ path: "/fixture" }),
    execute: async () => {
      calls++;
      return { state: "confirmed", result: { afterAvailableBytes: 11e9 } };
    },
  } as unknown as StorageCleanupSource;
  const options = {
    authorized: () => true,
    authority: () => "fixture-authority",
    reportsDirectory: dir + "/reports",
    now: () => at,
  };
  let task = new StorageMaintenance(dir + "/state.db", vault, source, options);
  try {
    const plan = await task.collect(signal(), "collect");
    assert.equal(task.decide(plan).decision, "act");
    const receipt = await task.execute(signal(), "action");
    assert.equal((receipt.evidence as any).actualFreeBytesChange, 1e9);
    task.close();
    task = new StorageMaintenance(dir + "/state.db", vault, source, options);
    assert.deepEqual(await task.execute(signal(), "action"), receipt);
    assert.equal(calls, 1);
    assert.equal(task.status().pending, null);
    assert.equal((await readdir(dir + "/reports")).length, 1);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});
test("partial inventory is held and never admits deletion", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-incomplete-"));
  let calls = 0;
  const source = {
    inventory: async () => ({
      complete: false,
      candidates: [{ path: "/fixture", checkout: null }],
      availableBytes: 10e9,
      measuredAt: Date.now(),
      scannedDirectories: 4001,
    }),
    inspect: async () => {
      calls++;
    },
    execute: async () => {
      calls++;
    },
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    ":memory:",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => "fixture-authority",
      reportsDirectory: dir + "/reports",
    },
  );
  try {
    assert.equal((await task.collect(signal(), "collect")).state, "held");
    await assert.rejects(task.execute(signal(), "action"), /complete/);
    assert.equal(calls, 0);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});
test("uncertain cleanup stays pending and cannot be replayed under a new ID", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-held-"));
  let calls = 0;
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [{ path: "/fixture", checkout: null }],
      availableBytes: 10e9,
      measuredAt: Date.now(),
      scannedDirectories: 1,
    }),
    inspect: async () => ({ path: "/fixture" }),
    execute: async () => {
      calls++;
      throw Error("lost response");
    },
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    ":memory:",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => "fixture-authority",
      reportsDirectory: dir + "/reports",
    },
  );
  try {
    await task.collect(signal(), "collect");
    await assert.rejects(task.execute(signal(), "action"));
    await assert.rejects(
      task.collect(signal(), "new-collect"),
      /reconciliation/,
    );
    await assert.rejects(
      task.execute(signal(), "new-action"),
      /reconciliation/,
    );
    assert.equal(calls, 1);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});
test("daily reports retain 30 days and unchanged shortages do not repeat notifications", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-reports-"));
  let at = Date.UTC(2026, 8, 1, 12);
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [],
      availableBytes: 10e9,
      measuredAt: at,
      scannedDirectories: 1,
    }),
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    ":memory:",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => "fixture-authority",
      reportsDirectory: dir + "/reports",
      now: () => at,
    },
  );
  try {
    for (let i = 0; i < 35; i++) {
      const receipt = await task.collect(signal(), "collect-" + i);
      assert.equal((receipt.evidence as any).notify, i === 0);
      at += 86400000;
    }
    assert.equal((await readdir(dir + "/reports")).length, 30);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});

test("reapproval with a different authority version cannot reuse the old plan", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-authority-"));
  let authority = "epoch-one",
    calls = 0;
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [{ path: "/fixture", checkout: null }],
      availableBytes: 10e9,
      measuredAt: Date.now(),
      scannedDirectories: 1,
    }),
    inspect: async () => ({ path: "/fixture" }),
    execute: async () => {
      calls++;
    },
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    ":memory:",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => authority,
      reportsDirectory: dir + "/reports",
    },
  );
  try {
    await task.collect(signal(), "old-plan");
    authority = "epoch-two";
    await assert.rejects(
      task.execute(signal(), "new-action"),
      /Fresh complete/,
    );
    assert.equal(calls, 0);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});
test("legacy measurement bootstraps growth without overwriting original report", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-legacy-"));
  await mkdir(dir + "/reports");
  const legacy = JSON.stringify({
    date: "2026-10-18",
    before_free_bytes: 22e9,
    after_free_bytes: 22e9,
    removed: [],
    status: "healthy",
  });
  const path = dir + "/reports/daily-safe-storage-2026-10-18.json";
  await writeFile(path, legacy);
  const at = Date.UTC(2026, 9, 18, 15);
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [],
      availableBytes: 15e9,
      measuredAt: at,
      scannedDirectories: 1,
    }),
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    ":memory:",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => "one",
      reportsDirectory: dir + "/reports",
      now: () => at,
    },
  );
  try {
    await task.collect(signal(), "read");
    assert.equal(task.status().report?.growthSincePriorCheck, 7e9);
    assert.equal(await readFile(path, "utf8"), legacy);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});

test("revoke/reapprove during filesystem revalidation fences the in-flight mutation", async () => {
  const { StorageCleanupJournal } =
    await import("../modules/workflows/recurring-storage-cleanup.js");
  const { homedir } = await import("node:os");
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-epoch-"));
  const vault = new Vault(randomBytes(32));
  let authority = "epoch-one",
    mutations = 0;
  let task!: StorageMaintenance;
  const now = Date.now();
  const proof = {
    path: homedir() + "/.npm/_cacache",
    measuredAt: now,
    availableBytes: 10e9,
    snapshotHash: "a".repeat(64),
    oldestChangeAgeMs: 7200000,
    noSymlinksOrSpecialFiles: true as const,
    noOpenFiles: true as const,
    noBuildOrPackageProcesses: true as const,
    stableSnapshot: true as const,
    fileCount: 1,
  };
  const journal = new StorageCleanupJournal(":memory:", vault, {
    authorized: () => task.operationAuthorized(),
    now: () => now,
    revalidate: async (p) => {
      authority = "epoch-two";
      return p;
    },
    removeVerifiedCache: async () => {
      mutations++;
      throw Error("must not run");
    },
  });
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [{ path: proof.path, checkout: null }],
      availableBytes: 10e9,
      measuredAt: now,
      scannedDirectories: 1,
    }),
    inspect: async () => proof,
    execute: (id: string, p: typeof proof, s: AbortSignal) =>
      journal.execute(id, p, s),
  } as unknown as StorageCleanupSource;
  task = new StorageMaintenance(":memory:", vault, source, {
    authorized: () => true,
    authority: () => authority,
    reportsDirectory: dir + "/reports",
    now: () => now,
  });
  try {
    await task.collect(signal(), "plan");
    await assert.rejects(task.execute(signal(), "action"), /approval changed/);
    assert.equal(mutations, 0);
    assert.ok(task.status().pending);
    authority = "epoch-one";
    await assert.rejects(
      task.execute(signal(), "different-action"),
      /reconciliation/,
    );
  } finally {
    task.close();
    journal.close();
    await rm(dir, { recursive: true });
  }
});

test("unavailable OS safety inspection holds completed inventory and prevents cleanup", async () => {
  const dir = await realpath(await mkdtemp(tmpdir() + "/storage-os-held-"));
  let mutations = 0;
  const source = {
    inventory: async () => ({
      complete: true,
      candidates: [{ path: "/fixture", checkout: null }],
      availableBytes: 10e9,
      measuredAt: Date.now(),
      scannedDirectories: 1,
    }),
    inspect: async () => {
      throw Object.assign(Error("OS inspection unavailable"), {
        code: "EPERM",
      });
    },
    execute: async () => {
      mutations++;
      throw Error("must not execute");
    },
  } as unknown as StorageCleanupSource;
  const task = new StorageMaintenance(
    dir + "/state.db",
    new Vault(randomBytes(32)),
    source,
    {
      authorized: () => true,
      authority: () => "reviewed",
      reportsDirectory: dir + "/reports",
    },
  );
  try {
    const result = await task.collect(signal(), "native-inspect");
    assert.equal(result.state, "held");
    assert.equal(task.status().report?.inventoryComplete, true);
    assert.equal(task.status().report?.safetyAvailable, false);
    assert.deepEqual(task.status().report?.safetyUnavailable, ["/fixture"]);
    assert.deepEqual(task.status().report?.skipped, []);
    assert.equal(task.decide(result).decision, "escalate");
    await assert.rejects(task.execute(signal(), "cleanup"));
    assert.equal(mutations, 0);
  } finally {
    task.close();
    await rm(dir, { recursive: true });
  }
});

for (const mode of ["empty", "healthy", "busy"] as const)
  test(`safety availability requires actual inspection: ${mode}`, async () => {
    const dir = await realpath(await mkdtemp(tmpdir() + "/storage-safety-"));
    const source = {
      inventory: async () => ({
        complete: true,
        candidates:
          mode === "empty" ? [] : [{ path: "/fixture", checkout: null }],
        availableBytes: mode === "healthy" ? 30e9 : 10e9,
        measuredAt: Date.now(),
        scannedDirectories: 1,
      }),
      inspect: async () => {
        throw new StorageCandidateSkip("Active build");
      },
      execute: async () => {
        throw Error("must not execute");
      },
    } as unknown as StorageCleanupSource;
    const task = new StorageMaintenance(
      ":memory:",
      new Vault(randomBytes(32)),
      source,
      {
        authorized: () => true,
        authority: () => "reviewed",
        reportsDirectory: dir + "/reports",
      },
    );
    try {
      const receipt = await task.collect(signal(), "inspection");
      assert.equal(task.status().report?.safetyAvailable, mode === "busy");
      assert.equal(receipt.state, mode === "busy" ? "confirmed" : "held");
      assert.deepEqual(
        task.status().report?.skipped,
        mode === "busy" ? ["/fixture"] : [],
      );
      if (mode === "busy") await task.execute(signal(), "mutation");
      else await assert.rejects(task.execute(signal(), "mutation"));
    } finally {
      task.close();
      await rm(dir, { recursive: true });
    }
  });

for (const healthy of [true, false])
  for (const available of [true, false])
    test(`empty inventory capability probe healthy=${healthy} available=${available}`, async () => {
      const dir = await realpath(
        await mkdtemp(tmpdir() + "/storage-capability-"),
      );
      let probes = 0;
      const source = {
        inventory: async () => ({
          complete: true,
          candidates: [],
          availableBytes: healthy ? 30e9 : 10e9,
          measuredAt: Date.now(),
          scannedDirectories: 1,
        }),
        probe: async () => {
          probes++;
          if (!available) throw Error("EPERM");
        },
        inspect: async () => {
          throw Error("unexpected inspection");
        },
        execute: async () => {
          throw Error("unexpected mutation");
        },
      } as unknown as StorageCleanupSource;
      const task = new StorageMaintenance(
        ":memory:",
        new Vault(randomBytes(32)),
        source,
        {
          authorized: () => true,
          authority: () => "reviewed",
          reportsDirectory: dir + "/reports",
        },
      );
      try {
        const receipt = await task.collect(signal(), "capability");
        assert.equal(probes, 1);
        assert.equal(receipt.state, available ? "confirmed" : "held");
        assert.equal(task.status().report?.safetyAvailable, available);
        if (healthy && available)
          assert.equal(task.decide(receipt).decision, "wait");
      } finally {
        task.close();
        await rm(dir, { recursive: true });
      }
    });
