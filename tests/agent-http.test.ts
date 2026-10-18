import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { AgentQueue } from "../modules/agents/queue.js";
import { AgentProfiles } from "../modules/agents/profiles.js";
import { AgentCoordinator } from "../modules/agents/coordinator.js";
test("agent configuration and queue stay behind existing local authentication and origin protection", async () => {
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault),
    token = randomBytes(32).toString("hex");
  const queue = new AgentQueue(":memory:", vault),
    profiles = new AgentProfiles(":memory:", vault);
  const agents = new AgentCoordinator(
    ":memory:",
    vault,
    queue,
    profiles,
    {
      pin: async () => {
        throw Error("not expected");
      },
      generate: async () => {
        throw Error("not expected");
      },
    },
    () => null,
    () => true,
  );
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
      agents,
    }),
  );
  const base = `http://127.0.0.1:${port}/v1/agents`;
  const headers = {
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
    assert.equal(
      (await (await fetch(base, { headers })).json()).queue.concurrency,
      1,
    );
    assert.equal(
      (
        await fetch(base + "/profiles", {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "arbitrary" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/queue", {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "pause" }),
        })
      ).status,
      200,
    );
    assert.equal(queue.status().paused, true);
  } finally {
    await queue.close();
    await agents.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
