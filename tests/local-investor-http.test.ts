import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalInvestorReview } from "../modules/workflows/local-investor-review.js";
test("local draft outbox and actions require authentication, origin and strict inputs", async () => {
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault),
    token = randomBytes(32).toString("hex");
  let calls = 0;
  const adapter = new LocalInvestorReview(":memory:", vault, {
    runtime: {
      pin: async () => {
        calls++;
        throw Error("not expected");
      },
      generate: async () => {
        throw Error("not expected");
      },
    },
    turn: async (_s, fn) => fn(),
    authorize: () => true,
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
      localInvestorReview: adapter,
    }),
  );
  const base = `http://127.0.0.1:${port}/v1/research/local-investor-drafts`,
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
    for (const [path, body] of [
      ["", { evidence: { command: "run" } }],
      ["/cancel", { operationId: "x", force: true }],
    ] as const) {
      assert(
        (
          await fetch(base + path, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
        ).status >= 400,
      );
    }
    assert.equal(calls, 0);
  } finally {
    await adapter.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
