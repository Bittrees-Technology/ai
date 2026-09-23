import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  openRemotePanel as open,
  loginRemotePanel as login,
  expectSignedOut as signedOut,
} from "./support/remote-panel.js";
const origin = "https://ai.bittrees.org";

test("production sign-out remains clickable during delayed verify and removes its eventual cookie", async ({
  page,
  context,
  identityServer,
}) => {
  await open(page);
  identityServer.hold("/browser/login/verify");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  identityServer.release();
  await signedOut(page);
  expect(
    (await context.cookies(origin)).some(
      (c) => c.name === "__Host-bittrees-session",
    ),
  ).toBe(false);
  await page.reload();
  await signedOut(page);
  await login(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signedOut(page);
});

test("production wallet change away and back rejects a delayed session response", async ({
  page,
  context,
  identityServer,
}) => {
  await open(page);
  identityServer.hold("/browser/session");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.evaluate(() => {
    window.remoteAuthWalletTest.change();
    window.remoteAuthWalletTest.change();
  });
  identityServer.release();
  await signedOut(page);
  expect(
    (await context.cookies(origin)).some(
      (c) => c.name === "__Host-bittrees-session",
    ),
  ).toBe(false);
  await login(page);
});

test("production wallet-prompt blur preserves login and sign-out is available during the prompt", async ({
  page,
}) => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  await open(page, { entered, wait });
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await waiting;
  await page.evaluate(() => window.remoteAuthWalletTest.blur());
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  release();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
  await page.evaluate(() => window.remoteAuthWalletTest.blur());
  await expect(page.locator("#account")).toContainText("Verified wallet:");
});

test("production failed logout clears local access and retries cleanup before refresh can restore it", async ({
  page,
  context,
  identityServer,
}) => {
  await open(page);
  await login(page);
  identityServer.offline(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signedOut(page);
  await expect(page.locator("#error")).toContainText(
    "server sign-out could not be confirmed",
  );
  await page.getByRole("button", { name: "Refresh session" }).click();
  await signedOut(page);
  identityServer.offline(false);
  await page.getByRole("button", { name: "Refresh session" }).click();
  await signedOut(page);
  expect(
    (await context.cookies(origin)).some(
      (c) => c.name === "__Host-bittrees-session",
    ),
  ).toBe(false);
  await login(page);
});

test("production refresh removes displayed account immediately while its request is pending", async ({
  page,
  identityServer,
}) => {
  await open(page);
  await login(page);
  identityServer.hold("/browser/session");
  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(page.locator("#management")).toBeHidden();
  identityServer.release();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
});
