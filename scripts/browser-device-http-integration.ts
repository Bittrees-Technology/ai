import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import type { IncomingHttpHeaders } from "node:http";
import { BrowserDeviceClient } from "../modules/remote/browser-device-client.js";
import type { VerifiedBrowserDeviceScope } from "../modules/remote/browser-device-contracts.js";
type Call = (
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: IncomingHttpHeaders; body: any }>;
export async function checkBrowserDeviceHttp(call: Call) {
  const browser = {
    Origin: "https://ai.bittrees.org",
    "X-Bittrees-Request": "1",
    "Sec-Fetch-Site": "same-origin",
  };
  async function login() {
    const wallet = Wallet.createRandom();
    const begun = await call(
      "/browser/login/challenge",
      { address: wallet.address },
      browser,
    );
    const challenge = begun.headers["set-cookie"]!.find((c) =>
      c.startsWith("__Host-bittrees-login="),
    )!.split(";")[0]!;
    const verified = await call(
      "/browser/login/verify",
      {
        message: begun.body.message,
        signature: await wallet.signMessage(begun.body.message),
      },
      { ...browser, Cookie: challenge },
    );
    assert.equal(verified.status, 200);
    return {
      session: verified.headers["set-cookie"]!.find((c) =>
        c.startsWith("__Host-bittrees-session="),
      )!.split(";")[0]!,
      ownerId: verified.body.ownerId as string,
    };
  }
  const a = await login(),
    b = await login();
  let cookie = a.session;
  const owner = () => ({
    ...browser,
    Cookie: cookie,
    "X-Bittrees-Account": a.ownerId,
  });
  const transport: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, browser.Origin);
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    const result = await call(
      new URL(String(url)).pathname,
      JSON.parse(String(init?.body)),
      { ...owner(), ...Object.fromEntries(headers.entries()) },
    );
    for (const c of result.headers["set-cookie"] ?? []) {
      if (!c.startsWith("__Host-bittrees-browser-device=")) continue;
      for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"])
        assert.ok(c.includes(flag));
      cookie = a.session + "; " + c.split(";")[0]!;
    }
    assert.equal(result.headers["cache-control"], "no-store");
    return Response.json(result.body, { status: result.status });
  };
  const client = new BrowserDeviceClient(
    () => ({ ownerId: a.ownerId, scope: "tls-fixture" }),
    transport,
  );
  assert.equal((await client.inspect()).registration, null);
  const request = {
    operationId: randomUUID(),
    expected: null,
    confirmed: true,
  };
  const registered = await client.register(request);
  assert.equal((registered as any).credential, undefined);
  assert.equal(registered.binding.ownerId, a.ownerId);
  let scope: VerifiedBrowserDeviceScope | undefined;
  await client.withVerifiedDevice(registered.binding, async (s) => {
    scope = s;
    assert.deepEqual(s.current(), registered.binding);
    assert.equal(s.freshRegistration(registered.binding), true);
  });
  assert.equal(scope!.current(), null);
  const credentialCookie = cookie.split("; ")[1]!,
    credential = credentialCookie.split("=")[1]!;
  const identityPath = "/browser/registration/identity";
  assert.equal(
    (
      await call(
        "/device/identity",
        {},
        { Authorization: "Bearer " + credential },
      )
    ).status,
    403,
  );
  for (const headers of [
    { ...owner(), "X-Bittrees-Account": b.ownerId },
    { ...owner(), Cookie: b.session + "; " + credentialCookie },
    { ...owner(), Cookie: a.session },
    { ...owner(), Cookie: cookie + "; " + credentialCookie },
    {
      ...owner(),
      Cookie:
        a.session +
        "; __Host-bittrees-browser-device=" +
        randomBytes(32).toString("base64url"),
    },
    { ...owner(), Origin: "https://evil.invalid" },
    { ...owner(), "Sec-Fetch-Site": "same-site" },
    { ...owner(), Authorization: "Bearer " + credential },
  ])
    assert.equal((await call(identityPath, {}, headers)).status, 403);
  assert.equal(
    (await call(identityPath, { ownerId: a.ownerId }, owner())).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/browser/registration/create",
        { ...request, confirmed: false },
        owner(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/browser/registration/create", request, {
        ...owner(),
        Cookie: a.session,
      })
    ).status,
    409,
  );
  const listing = await client.list();
  assert.equal(listing.items.length, 1);
  assert.deepEqual(listing.items[0]!.binding, registered.binding);
  assert.equal(JSON.stringify(listing).includes(credential), false);
  const revoke = {
    deviceId: registered.binding.deviceId,
    credentialEpoch: 1,
    confirmed: true,
  };
  assert.equal(
    (
      await call("/browser/registration/revoke", revoke, {
        ...browser,
        Cookie: b.session,
        "X-Bittrees-Account": b.ownerId,
      })
    ).status,
    403,
  );
  await client.revoke(revoke);
  await assert.rejects(
    client.withVerifiedDevice(registered.binding, async () => assert.fail()),
    /DENIED/,
  );
  const inspected = await client.inspect();
  assert.notEqual(inspected.registration!.revokedAt, null);
  assert.equal(inspected.registration!.binding.credentialEpoch, 2);
  const next = await client.register({
    operationId: randomUUID(),
    expected: { deviceId: registered.binding.deviceId, credentialEpoch: 2 },
    confirmed: true,
  });
  assert.notEqual(next.binding.deviceId, registered.binding.deviceId);
  await call("/browser/logout", {}, owner());
  client.invalidate();
  await assert.rejects(
    client.withVerifiedDevice(next.binding, async () => assert.fail()),
    /DENIED/,
  );
  console.log(
    "Browser registration HTTPS: actual client, SIWE/cookie identity, scope lifetime, response projection, CSRF/account/duplicate-cookie/credential separation, replay, revoke and logout passed.",
  );
}
