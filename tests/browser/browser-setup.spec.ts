import { expect, type Page, type Download } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { Wallet, type HDNodeWallet } from "ethers";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
const reg = (page: Page) =>
  page.getByRole("region", { name: "Browser registration", exact: true });
const keys = (page: Page) =>
  page.getByRole("region", { name: "Browser keys and recovery", exact: true });
async function open(page: Page) {
  await page.goto("https://ai.bittrees.org/?browser-setup");
  await page.waitForFunction(() => !!window.browserSetupTest);
}
async function login(page: Page, wallet: HDNodeWallet = Wallet.createRandom()) {
  await open(page);
  const challenge = await page.evaluate(
    (address) => window.browserSetupTest.challenge(address),
    wallet.address,
  );
  const owner = await page.evaluate(
    ({ message, signature }) =>
      window.browserSetupTest.login(message, signature),
    {
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
    },
  );
  await page.bringToFront();
  return { wallet, owner };
}
async function refresh(page: Page) {
  await reg(page)
    .getByRole("button", { name: "Refresh registration", exact: true })
    .click();
  await expect(reg(page).getByRole("status")).toContainText(
    "Registration checked",
  );
}
async function refreshKeys(page: Page) {
  await keys(page)
    .getByRole("button", { name: "Refresh keys", exact: true })
    .click();
  await expect(keys(page).getByRole("status")).not.toContainText("Loading");
}
async function register(page: Page) {
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await expect(
    reg(page).getByRole("button", {
      name: "Confirm registration",
      exact: true,
    }),
  ).toBeDisabled();
  await reg(page).getByRole("checkbox").check();
  await reg(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(reg(page).getByRole("status")).toContainText("registered until");
  await refreshKeys(page);
}
async function keyReview(page: Page, action: string, confirm: string) {
  await keys(page).getByRole("button", { name: action, exact: true }).click();
  await keys(page)
    .getByRole("checkbox", { name: "I understand this exact change." })
    .check();
  await keys(page).getByRole("button", { name: confirm, exact: true }).click();
}
const contents = async (d: Download) => readFile((await d.path())!, "utf8");
async function start(page: Page) {
  await keyReview(page, "Review new key", "Confirm start key setup");
  await expect(
    keys(page).getByRole("region", { name: "Save recovery code", exact: true }),
  ).toBeVisible();
  const wait = page.waitForEvent("download");
  await keys(page)
    .getByRole("button", { name: "Download recovery code", exact: true })
    .click();
  return (await contents(await wait)).trim();
}
async function prepare(page: Page, code: string) {
  await keys(page)
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await keys(page)
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  await keys(page)
    .getByRole("button", { name: "Prepare encrypted backup", exact: true })
    .click();
  await expect(
    keys(page).getByRole("region", {
      name: "Check backup before activation",
      exact: true,
    }),
  ).toBeVisible();
  const wait = page.waitForEvent("download");
  await keys(page)
    .getByRole("button", {
      name: "Download this encrypted backup",
      exact: true,
    })
    .click();
  return JSON.parse(await contents(await wait));
}
async function activate(page: Page, code: string, kit: unknown) {
  await keys(page)
    .getByLabel("Saved encrypted backup file", { exact: true })
    .setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(kit)),
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
}
async function active(page: Page) {
  const user = await login(page);
  await register(page);
  const code = await start(page),
    kit = await prepare(page, code);
  await activate(page, code, kit);
  return { ...user, code, kit };
}
const status = (page: Page) =>
  page.evaluate(() => window.browserSetupTest.status());
