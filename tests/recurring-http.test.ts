import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { RecurringWorkflows } from "../modules/workflows/recurring.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
test("recurring routes require local authentication and reject invented control fields", async () => {
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault),
    token = randomBytes(32).toString("hex");
  let calls = 0;
  const recurring = new RecurringWorkflows(":memory:", vault, {
    authorize: async () => {
      calls++;
      throw Error("Unavailable adapter");
    },
    execute: async () => {
      throw Error("Unavailable");
    },
    decide: async () => {
      throw Error("Unavailable");
    },
    sourcePaused: async () => false,
    admission: () => false,
  });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "local", tenantId: "local" },
      recurring,
    }),
  );
  const base = `http://127.0.0.1:${port}/v1/workflows/recurring`,
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal(
      (
        await fetch(base, {
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.deepEqual(await (await fetch(base, { headers })).json(), []);
    const invalid = await fetch(base + "/control", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "enable",
        id: "not-imported",
        revision: "a".repeat(64),
        bypassAuthority: true,
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    await recurring.tick();
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await recurring.close();
    store.close();
  }
});
