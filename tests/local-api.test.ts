import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalApi } from "../apps/dashboard/local-api.js";

test("local transport preserves pairing/error contracts, empty success and exact request intent without retries", async () => {
  const calls: any[] = [];
  let response = new Response(null, { status: 204 });
  const api = createLocalApi((async (path, options) => {
    calls.push({ path, options });
    return response;
  }) as typeof fetch);
  assert.equal(
    await api(
      "/v1/messages",
      "POST",
      { content: "draft" },
      { "Idempotency-Key": "fixed" },
    ),
    null,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "fixed");
  assert.equal(calls[0].options.body, JSON.stringify({ content: "draft" }));
  response = Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  await assert.rejects(api("/v1/health"), /^Error: UNAUTHORIZED$/);
  response = Response.json({ error: "CONFLICT" }, { status: 409 });
  await assert.rejects(api("/v1/export"), /^Error: CONFLICT$/);
  response = new Response("<html>proxy error</html>", { status: 502 });
  await assert.rejects(api("/v1/export"), /LOCAL_INVALID_RESPONSE/);
  response = Response.json(
    { error: { private: "not an error code" } },
    { status: 400 },
  );
  await assert.rejects(api("/v1/export"), /LOCAL_INVALID_RESPONSE/);
  assert.equal(calls.length, 5);
});

test("connection loss is explicit and a write is never automatically retried", async () => {
  let calls = 0;
  const api = createLocalApi((async () => {
    calls++;
    throw new TypeError("private network details");
  }) as typeof fetch);
  await assert.rejects(
    api("/v1/requests", "POST", { prompt: "synthetic" }),
    /^Error: LOCAL_UNAVAILABLE$/,
  );
  assert.equal(calls, 1);
});

for (const phase of ["headers", "body"] as const) {
  test(`local timeout covers stalled ${phase} and allows a fresh request after recovery`, async () => {
    let stalled = true,
      calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      if (!stalled) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (phase === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.flushHeaders();
        res.write('{"status":');
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = createLocalApi(fetch, 1000);
    try {
      await assert.rejects(
        api(url, "POST", { prompt: "synthetic" }),
        /^Error: LOCAL_TIMEOUT$/,
      );
      assert.equal(calls, 1);
      stalled = false;
      assert.deepEqual(await api(url), { status: "ok" });
      assert.equal(calls, 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
