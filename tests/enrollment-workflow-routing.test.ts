import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { localWorkflows } from "../apps/companion/workflows.js";
import { Vault } from "../modules/storage/vault.js";
import { nativeEnrollmentClient } from "../modules/task-sync/enrollment-client.js";
test("native enrollment routes heartbeat and attestation without credentials or remote fallback", async () => {
  const directory = mkdtempSync(tmpdir() + "/enrollment-workflow-");
  let denied = false;
  const calls: unknown[] = [];
  const workflows = localWorkflows(
    directory,
    new Vault(randomBytes(32)),
    () => ["local"],
    () => [],
    {
      execute: async (raw) => {
        calls.push(raw);
        if (denied) throw Error("Owner has not approved");
        return { grant: { id: "fixture" } };
      },
    },
  );
  try {
    const result = await workflows.status();
    assert.equal(result.connected, true);
    assert.deepEqual(calls, [{ operation: "heartbeat" }]);
    await workflows.attestRuntime("enroll", { fixture: true }, "signature");
    assert.deepEqual(calls[1], {
      operation: "attest",
      request: { fixture: true },
      signature: "signature",
    });
    denied = true;
    await assert.rejects(workflows.status(), /not approved/);
    assert.equal(calls.length, 3);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("core environment accepts only complete execution capability, never consent capability", () => {
  assert.equal(
    nativeEnrollmentClient({
      BITTREES_ENROLLMENT_CONTROL_URL:
        "http://127.0.0.1:1234/enrollment-control",
      BITTREES_ENROLLMENT_CONTROL_TOKEN: "a".repeat(64),
    }),
    undefined,
  );
  assert.throws(() =>
    nativeEnrollmentClient({
      BITTREES_ENROLLMENT_HELPER_URL: "http://127.0.0.1:1234/enrollment",
    }),
  );
  assert.throws(() =>
    nativeEnrollmentClient({
      BITTREES_ENROLLMENT_HELPER_URL: "https://ai.bittrees.org",
      BITTREES_ENROLLMENT_HELPER_TOKEN: "a".repeat(64),
    }),
  );
  assert.ok(
    nativeEnrollmentClient({
      BITTREES_ENROLLMENT_HELPER_URL: "http://127.0.0.1:1234/enrollment",
      BITTREES_ENROLLMENT_HELPER_TOKEN: "a".repeat(64),
    }),
  );
});
