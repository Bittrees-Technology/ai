import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  openRemotePanel as open,
  loginRemotePanel as login,
  expectSignedOut as signedOut,
} from "./support/remote-panel.js";
import { Wallet } from "ethers";
import { mkdir, readFile } from "node:fs/promises";
const origin = "https://ai.bittrees.org",
  marker = "bittrees.browser-session.v1";
const reg = (p: Page) =>
  p.getByRole("region", { name: "Browser registration", exact: true });
const keys = (p: Page) =>
  p.getByRole("region", { name: "Browser keys and recovery", exact: true });
async function recovery(p: Page) {
  await p.bringToFront();
  await p
    .getByRole("button", { name: "Open recovery controls", exact: true })
    .click();
  await expect(reg(p)).toBeVisible();
}
async function refresh(p: Page) {
  await reg(p)
    .getByRole("button", { name: "Refresh registration", exact: true })
    .click();
  await expect(reg(p).getByRole("status")).toContainText(
    "Registration checked",
  );
}
async function refreshKeys(p: Page) {
  await keys(p)
    .getByRole("button", { name: "Refresh keys", exact: true })
    .click();
  await expect(keys(p).getByRole("status")).toContainText("Key history loaded");
}
async function register(p: Page) {
  await refresh(p);
  await reg(p)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(p).getByRole("checkbox").check();
  await reg(p)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(reg(p).getByRole("status")).toContainText("registered until");
  await refreshKeys(p);
}
async function start(p: Page) {
  await keys(p)
    .getByRole("button", { name: "Review new key", exact: true })
    .click();
  await keys(p)
    .getByRole("checkbox", { name: "I understand this exact change." })
    .check();
  await keys(p)
    .getByRole("button", { name: "Confirm start key setup", exact: true })
    .click();
}
async function preview(p: Page, browser: string, state: string) {
  await mkdir("test-results", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    await expect
      .poll(() =>
        p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await p.screenshot({
      path: `test-results/production-recovery-${browser}-${name}-${state}.png`,
      fullPage: true,
    });
  }
}

test("built page completes saved-code and saved-file activation under CSP and retains keys across reload", async ({
  page,
}, info) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates.*directive/i.test(m.text()))
      violations.push(m.text());
  });
  await open(page);
  await login(page);
  await expect(reg(page)).toHaveCount(0);
  await recovery(page);
  await register(page);
  await start(page);
  await expect(
    keys(page).getByRole("region", { name: "Save recovery code", exact: true }),
  ).toBeVisible();
  const codeDownload = page.waitForEvent("download");
  await keys(page)
    .getByRole("button", { name: "Download recovery code", exact: true })
    .click();
  const code = (
    await readFile((await (await codeDownload).path())!, "utf8")
  ).trim();
  await page.evaluate(() => window.remoteAuthWalletTest.blur());
  await page.bringToFront();
  // Ordinary concealment retains the resumable setup; re-enter the saved code.
  await keys(page)
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await keys(page)
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  await keys(page)
    .getByRole("button", { name: "Prepare encrypted backup", exact: true })
    .click();
  const kitDownload = page.waitForEvent("download");
  await keys(page)
    .getByRole("button", {
      name: "Download this encrypted backup",
      exact: true,
    })
    .click();
  const kit = await readFile((await (await kitDownload).path())!, "utf8");
  expect(JSON.parse(kit).format).toBe("bittrees-browser-endpoint-recovery-v1");
  expect(kit).not.toContain(code);
  await keys(page)
    .getByLabel("Saved encrypted backup file", { exact: true })
    .setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(kit),
    });
  await keys(page)
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await keys(page)
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await keys(page)
    .getByRole("button", { name: "Check backup and activate key", exact: true })
    .click();
  await expect(keys(page).getByRole("status")).toContainText(
    "Browser key ready",
  );
  await preview(page, info.project.name, "ready");
  await page.reload();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
  await expect(reg(page)).toHaveCount(0);
  await recovery(page);
  await refresh(page);
  await refreshKeys(page);
  await expect(
    keys(page).getByText("Ready for pairing", { exact: true }),
  ).toBeVisible();
  expect(violations).toEqual([]);
});

