import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { MyCloudSource } from "../modules/workflows/recurring-mycloud-source.js";
const reading = (temp: number) =>
  JSON.stringify({
    checked_at: new Date().toISOString(),
    issues: [],
    readings: {
      var: { used_percent: 40 },
      data: { used_percent: 50 },
      smart_passed: true,
      temperature_c: temp,
      reallocated_sectors: 0,
      pending_sectors: 0,
      uncorrectable_sectors: 0,
      smb_active: true,
      logrotate_result: "success",
    },
  });
test("source denies unapproved network without executing checker", async () => {
  let calls = 0;
  const s = new MyCloudSource(":memory:", new Vault(randomBytes(32)), {
    authorized: () => false,
    check: async () => {
      calls++;
      return reading(64);
    },
  });
  try {
    await assert.rejects(
      s.read(new AbortController().signal),
      /approval pending/,
    );
    assert.equal(calls, 0);
  } finally {
    s.close();
  }
});
test("baseline64 is quiet; threshold and recovery events persist once per change", async () => {
  let temp = 64;
  const s = new MyCloudSource(":memory:", new Vault(randomBytes(32)), {
    authorized: () => true,
    check: async () => reading(temp),
  });
  try {
    await s.read(new AbortController().signal);
    assert.equal(s.outbox().length, 0);
    temp = 65;
    await s.read(new AbortController().signal);
    await s.read(new AbortController().signal);
    assert.equal(s.outbox().length, 1);
    temp = 64;
    await s.read(new AbortController().signal);
    assert.equal(s.outbox().length, 2);
    temp = 65;
    await s.read(new AbortController().signal);
    assert.equal(s.outbox().length, 3);
  } finally {
    s.close();
  }
});
test("revocation during collection retains no baseline or event", async () => {
  let allowed = true;
  const s = new MyCloudSource(":memory:", new Vault(randomBytes(32)), {
    authorized: () => allowed,
    check: async () => {
      allowed = false;
      return reading(70);
    },
  });
  try {
    await assert.rejects(
      s.read(new AbortController().signal),
      /approval changed/,
    );
    assert.equal(s.outbox().length, 0);
  } finally {
    s.close();
  }
});
test("outbox capacity fails closed without silently deleting unique events", async () => {
  let temp = 64;
  const s = new MyCloudSource(":memory:", new Vault(randomBytes(32)), {
    authorized: () => true,
    check: async () => reading(temp),
  });
  try {
    await s.read(new AbortController().signal);
    for (let i = 0; i < 1000; i++) {
      temp = temp === 64 ? 65 : 64;
      await s.read(new AbortController().signal);
    }
    temp = 65;
    await assert.rejects(s.read(new AbortController().signal), /outbox full/);
    assert.equal(s.outbox().length, 100);
  } finally {
    s.close();
  }
});
test("pin validation rejects changed files and symlinked source ancestors", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { verifyMyCloudPins } =
    await import("../modules/workflows/recurring-mycloud-source.js");
  const base = await realpath(await mkdtemp(join(tmpdir(), "mycloud-pins-")));
  try {
    const source = join(base, "real");
    await mkdir(source);
    await writeFile(join(source, "check.py"), "safe", { mode: 0o600 });
    const pins = {
      "check.py": createHash("sha256").update("safe").digest("hex"),
    };
    await verifyMyCloudPins(source, pins);
    await symlink(source, join(base, "alias"));
    await assert.rejects(
      verifyMyCloudPins(join(base, "alias"), pins),
      /directory identity/,
    );
    await writeFile(join(source, "check.py"), "changed");
    await assert.rejects(verifyMyCloudPins(source, pins), /changed/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
