import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { Wallet, type HDNodeWallet } from "ethers";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteApp } from "../../modules/remote/http.js";
const origin = "https://ai.bittrees.org",
  schema = "browser_identity_" + randomUUID().replaceAll("-", "");
let admin: Pool,
  pool: Pool,
  server: ReturnType<typeof createServer>,
  folder: string,
  cert: Buffer,
  holdIdentity = false,
  heldIdentity = false,
  releaseIdentity: (() => void) | undefined;
test.beforeAll(async () => {
  const connectionString = process.env.BROWSER_TEST_DATABASE_URL;
  if (!connectionString)
    throw Error("Disposable browser test PostgreSQL is required");
  admin = new Pool({ connectionString });
  await admin.query("CREATE SCHEMA " + schema);
  pool = new Pool({ connectionString, options: "-c search_path=" + schema });
  for (const file of [
    "001-status",
    "002-pairing",
    "003-sessions",
    "004-controls",
    "005-control-scope",
    "006-maintenance",
    "007-templates",
    "008-browser-devices",
  ])
    await pool.query(
      await readFile(
        new URL(`../../modules/remote/migrations/${file}.sql`, import.meta.url),
        "utf8",
      ),
    );
  folder = await mkdtemp(join(tmpdir(), "bittrees-browser-identity-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      join(folder, "key.pem"),
      "-out",
      join(folder, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = await readFile(join(folder, "cert.pem"));
  server = createServer(
    { key: await readFile(join(folder, "key.pem")), cert },
    createRemoteApp(pool, {
      origin,
      chainId: 1,
      sessionMs: 3600000,
      deviceMs: 7200000,
      retentionMs: 86400000,
      requestsPerMinute: 1000,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
test.afterAll(async () => {
  releaseIdentity?.();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await pool?.end();
  if (admin) {
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  }
  if (folder) await rm(folder, { recursive: true, force: true });
});
test.beforeEach(async ({ context }) => {
  holdIdentity = false;
  heldIdentity = false;
  releaseIdentity = undefined;
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (
      url.pathname.startsWith("/browser/") ||
      url.pathname.startsWith("/device/")
    ) {
      const headers = await req.allHeaders();
      const result = await new Promise<{
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      }>((resolve, reject) => {
        const call = request(
          {
            hostname: "127.0.0.1",
            port: (server.address() as { port: number }).port,
            path: url.pathname,
            method: req.method(),
            ca: cert,
            servername: "localhost",
            headers: { ...headers, host: "ai.bittrees.org" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                headers: Object.fromEntries(
                  Object.entries(res.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [
                      k,
                      Array.isArray(v) ? v.join("\n") : String(v),
                    ]),
                ),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        call.setTimeout(10000, () =>
          call.destroy(Error("Fixture HTTPS timeout")),
        );
        call.on("error", reject);
        call.end(req.postData() ?? "");
      });
      if (holdIdentity && url.pathname.endsWith("/registration/identity")) {
        holdIdentity = false;
        heldIdentity = true;
        await new Promise<void>((r) => {
          releaseIdentity = r;
        });
      }
      return route.fulfill(result);
    }
    // Synthetic frontend only; no request is sent to the public origin.
    const fixture = await fetch(
      "http://127.0.0.1:44137" + url.pathname + url.search,
    );
    return route.fulfill({
      status: fixture.status,
      headers: {
        "content-type": fixture.headers.get("content-type") ?? "text/plain",
      },
      body: Buffer.from(await fixture.arrayBuffer()),
    });
  });
});
async function open(page: Page) {
  await page.goto(origin + "/?browser-device-identity");
  await page.waitForFunction(() => !!window.browserDeviceIdentityTest);
}
async function login(page: Page, wallet: HDNodeWallet = Wallet.createRandom()) {
  await open(page);
  const challenge = await page.evaluate(
    (address) => window.browserDeviceIdentityTest.challenge(address),
    wallet.address,
  );
  await page.evaluate(
    ({ message, signature }) =>
      window.browserDeviceIdentityTest.login(message, signature),
    {
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
    },
  );
  return wallet;
}
async function register(
  page: Page,
  expected: { deviceId: string; credentialEpoch: number } | null = null,
) {
  return page.evaluate(
    (raw) => window.browserDeviceIdentityTest.register(raw),
    { operationId: randomUUID(), expected, confirmed: true },
  );
}
async function active(page: Page) {
  const wallet = await login(page),
    registration = await register(page),
    code = await page.evaluate(() => window.browserDeviceIdentityTest.code());
  const slot = await page.evaluate(() =>
    window.browserDeviceIdentityTest.begin({
      expectedRevision: 0,
      confirmed: true,
    }),
  );
  const raw = {
    keyId: slot.keyId,
    expectedRevision: slot.revision,
    confirmed: true,
  };
  const prepared = await page.evaluate(
    ({ raw, code }) => window.browserDeviceIdentityTest.prepare(raw, code),
    { raw, code },
  );
  const proof = await page.evaluate(
    ({ raw, code, kit }) =>
      window.browserDeviceIdentityTest.activate(
        { ...raw, recoverySaved: true },
        code,
        kit,
      ),
    { raw, code, kit: prepared.recovery },
  );
  return { wallet, registration, proof };
}
test("Actual HTTPS HttpOnly registration drives IndexedDB/WebCrypto setup and survives reload without renewed fresh authority", async ({
  page,
  context,
}) => {
  const { registration, proof } = await active(page);
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).toEqual(proof);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const cookies = await context.cookies(origin);
  for (const name of [
    "__Host-bittrees-session",
    "__Host-bittrees-browser-device",
  ]) {
    const c = cookies.find((c) => c.name === name)!;
    expect(c).toBeTruthy();
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Strict");
    expect(c.path).toBe("/");
    expect(JSON.stringify(registration)).not.toContain(c.value);
  }
  await open(page);
  await page.evaluate(() => window.browserDeviceIdentityTest.resume());
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.fresh()),
  ).toBe(false);
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).toEqual(proof);
});
test("Logout denies use; a new same-owner session retains the independent browser registration and original key", async ({
  page,
}) => {
  const { wallet, proof, registration } = await active(page);
  await page.evaluate(() => window.browserDeviceIdentityTest.logout());
  await expect(
    page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow("DENIED");
  await login(page, wallet);
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.binding()),
  ).toEqual(registration.binding);
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).toEqual(proof);
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.fresh()),
  ).toBe(false);
});
test("Switching accounts cannot reuse the first account's browser registration or local keys", async ({
  page,
}) => {
  const first = await active(page);
  await login(page);
  expect(
    (await page.evaluate(() => window.browserDeviceIdentityTest.inspect()))
      .registration,
  ).toBeNull();
  expect(
    (await page.evaluate(() => window.browserDeviceIdentityTest.status()))
      .slots,
  ).toHaveLength(0);
  await expect(
    page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow("DENIED");
  const second = await register(page);
  expect(second.binding.ownerId).not.toBe(first.registration.binding.ownerId);
  expect(second.binding.deviceId).not.toBe(first.registration.binding.deviceId);
  const items = (
    await page.evaluate(() => window.browserDeviceIdentityTest.list())
  ).items;
  expect(items.map((x) => x.binding.ownerId)).toEqual([second.binding.ownerId]);
});
test("Competing tab replacements commit one identity and deny use of the retired key's registration", async ({
  page,
  context,
}) => {
  const { registration } = await active(page),
    other = await context.newPage();
  await open(other);
  await other.evaluate(() => window.browserDeviceIdentityTest.resume());
  const expected = {
    deviceId: registration.binding.deviceId,
    credentialEpoch: registration.binding.credentialEpoch,
  };
  const results = await Promise.allSettled([
    register(page, expected),
    register(other, expected),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const items = (
    await page.evaluate(() => window.browserDeviceIdentityTest.list())
  ).items;
  expect(items).toHaveLength(2);
  expect(
    items.find((x) => x.binding.deviceId === expected.deviceId)!.revokedAt,
  ).not.toBeNull();
  await expect(
    page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow();
  await expect(
    other.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow();
});
test("Host invalidation discards an actual delayed identity response before key setup", async ({
  page,
}) => {
  await login(page);
  await register(page);
  const before = await page.evaluate(() =>
    window.browserDeviceIdentityTest.entered(),
  );
  holdIdentity = true;
  const denied = expect(
    page.evaluate(() =>
      window.browserDeviceIdentityTest.begin({
        expectedRevision: 0,
        confirmed: true,
      }),
    ),
  ).rejects.toThrow("DENIED");
  await expect.poll(() => heldIdentity).toBe(true);
  await page.evaluate(() => window.browserDeviceIdentityTest.invalidate());
  releaseIdentity!();
  await denied;
  expect(
    await page.evaluate(() => window.browserDeviceIdentityTest.entered()),
  ).toBe(before);
  expect(
    (await page.evaluate(() => window.browserDeviceIdentityTest.status()))
      .slots,
  ).toHaveLength(0);
});
test("Revocation during an operation suppresses its result on real server revalidation", async ({
  page,
  context,
}) => {
  const { registration } = await active(page),
    other = await context.newPage();
  await open(other);
  await other.evaluate(() => window.browserDeviceIdentityTest.resume());
  const denied = expect(
    page.evaluate(() => window.browserDeviceIdentityTest.holdVerified()),
  ).rejects.toThrow("DENIED");
  await page.waitForFunction(() => window.browserDeviceIdentityTest.held());
  await other.evaluate((raw) => window.browserDeviceIdentityTest.revoke(raw), {
    deviceId: registration.binding.deviceId,
    credentialEpoch: 1,
    confirmed: true,
  });
  await page.evaluate(() => window.browserDeviceIdentityTest.release());
  await denied;
  await expect(
    page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow("DENIED");
});
test("An expired registration cookie can inspect history but cannot authorize key use or silently renew", async ({
  page,
}) => {
  const { registration } = await active(page);
  await pool.query(
    "UPDATE remote_browser_devices SET expires_at=created_at+1 WHERE id=$1",
    [registration.binding.deviceId],
  );
  await expect(
    page.evaluate(() => window.browserDeviceIdentityTest.resolve()),
  ).rejects.toThrow("DENIED");
  const view = await page.evaluate(() =>
    window.browserDeviceIdentityTest.inspect(),
  );
  expect(view.registration!.binding.expiresAt).toBeLessThan(Date.now());
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM remote_browser_devices WHERE owner_id=$1",
        [registration.binding.ownerId],
      )
    ).rows[0].count,
  ).toBe("1");
});