test("Registration acknowledgment reaches real saved-backup key setup and survives reload without fresh-registration claims", async ({
  page,
}) => {
  const { kit, owner, code } = await active(page);
  const before = await status(page);
  expect(before.slots[0]!.state).toBe("active");
  expect(kit.format).toBe("bittrees-browser-endpoint-recovery-v1");
  expect(JSON.stringify(kit)).not.toContain(owner);
  expect(JSON.stringify(kit)).not.toContain(code);
  await open(page);
  await page.evaluate(() => window.browserSetupTest.resume());
  await page.bringToFront();
  await refresh(page);
  await refreshKeys(page);
  expect((await status(page)).slots).toEqual(before.slots);
  expect(
    (await page.evaluate(() => window.browserSetupTest.context()))!
      .freshRegistration,
  ).toBe(false);
  await expect(
    keys(page).getByText("Ready for pairing", { exact: true }),
  ).toBeVisible();
});
test("Revocation stops online setup but preserves offline export and confirmed local deletion", async ({
  page,
  identityServer,
}) => {
  const { kit } = await active(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review browser revocation" })
    .click();
  await expect(
    reg(page).getByRole("button", { name: "Confirm browser revocation" }),
  ).toBeDisabled();
  await reg(page).getByRole("checkbox").check();
  await reg(page)
    .getByRole("button", { name: "Confirm browser revocation" })
    .click();
  await expect(reg(page).getByRole("status")).toContainText(
    "registration revoked",
  );
  await expect(
    page.evaluate(() =>
      window.browserSetupTest.begin({ expectedRevision: 2, confirmed: true }),
    ),
  ).rejects.toThrow("DENIED");
  identityServer.offline(true);
  const calls = identityServer.events.length;
  await refreshKeys(page);
  await expect(
    keys(page).getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
  const wait = page.waitForEvent("download");
  await keys(page)
    .getByRole("button", { name: "Download encrypted backup", exact: true })
    .click();
  expect(JSON.parse(await contents(await wait))).toEqual(kit);
  await keyReview(
    page,
    "Review deletion of all keys",
    "Confirm delete all browser keys",
  );
  expect((await status(page)).slots.every((x) => x.state === "deleted")).toBe(
    true,
  );
  expect(identityServer.events.length).toBe(calls);
});
test("A changed cookie in another tab rejects the exact reviewed replacement without another registration", async ({
  page,
  context,
  identityServer,
}) => {
  const { owner } = await login(page);
  await register(page);
  const old = (await page.evaluate(() => window.browserSetupTest.context()))!
    .binding!;
  const other = await context.newPage();
  await open(other);
  await other.evaluate(() => window.browserSetupTest.resume());
  await page.bringToFront();
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(page).getByRole("checkbox").check();
  await other.evaluate((raw) => window.browserSetupTest.register(raw), {
    operationId: randomUUID(),
    expected: { deviceId: old.deviceId, credentialEpoch: old.credentialEpoch },
    confirmed: true,
  });
  await reg(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(reg(page).getByRole("alert")).toContainText(
    "registration changed",
  );
  expect(
    (
      await identityServer.pool.query(
        "SELECT count(*) FROM remote_browser_devices WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].count,
  ).toBe("2");
  expect((await status(page)).slots).toHaveLength(0);
});
test("Scope loss while identity verification waits cannot reserve a key", async ({
  page,
  identityServer,
}) => {
  await login(page);
  await register(page);
  identityServer.hold();
  await keyReview(page, "Review new key", "Confirm start key setup");
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.evaluate(() => window.browserSetupTest.changeScope());
  identityServer.release();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          await window.browserSetupTest.begin({
            expectedRevision: 0,
            confirmed: true,
          });
          return "unexpected success";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }),
    )
    .toBe("DENIED");
  await open(page);
  await page.evaluate(() => window.browserSetupTest.resume());
  expect((await status(page)).slots).toHaveLength(0);
});
test("A committed registration acknowledged after scope loss cannot become fresh key authority", async ({
  page,
  identityServer,
}) => {
  const { owner } = await login(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(page).getByRole("checkbox").check();
  identityServer.hold("/browser/registration/create");
  await reg(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.evaluate(() => window.browserSetupTest.changeScope());
  identityServer.release();
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (c) => c.name === "__Host-bittrees-browser-device",
      ),
    )
    .toBe(true);
  await open(page);
  await page.evaluate(() => window.browserSetupTest.resume());
  await page.bringToFront();
  await refresh(page);
  await refreshKeys(page);
  expect(
    (await page.evaluate(() => window.browserSetupTest.context()))!
      .freshRegistration,
  ).toBe(false);
  await expect(
    keys(page).getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
  expect((await status(page)).slots).toHaveLength(0);
  expect(
    (
      await identityServer.pool.query(
        "SELECT count(*) FROM remote_browser_devices WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].count,
  ).toBe("1");
});
test("Lost registration responses never auto-retry or claim setup authority", async ({
  page,
  identityServer,
}) => {
  const { owner } = await login(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(page).getByRole("checkbox").check();
  identityServer.drop("/browser/registration/create");
  await reg(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(reg(page).getByRole("alert")).toContainText("not confirmed");
  expect(
    identityServer.events.filter((x) => x === "/browser/registration/create"),
  ).toHaveLength(1);
  expect(
    (
      await identityServer.pool.query(
        "SELECT count(*) FROM remote_browser_devices WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].count,
  ).toBe("1");
  expect(
    (await page.evaluate(() => window.browserSetupTest.context()))!
      .freshRegistration,
  ).toBe(false);
  expect((await status(page)).slots).toHaveLength(0);
  await refresh(page);
});
test("Blur cancels unconfirmed registration yet preserves acknowledged setup through saved-code reentry", async ({
  page,
  identityServer,
}) => {
  await login(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(page).getByRole("checkbox").check();
  await page.evaluate(() => window.browserSetupTest.blur());
  await expect(
    reg(page).getByRole("button", {
      name: "Confirm registration",
      exact: true,
    }),
  ).toBeHidden();
  expect(
    identityServer.events.filter((x) => x === "/browser/registration/create"),
  ).toHaveLength(0);
  await register(page);
  await page.evaluate(() => window.browserSetupTest.blur());
  await refreshKeys(page);
  const code = await start(page);
  await page.evaluate(() => window.browserSetupTest.blur());
  const kit = await prepare(page, code);
  await activate(page, code, kit);
  expect((await status(page)).slots[0]!.state).toBe("active");
});
test("Expired fresh-registration observations and expired review confirmations cannot authorize setup", async ({
  page,
  identityServer,
}) => {
  await login(page);
  await register(page);
  await page.evaluate(() => window.browserSetupTest.advance(120001));
  await refreshKeys(page);
  await expect(
    keys(page).getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
  await expect(
    page.evaluate(() =>
      window.browserSetupTest.begin({ expectedRevision: 0, confirmed: true }),
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await reg(page).getByRole("checkbox").check();
  const count = identityServer.events.length;
  await page.evaluate(() => window.browserSetupTest.advance(120001));
  await expect(
    reg(page).getByRole("button", {
      name: "Confirm registration",
      exact: true,
    }),
  ).toBeHidden();
  expect(identityServer.events.length).toBe(count);
  expect((await status(page)).slots).toHaveLength(0);
});
test("Another signed-in account sees only its own registration and local key history", async ({
  page,
}) => {
  const first = await active(page),
    old = (await status(page)).slots[0]!.id;
  const second = await login(page);
  expect(second.owner).not.toBe(first.owner);
  await refresh(page);
  await refreshKeys(page);
  expect((await status(page)).slots).toHaveLength(0);
  await expect(keys(page)).not.toContainText(old);
  await expect(reg(page)).not.toContainText(first.owner);
  await expect(
    keys(page).getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
});
test("Registration history uses server pages without joining another owner or silently accumulating rows", async ({
  page,
  identityServer,
}) => {
  const { owner } = await login(page);
  const n = Date.now();
  for (let i = 0; i < 51; i++)
    await identityServer.pool.query(
      "INSERT INTO remote_browser_devices(id,owner_id,operation_id,credential_hash,credential_epoch,created_at,expires_at) VALUES($1,$2,$3,$4,1,$5,$6)",
      [
        randomUUID(),
        owner,
        randomUUID(),
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
        n,
        n + 3600000,
      ],
    );
  await refresh(page);
  await expect(reg(page).getByRole("listitem")).toHaveCount(50);
  await reg(page)
    .getByRole("button", { name: "Show next registrations" })
    .click();
  await expect(reg(page).getByRole("listitem")).toHaveCount(1);
  await expect(
    reg(page).getByRole("button", { name: "Show next registrations" }),
  ).toBeHidden();
  await refresh(page);
  await expect(reg(page).getByRole("listitem")).toHaveCount(50);
});
test("Registration review is keyboard reachable and readable at desktop and phone widths", async ({
  page,
  browserName,
}) => {
  await login(page);
  await refresh(page);
  await reg(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    reg(page).getByRole("heading", { name: "Create browser registration" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reg(page).getByRole("checkbox")).toBeFocused();
  await mkdir("test-results", { recursive: true });
  for (const [name, width] of [
    ["desktop", 1280],
    ["phone", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/browser-registration-${browserName}-${name}-review.png`,
      fullPage: true,
    });
  }
  await reg(page).getByRole("checkbox").check();
  await reg(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(reg(page).getByRole("status")).toContainText("registered until");
  await refreshKeys(page);
  for (const [name, width] of [
    ["desktop", 1280],
    ["phone", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `test-results/browser-registration-${browserName}-${name}-registered.png`,
      fullPage: true,
    });
  }
});

test("Replacing registration requires a separate local reset and retains the previous encrypted backup", async ({
  page,
}) => {
  const first = await active(page),
    old = (await status(page)).slots[0]!;
  await register(page);
  await expect(
    keys(page).getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
  await keyReview(
    page,
    "Review new registration",
    "Confirm use new browser registration",
  );
  expect((await status(page)).slots[0]!.state).toBe("retired");
  await expect(
    keys(page).getByRole("button", {
      name: "Review new registration",
      exact: true,
    }),
  ).toBeHidden();
  const code = await start(page),
    kit = await prepare(page, code);
  await activate(page, code, kit);
  const rows = (await status(page)).slots;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.id).toBe(old.id);
  expect(rows[0]!.publicKey).toBe(old.publicKey);
  expect(rows[1]!.state).toBe("active");
  expect(rows[1]!.binding.deviceId).not.toBe(old.binding.deviceId);
  const firstRow = keys(page).getByRole("listitem").filter({ hasText: old.id });
  const wait = page.waitForEvent("download");
  await firstRow
    .getByRole("button", { name: "Download encrypted backup", exact: true })
    .click();
  expect(JSON.parse(await contents(await wait))).toEqual(first.kit);
});

test("A wrong activation code leaves the original prepared key resumable after fresh identity verification", async ({
  page,
}) => {
  await login(page);
  await register(page);
  const code = await start(page),
    kit = await prepare(page, code),
    before = (await status(page)).slots[0]!;
  await keys(page)
    .getByLabel("Saved encrypted backup file", { exact: true })
    .setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(kit)),
    });
  await keys(page)
    .getByLabel("Recovery code for activation", { exact: true })
    .fill("btre1_" + "A".repeat(43));
  await keys(page)
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await keys(page)
    .getByRole("button", { name: "Check backup and activate key", exact: true })
    .click();

  // Wait for the failed online callback to settle before reviewing the same slot.
  await expect
    .poll(() =>
      page.evaluate(() => window.browserSetupTest.context()?.freshRegistration),
    )
    .toBe(false);
  await refreshKeys(page);
  await keyReview(page, "Resume setup", "Confirm resume key setup");
  const again = await prepare(page, code);
  expect(again).toEqual(kit);
  await activate(page, code, again);
  const after = (await status(page)).slots[0]!;
  expect(after.id).toBe(before.id);
  expect(after.publicKey).toBe(before.publicKey);
  expect(after.state).toBe("active");
});
