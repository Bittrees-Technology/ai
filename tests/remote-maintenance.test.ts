import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cleanupRemote } from "../modules/remote/maintenance.js";
import type { Pool } from "pg";
test("Remote cleanup refuses invalid limits before connecting and CLI requires explicit apply/configuration", async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections++;
      throw Error("must not connect");
    },
  } as unknown as Pool;
  for (const cutoff of [0, -1, NaN, Infinity, 1.5])
    await assert.rejects(cleanupRemote(pool, 1, cutoff), /INVALID_INPUT/);
  assert.equal(connections, 0);
  const sentinel =
    "postgresql://PRIVATE_CLEANUP_SECRET@invalid.invalid/database";
  for (const args of [
    [],
    ["--apply", "--batch-size", "1", "--history-retention-days", "30"],
    ["--apply", "--batch-size", "1", "--history-retention-days", "0"],
    ["--batch-size", "1"],
    ["--apply", "--batch-size", "0"],
    ["--apply", "--batch-size", "1001"],
    ["--apply", "--batch-size", "1", "unexpected"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/remote-cleanup.ts", ...args],
      {
        env: { ...process.env, REMOTE_DATABASE_URL: sentinel },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /No cleanup was started/);
    assert.equal(
      (result.stdout + result.stderr).includes("PRIVATE_CLEANUP_SECRET"),
      false,
    );
  }
  const env = { ...process.env };
  delete env.REMOTE_DATABASE_URL;
  const missing = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/remote-cleanup.ts",
      "--apply",
      "--batch-size",
      "1",
    ],
    { env, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No cleanup was started/);
});
