import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { Vault } from "../modules/storage/vault.js";
import { Store } from "../modules/storage/store.js";
import { nativeEnrollmentClient } from "../modules/task-sync/enrollment-client.js";
import { nativeCentralEnrollmentClient } from "../modules/workflows/central-enrollment-client.js";

test("central enrollment API requires local auth and sends only typed owner commands", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    token = "a".repeat(64),
    calls: unknown[] = [];
  const summary = {
    purpose: "central-workflows" as const,
    principal: "agent:" + randomUUID(),
    credentialId: "a".repeat(64),
    sourceWorkspace: randomUUID(),
    permissionsGranted: false as const,
    originalReviewExpiresAt: Date.now() + 60000,
    originalReviewExpired: false,
    state: { status: "not-started" as const },
    enrollment: null,
  };
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "a", tenantId: "t" },
      centralEnrollment: {
        execute: async (command, signal) => {
          signal.throwIfAborted();
          calls.push(command);
          return summary;
        },
      },
    }),
  );
  const url = `http://127.0.0.1:${port}/v1/workflows/central/connection`,
    auth = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(calls.length, 0);
    const status = await (await fetch(url, { headers: auth })).json();
    assert.equal(status.ready, true);
    assert.equal(status.permissionsGranted, false);
    assert.deepEqual(calls, [{ action: "status" }]);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            action: "start",
            principal: "agent:" + randomUUID(),
          }),
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ action: "start" }),
        })
      ).status,
      200,
    );
    assert.deepEqual(calls, [{ action: "status" }, { action: "start" }]);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
  }
});
test("purpose-specific native clients cannot fall back to another enrollment identity or accept control endpoints", () => {
  const env = {
    BITTREES_ENROLLMENT_PURPOSE: "central-workflows",
    BITTREES_ENROLLMENT_HELPER_URL: "http://127.0.0.1:43128/central-enrollment",
    BITTREES_ENROLLMENT_HELPER_TOKEN: "a".repeat(64),
  };
  assert.equal(nativeEnrollmentClient(env), undefined);
  assert.ok(nativeCentralEnrollmentClient(env));
  assert.equal(nativeCentralEnrollmentClient({}), undefined);
  assert.throws(() =>
    nativeCentralEnrollmentClient({
      ...env,
      BITTREES_ENROLLMENT_HELPER_URL: "http://127.0.0.1:43128/enrollment",
    }),
  );
  assert.throws(() =>
    nativeCentralEnrollmentClient({
      ...env,
      BITTREES_ENROLLMENT_HELPER_URL:
        "http://127.0.0.1:43128/enrollment-control",
    }),
  );
  assert.throws(() =>
    nativeEnrollmentClient({ ...env, BITTREES_ENROLLMENT_PURPOSE: "unknown" }),
  );
});
