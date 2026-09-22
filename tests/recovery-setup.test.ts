import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareRecoverySetup } from "../apps/companion/recovery-setup.js";
import { recoverStorageKey } from "../modules/storage/recovery-kit.js";
const request = { operation: "prepare-recovery-kit-v1", confirmed: true };
test("native setup protocol requires explicit confirmation and returns a kit/code pair without changing the existing key", async () => {
  const key = randomBytes(32),
    before = Buffer.from(key);
  let reads = 0,
    writes = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return key;
    },
    setSecret: async () => {
      writes++;
    },
  };
  for (const bad of [
    {},
    { ...request, confirmed: false },
    { ...request, path: "/caller-path" },
    { ...request, operation: "export-raw-key" },
  ])
    await assert.rejects(prepareRecoverySetup(bad, entry));
  assert.equal(reads, 0);
  const result = await prepareRecoverySetup(request, entry);
  assert.equal(result.version, 1);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
  const recovered = recoverStorageKey(
    Buffer.from(result.kitBase64, "base64"),
    result.recoveryCode,
  );
  assert.deepEqual(recovered, key);
  recovered.fill(0);
  assert.deepEqual(key, before);
  assert.equal(JSON.stringify(result).includes(key.toString("base64")), false);
});
test("missing and locked setup entries fail without creating a storage key", async () => {
  for (const getSecret of [
    async () => undefined,
    async () => {
      throw Error("private provider details");
    },
  ]) {
    await assert.rejects(
      prepareRecoverySetup(request, {
        getSecret,
        setSecret: async () => {
          assert.fail("no key write");
        },
      }),
      { message: "ORIGINAL_KEY_UNAVAILABLE" },
    );
  }
});
test("private setup worker refuses invocation without its preview gate and emits no output", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/companion/recovery-setup-worker.ts"],
    {
      input: JSON.stringify(request),
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
