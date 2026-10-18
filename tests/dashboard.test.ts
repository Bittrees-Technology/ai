import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { dashboardServer } from "../apps/companion/dashboard-server.js";
test("browser pairing is single-use, bounded and origin-protected; locking revokes its session", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    origin = "http://127.0.0.1:" + port;
  let now = 1000;
  server.on(
    "request",
    dashboardServer({
      store,
      owner: { userId: "a", tenantId: "t" },
      token: "a".repeat(64),
      port,
      pairCode: "b".repeat(24),
      assets: "apps/dashboard",
      now: () => now,
    }),
  );
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(origin + "/v1/requests")).status, 401);
    assert.equal(
      (
        await post(
          "/pair",
          { code: "b".repeat(24) },
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal((await post("/pair", { code: "é".repeat(24) })).status, 403);
    const paired = await post("/pair", { code: "b".repeat(24) });
    assert.equal(paired.status, 204);
    const setCookie = paired.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const Cookie = setCookie.split(";")[0]!;
    assert.equal(
      (await fetch(origin + "/v1/health", { headers: { Cookie } })).status,
      200,
    );
    assert.equal((await post("/pair", { code: "b".repeat(24) })).status, 403);
    assert.equal(
      (await fetch(origin + "/logout", { method: "POST", headers: { Cookie } }))
        .status,
      403,
    );
    assert.equal((await post("/logout", {}, { Cookie })).status, 204);
    assert.equal(
      (await fetch(origin + "/v1/health", { headers: { Cookie } })).status,
      401,
    );
    now += 9 * 60 * 60_000;
    assert.equal(
      (await fetch(origin + "/v1/health", { headers: { Cookie } })).status,
      401,
    );
    const root = await fetch(origin + "/");
    assert.equal(root.status, 200);
    assert.match(
      root.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal((await root.text()).includes("b".repeat(24)), false);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
  }
});
for (const mode of ["expiry", "attempts"] as const)
  test(
    "pairing rejects " + mode + " before creating a browser session",
    async () => {
      const store = new Store(":memory:", new Vault(randomBytes(32))),
        server = createServer();
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port,
        origin = "http://127.0.0.1:" + port;
      let now = 1000;
      server.on(
        "request",
        dashboardServer({
          store,
          owner: { userId: "a", tenantId: "t" },
          token: "a".repeat(64),
          port,
          pairCode: "b".repeat(24),
          assets: "apps/dashboard",
          now: () => now,
        }),
      );
      const pair = (code: string) =>
        fetch(origin + "/pair", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
      try {
        if (mode === "expiry") now += 10 * 60_000;
        else
          for (let i = 0; i < 10; i++)
            assert.equal((await pair("wrong")).status, 403);
        const denied = await pair("b".repeat(24));
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get("set-cookie"), null);
      } finally {
        await new Promise<void>((r, j) =>
          server.close((e) => (e ? j(e) : r())),
        );
        store.close();
      }
    },
  );

test("native bootstrap is one-use and independent of browser pairing, with lock and origin protection", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    origin = "http://127.0.0.1:" + port;
  server.on(
    "request",
    dashboardServer({
      store,
      owner: { userId: "a", tenantId: "t" },
      token: "a".repeat(64),
      port,
      pairCode: "b".repeat(24),
      desktopBootstrap: "c".repeat(64),
      assets: "apps/dashboard",
    }),
  );
  const post = (path: string, code: string, Cookie = "", Origin = origin) =>
    fetch(origin + path, {
      method: "POST",
      redirect: "manual",
      headers: { Origin, Cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  const health = (Cookie: string) =>
    fetch(origin + "/v1/health", { headers: { Cookie } });
  try {
    assert.equal(
      (await post("/desktop-pair", "c".repeat(64), "", "https://evil.test"))
        .status,
      403,
    );
    assert.equal((await post("/desktop-pair", "wrong")).status, 403);
    const native = await post("/desktop-pair", "c".repeat(64));
    assert.equal(native.status, 303);
    assert.equal(native.headers.get("location"), "/");
    const nativeCookie = native.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post("/desktop-pair", "c".repeat(64))).status, 403);
    const browser = await post("/pair", "b".repeat(24));
    assert.equal(browser.status, 204);
    const browserCookie = browser.headers.get("set-cookie")!.split(";")[0]!;
    assert.notEqual(browserCookie, nativeCookie);
    assert.equal((await health(nativeCookie)).status, 200);
    assert.equal((await health(browserCookie)).status, 200);
    assert.equal((await post("/logout", "", nativeCookie)).status, 204);
    assert.equal((await health(nativeCookie)).status, 401);
    assert.equal((await health(browserCookie)).status, 200);
    assert.equal((await post("/desktop-pair", "c".repeat(64))).status, 403);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
  }
});
