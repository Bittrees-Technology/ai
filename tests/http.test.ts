import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
test("local HTTP rejects unauthenticated access, hostile origins and source selectors", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    token = randomBytes(32).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({ store, token, port, owner: { userId: "a", tenantId: "t" } }),
  );
  const url = `http://127.0.0.1:${port}`,
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "k",
    };
  try {
    const denied = await fetch(url + "/v1/requests", {
      headers: { "X-Correlation-ID": "caller-controlled" },
    });
    assert.equal(denied.status, 401);
    const diagnostic = denied.headers.get("x-correlation-id");
    assert.match(diagnostic!, /^[a-f0-9-]{36}$/);
    assert.equal(
      ((await denied.json()) as { correlationId: string }).correlationId,
      diagnostic,
    );
    assert.equal(
      (
        await fetch(url + "/v1/requests", {
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const body = {
      conversationId: "c",
      kind: "query",
      prompt: "PRIVATE",
      modelProfileId: "m",
    };
    let r = await fetch(url + "/v1/requests", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        sourceRefs: [
          { app: "crm", tenantId: "t", resourceId: "secret", revision: "1" },
        ],
      }),
    });
    assert.equal(r.status, 403);
    r = await fetch(url + "/v1/requests", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 202);
    const task = (await r.json()) as { id: string; revision: number };
    r = await fetch(url + `/v1/requests/${task.id}/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "cancel",
        expectedRevision: task.revision,
      }),
    });
    assert.equal(r.status, 200);
    r = await fetch(url + "/v1/requests", {
      method: "POST",
      headers,
      body: '{"PRIVATE"',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.text()).includes("PRIVATE"), false);
    assert.equal(
      (await fetch(url + "/v1/data", { method: "DELETE", headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/v1/data", {
          method: "DELETE",
          headers: { ...headers, "X-Confirm-Delete": "all-local-task-data" },
        })
      ).status,
      204,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
  }
});

test("project progress polling stays local and requires authentication", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  const token = randomBytes(32).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let remoteReads = 0;
  const jobs = [{ id: "run", state: "running", completed: 2 }];
  const projectWork = {
    status: () => jobs,
    projects: async () => {
      remoteReads++;
      return { projects: [] };
    },
  } as any;
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "a", tenantId: "t" },
      projectWork,
    }),
  );
  const url = `http://127.0.0.1:${port}/v1/crm-projects`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(url + "/status")).status, 401);
    for (let i = 0; i < 60; i++) {
      const response = await fetch(url + "/status", { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { available: true, jobs });
    }
    assert.equal(remoteReads, 0);
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal(remoteReads, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