test("status rendering cannot enable unacknowledged recovery confirmation and previews keep keyboard focus", async ({
  page,
}, info) => {
  await open(page);
  await login(page);
  await recovery(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  const confirm = reg(page).getByRole("button", {
    name: "Confirm registration",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await page.getByRole("button", { name: "Load devices", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Load devices", exact: true }),
  ).toBeEnabled();
  await expect(confirm).toBeDisabled();
  await reg(page).getByRole("checkbox").focus();
  // Exercise keyboard modality so the captured review includes :focus-visible.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(reg(page).getByRole("checkbox")).toBeFocused();
  await preview(page, info.project.name, "review");
});

test("logout during key identity verification destroys the mounted view and prevents a late key reservation", async ({
  page,
  identityServer,
}) => {
  await open(page);
  await login(page);
  await recovery(page);
  await register(page);
  identityServer.hold("/browser/registration/identity");
  await start(page);
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(reg(page)).toHaveCount(0);
  identityServer.release();
  await signedOut(page);
  await login(page);
  await recovery(page);
  await keys(page)
    .getByRole("button", { name: "Refresh keys", exact: true })
    .click();
  await expect(keys(page).getByRole("status")).toContainText(
    "Register this browser again",
  );
  await expect(
    keys(page).getByText("No browser keys saved.", { exact: true }),
  ).toBeVisible();
});

test("failed logout stays pending across reload and requires cleanup before cookie adoption", async ({
  page,
  context,
  identityServer,
}) => {
  await open(page);
  await login(page);
  await recovery(page);
  identityServer.offline(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signedOut(page);
  expect(
    await page.evaluate(
      (k) =>
        JSON.parse(localStorage.getItem(k)!).revision !==
        localStorage.getItem(k + ".ack"),
      marker,
    ),
  ).toBe(true);
  await page.reload();
  await signedOut(page);
  await expect(reg(page)).toHaveCount(0);
  identityServer.offline(false);
  await page
    .getByRole("button", { name: "Refresh session", exact: true })
    .click();
  await signedOut(page);
  expect(
    (await context.cookies(origin)).some(
      (c) => c.name === "__Host-bittrees-session",
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      (k) =>
        JSON.parse(localStorage.getItem(k)!).revision !==
        localStorage.getItem(k + ".ack"),
      marker,
    ),
  ).toBe(false);
  await login(page);
});

test("a second tab logout invalidates and removes the first tab recovery view", async ({
  page,
  context,
}) => {
  const wallet = await open(page);
  await login(page);
  await recovery(page);
  const second = await context.newPage();
  await open(second, undefined, wallet, true);
  await expect(reg(page)).toHaveCount(1);
  await second.getByRole("button", { name: "Sign out", exact: true }).click();
  await signedOut(second);
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(reg(page)).toHaveCount(0);
  await second.close();
});

test("a mismatched wallet on another tab invalidates existing recovery before clearing its cookie", async ({
  page,
  context,
}) => {
  await open(page);
  await login(page);
  await recovery(page);
  const second = await context.newPage();
  await open(second, undefined, Wallet.createRandom());
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(reg(page)).toHaveCount(0);
  await second.close();
});

test("cross-tab authentication is serialized and a later login cannot leave the earlier owner active", async ({
  page,
  context,
  identityServer,
}) => {
  const a = await open(page),
    second = await context.newPage(),
    b = await open(second);
  identityServer.hold("/browser/login/verify");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await second.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(
    second.getByRole("button", { name: "Sign in with wallet" }),
  ).toBeDisabled();
  expect(
    identityServer.events.filter((x) => x === "/browser/login/challenge")
      .length,
  ).toBe(1);
  identityServer.release();
  await expect(second.locator("#account")).toContainText(
    b.address.toLowerCase(),
    { ignoreCase: true },
  );
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  expect(a.address).not.toBe(b.address);
  await second.close();
});

test("closing a tab during verification leaves durable cleanup and cannot overwrite a later login", async ({
  page,
  context,
  identityServer,
}) => {
  await open(page);
  identityServer.hold("/browser/login/verify");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.close();
  const second = await context.newPage();
  const wallet = await open(second);
  await login(second);
  identityServer.release();
  await second
    .getByRole("button", { name: "Refresh session", exact: true })
    .click();
  await expect(second.locator("#account")).toContainText(wallet.address, {
    ignoreCase: true,
  });
  await second.close();
});

test("corrupt coordination metadata denies login and recovery instead of trusting existing cookies", async ({
  page,
  identityServer,
}) => {
  await open(page);
  await login(page);
  await page.evaluate(
    (k) =>
      localStorage.setItem(
        k,
        '{"version":1,"revision":"bad","cleanupRequired":false}',
      ),
    marker,
  );
  await page.reload();
  await signedOut(page);
  await expect(page.locator("#error")).toContainText(
    "local storage and session coordination",
  );
  const before = identityServer.events.filter(
    (x) => x === "/browser/login/challenge",
  ).length;
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await signedOut(page);
  expect(
    identityServer.events.filter((x) => x === "/browser/login/challenge")
      .length,
  ).toBe(before);
  await expect(page.locator("#browser-recovery")).toBeHidden();
});

test("storage-denied browser does not start cookie authentication or open key storage", async ({
  page,
  identityServer,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await open(page);
  await expect(page.locator("#error")).toContainText(
    "local storage and session coordination",
  );
  await expect(page.locator("#browser-recovery")).toBeHidden();
  expect(identityServer.events).toEqual([]);
});

test("observed session expiry removes mounted recovery without waiting for a user action", async ({
  page,
}) => {
  await open(page);
  await login(page);
  await recovery(page);
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 7200000;
  });
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(reg(page)).toHaveCount(0);
});

test("a newer cancellation cannot be erased by an older login acknowledgment", async ({
  page,
}) => {
  await open(page);
  await login(page);
  await recovery(page);
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    let armed = true;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key + ".ack" && armed) {
        armed = false;
        original.call(
          this,
          key,
          JSON.stringify({ version: 1, revision: crypto.randomUUID() }),
        );
      }
      original.call(this, name, value);
    };
  }, marker);
  await page
    .getByRole("button", { name: "Refresh session", exact: true })
    .click();
  await signedOut(page);
  await expect(reg(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      (k) =>
        JSON.parse(localStorage.getItem(k)!).revision !==
        localStorage.getItem(k + ".ack"),
      marker,
    ),
  ).toBe(true);
});
