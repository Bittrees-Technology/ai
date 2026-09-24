import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const { RemoteWebController } = await import(
  new URL("../apps/remote-web/controller.js", import.meta.url).href
);
const address = "0x" + "a".repeat(40);
function deferred() {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(hold = "") {
  const entered = deferred(),
    release = deferred(),
    calls: string[] = [];
  const counts = new Map<string, number>();
  let cookie = false,
    failLogout = false,
    failSession = false;
  const account = {
    ownerId: randomUUID(),
    address,
    chainId: 1,
    expiresAt: Date.now() + 3600000,
  };
  async function step(label: string) {
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    calls.push(label + ":" + n);
    if (label + ":" + n === hold) {
      entered.resolve();
      await release.promise;
    }
  }
  const c = new RemoteWebController(
    async (path: string) => {
      await step(path);
      if (path === "/browser/login/challenge")
        return { message: "synthetic challenge" };
      if (path === "/browser/login/verify") {
        cookie = true;
        return {};
      }
      if (path === "/browser/session") {
        if (failSession) throw Error("UNAVAILABLE");
        if (!cookie) throw Error("DENIED");
        return { ...account };
      }
      if (path === "/browser/logout") {
        if (failLogout) throw Error("UNAVAILABLE");
        cookie = false;
        return {};
      }
      return {};
    },
    {
      request: async ({ method }: any) => {
        await step(method);
        return method === "eth_chainId"
          ? "0x1"
          : method === "personal_sign"
            ? "signature"
            : [address];
      },
    },
    { chainId: 1 },
    () => {},
  );
  return {
    c,
    entered,
    release,
    calls,
    account,
    cookie: () => cookie,
    setCookie: (value: boolean) => {
      cookie = value;
    },
    failLogout: (value: boolean) => {
      failLogout = value;
    },
    failSession: (value: boolean) => {
      failSession = value;
    },
  };
}
for (const hold of [
  "eth_requestAccounts:1",
  "personal_sign:1",
  "/browser/login/verify:1",
  "/browser/session:1",
  "eth_accounts:2",
])
  for (const action of ["logout", "walletChanged"] as const)
    test(`${action} immediately clears access and rejects login delayed at ${hold}`, async () => {
      const f = fixture(hold),
        login = f.c.login();
      await f.entered.promise;
      const stop = f.c[action]();
      assert.equal(f.c.state.account, null);
      assert.equal(f.c.sessionContext(), null);
      assert.equal(f.c.state.busy, true);
      const before = f.calls.length;
      await f.c.login();
      assert.equal(f.calls.length, before, "new login cannot race cleanup");
      f.release.resolve();
      await Promise.all([login, stop]);
      assert.equal(f.c.state.account, null);
      assert.equal(f.c.sessionContext(), null);
      assert.equal(f.cookie(), false);
      assert.equal(f.c.state.busy, false);
      assert.equal(f.calls.at(-1), "/browser/logout:1");
      await f.c.login();
      assert.equal(f.c.state.account.ownerId, f.account.ownerId);
      assert.ok(f.c.sessionContext());
    });

test("wallet change away and back coalesces cleanup and cannot reinstate a pending identity", async () => {
  const f = fixture("/browser/login/verify:1"),
    login = f.c.login();
  await f.entered.promise;
  const a = f.c.walletChanged(),
    b = f.c.walletChanged();
  assert.equal(a, b);
  f.release.resolve();
  await Promise.all([login, a, b]);
  assert.equal(f.c.state.account, null);
  assert.equal(f.cookie(), false);
  assert.equal(
    f.calls.filter((x) => x.startsWith("/browser/logout:")).length,
    1,
  );
});

test("wallet prompt blur and hidden view do not cancel authentication or replace its accepted scope", async () => {
  const f = fixture("personal_sign:1"),
    login = f.c.login();
  await f.entered.promise;
  f.c.hide();
  f.release.resolve();
  await login;
  const scope = f.c.sessionContext();
  assert.ok(scope);
  f.c.hide();
  assert.deepEqual(f.c.sessionContext(), scope);
  await f.c.refresh();
  assert.equal(f.c.sessionContext().ownerId, scope.ownerId);
  assert.notEqual(f.c.sessionContext().scope, scope.scope);
});

test("refresh clears the prior trusted scope synchronously and does not restore it on network failure", async () => {
  const f = fixture();
  await f.c.login();
  assert.ok(f.c.sessionContext());
  f.failSession(true);
  const refresh = f.c.refresh();
  assert.equal(f.c.sessionContext(), null);
  assert.equal(f.c.state.account, null);
  await refresh;
  assert.equal(f.c.sessionContext(), null);
  assert.match(f.c.state.error, /could not be confirmed/);
});

test("refresh during pending verification cancels its adoption and cleans the resulting cookie", async () => {
  const f = fixture("/browser/login/verify:1"),
    login = f.c.login();
  await f.entered.promise;
  await f.c.refresh();
  f.release.resolve();
  await login;
  assert.equal(f.c.state.account, null);
  assert.equal(f.cookie(), false);
});

test("failed sign-out remains locally closed and blocks cookie adoption until cleanup succeeds", async () => {
  const f = fixture();
  await f.c.login();
  f.failLogout(true);
  await f.c.logout();
  assert.equal(f.c.state.account, null);
  assert.equal(f.cookie(), true);
  assert.match(f.c.state.error, /could not be confirmed/);
  const before = f.calls.filter((x) =>
    x.startsWith("/browser/session:"),
  ).length;
  await f.c.refresh();
  await f.c.login();
  assert.equal(
    f.calls.filter((x) => x.startsWith("/browser/session:")).length,
    before,
  );
  assert.equal(f.c.state.account, null);
  f.failLogout(false);
  await f.c.login();
  assert.equal(f.c.state.account.ownerId, f.account.ownerId);
  assert.equal(f.c.logoutRequired, false);
});

test("a failed post-verification session read cleans the new cookie before another login", async () => {
  const f = fixture();
  f.failSession(true);
  await f.c.login();
  assert.equal(f.c.state.account, null);
  assert.equal(f.cookie(), false);
  assert.equal(f.calls.at(-1), "/browser/logout:1");
  f.failSession(false);
  await f.c.login();
  assert.ok(f.c.sessionContext());
});

test("expired or wrong-network identities never yield a trusted session scope", async () => {
  for (const patch of [
    { expiresAt: Date.now() - 1 },
    { chainId: 2 },
    { ownerId: "bad-owner" },
    { ownerId: ["11111111-1111-4111-8111-111111111111"] },
    { address: [address] },
  ]) {
    const f = fixture();
    Object.assign(f.account, patch);
    f.setCookie(true);
    await f.c.refresh();
    assert.equal(f.c.sessionContext(), null);
    assert.equal(f.c.state.account, null);
    assert.equal(f.cookie(), false);
  }
  const f = fixture();
  await f.c.login();
  f.c.state.account.expiresAt = Date.now() - 1;
  assert.equal(f.c.sessionContext(), null);
});

test("logout is not delayed by an unrelated device request and its late failure stays concealed", async () => {
  const held = deferred();
  let deviceEntered = false;
  const f = fixture();
  await f.c.login();
  const api = f.c.api;
  f.c.api = async (path: string, body: unknown) => {
    if (path === "/browser/devices") {
      deviceEntered = true;
      await held.promise;
      throw Error("UNAVAILABLE");
    }
    return api(path, body);
  };
  const devices = f.c.devices();
  assert.ok(deviceEntered);
  await f.c.logout();
  assert.equal(f.cookie(), false);
  assert.equal(f.c.state.account, null);
  held.resolve();
  await devices;
  assert.equal(f.c.state.error, "");
  assert.deepEqual(f.c.state.devices, []);
});
