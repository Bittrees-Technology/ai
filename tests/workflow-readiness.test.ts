import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localWorkflows } from "../apps/companion/workflows.js";
import { localApi } from "../apps/companion/http.js";
import { Vault } from "../modules/storage/vault.js";
import { Store } from "../modules/storage/store.js";
import {
  readWorkflowPermissions,
  ownerReviewReady,
} from "../apps/dashboard/workflow-readiness.js";

test("readiness is authenticated local metadata with no helper, model, credential or source access", async () => {
  const dir = await mkdtemp(tmpdir() + "/workflow-readiness-");
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  let helperCalls = 0;
  const workflows = localWorkflows(
    dir,
    vault,
    () => {
      throw Error("Unexpected model lookup");
    },
    () => [],
    {
      execute: async () => {
        helperCalls++;
        throw Error("Unexpected helper call");
      },
    },
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    token = "a".repeat(64);
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "a", tenantId: "t" },
      workflows,
    }),
  );
  try {
    const url = `http://127.0.0.1:${port}/v1/workflows/readiness`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      version: 1,
      nativeTransportAvailable: true,
      sourceStatusVerified: false,
    });
    assert.equal(helperCalls, 0);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(
      localWorkflows(dir, vault, () => []).readiness().nativeTransportAvailable,
      false,
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("missing or malformed readiness cannot fall through to hosted permissions", async () => {
  const calls: string[] = [];
  const result = await readWorkflowPermissions(async (path) => {
    calls.push(path);
    return {
      version: 1,
      nativeTransportAvailable: false,
      sourceStatusVerified: false,
    };
  });
  assert.deepEqual(calls, ["/v1/workflows/readiness"]);
  assert.equal(result.data, null);
  await assert.rejects(
    readWorkflowPermissions(async (path) => {
      assert.equal(path, "/v1/workflows/readiness");
      return {
        version: 1,
        nativeTransportAvailable: "true",
        sourceStatusVerified: false,
      };
    }),
  );
  await assert.rejects(
    readWorkflowPermissions(async () => {
      throw Error("Local route unavailable");
    }),
  );
});
test("native capability presence is not consent or a verified grant", async () => {
  const ready = {
    version: 1 as const,
    nativeTransportAvailable: true,
    sourceStatusVerified: false as const,
  };
  const calls: string[] = [];
  const held = await readWorkflowPermissions(async (path) => {
    calls.push(path);
    if (path.endsWith("readiness")) return ready;
    throw Error("Consent or source denied");
  });
  assert.deepEqual(calls, ["/v1/workflows/readiness", "/v1/workflows"]);
  assert.equal(held.sourceUnavailable, true);
  assert.equal(ownerReviewReady(held.readiness, held.data), false);
  const data = {
    grant: { signed_at: "fixture", wallet_address: "0x" + "a".repeat(40) },
  };
  assert.equal(ownerReviewReady(ready, data), true);
  assert.equal(
    ownerReviewReady(ready, {
      grant: { ...data.grant, approval_expires_at: "2000-01-01T00:00:00Z" },
    }),
    false,
  );
  assert.equal(
    ownerReviewReady(ready, {
      grant: { ...data.grant, approval_expires_at: "invalid" },
    }),
    false,
  );
  assert.equal(
    ownerReviewReady({ ...ready, nativeTransportAvailable: false }, data),
    false,
  );
  assert.equal(
    ownerReviewReady(ready, {
      grant: { ...data.grant, revoked_at: "fixture" },
    }),
    false,
  );
  assert.equal(
    ownerReviewReady(ready, { grant: { ...data.grant, paused_at: "fixture" } }),
    false,
  );
  assert.equal(
    ownerReviewReady(ready, { grant: { ...data.grant, signed_at: null } }),
    false,
  );
});
