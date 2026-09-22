import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
const helper = process.argv[2];
assert.ok(helper?.startsWith("/"));
const profile = "recovery-test-" + randomUUID();
const entry = new AsyncEntry("org.bittrees.ai.storage", profile);
assert.equal((await entry.getSecret()) == null, true);
const original = randomBytes(32),
  attempted = randomBytes(32);
let created = false;
try {
  created = true; // Unique entry was absent; clean up even after an uncertain write.
  await entry.setSecret(original);
  const child = spawnSync(helper, ["--profile", profile], {
    input: attempted,
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(child.status, 2, "helper must report existing credential");
  assert.equal(child.stdout.length, 0);
  assert.equal(child.stderr.length, 0);
  assert.deepEqual(Buffer.from(await entry.getSecret()), original);
  assert.equal(await entry.deleteCredential(), true);
  created = false;
  console.log(
    "Native helper and keyring addon target the same disposable entry; existing key preserved and removed",
  );
} finally {
  if (created) await entry.deleteCredential();
  original.fill(0);
  attempted.fill(0);
}
