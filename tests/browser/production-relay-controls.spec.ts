import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import {
  openRecovery,
  refreshRegistration,
  registration,
} from "./support/browser-recovery-ui.js";
import { RemoteDeviceStore } from "../../modules/remote/devices.js";
import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Private message connections", exact: true });
const review = (p: Page) =>
  p.getByRole("region", { name: "Review private connection", exact: true });
async function preview(p: Page, info: TestInfo, state: string) {
  await expect
    .poll(() =>
      p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await p.screenshot({
    path: `test-results/browser-relay-${info.project.name}-${state}.png`,
    fullPage: true,
  });
}
async function paired(p: Page, pool: Pool) {
  const wallet = await openRemotePanel(p);
  await loginRemotePanel(p);
  const ownerId = (
    await pool.query(
      "SELECT id FROM remote_accounts WHERE lower(address)=lower($1)",
      [wallet.address],
    )
  ).rows[0].id as string;
  const devices = new RemoteDeviceStore(pool, 7200000),
    verifier = randomBytes(32).toString("base64url");
  const pair = await devices.begin(
    createHash("sha256").update(verifier).digest("base64url"),
  );
  await devices.approve(ownerId, pair.id, pair.approvalCode);
  const mac = await devices.redeem(pair.id, verifier, ownerId);
  await p.getByRole("button", { name: "Load devices", exact: true }).click();
  await expect(
    panel(p).getByRole("button", { name: "Review this Mac connection" }),
  ).toBeVisible();
  return { ownerId, mac };
}
async function confirm(p: Page) {
  await review(p).getByRole("checkbox").check();
  await review(p)
    .getByRole("button", { name: "Confirm connection approval", exact: true })
    .click();
}

test("shipped relay browser review keeps exact registration and acknowledgement across status refresh and narrow layout", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  await openRemotePanel(page);
  await loginRemotePanel(page);
  await openRecovery(page);
  await refreshRegistration(page);
  await registration(page)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await registration(page).getByRole("checkbox").check();
  await registration(page)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(registration(page).getByRole("status")).toContainText(
    "registered until",
  );
  await panel(page)
    .getByRole("button", { name: "Review this browser connection" })
    .click();
  await expect(review(page)).toContainText("reviewed browser registration");
  const submit = review(page).getByRole("button", {
    name: "Confirm connection approval",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await page.getByRole("button", { name: "Load devices", exact: true }).click();
  await expect(submit).toBeDisabled();
  await review(page).getByRole("checkbox").focus();
  await preview(page, info, "browser-review-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page, info, "browser-review-phone");
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "Browser permission saved",
  );
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(
    identityServer.events.filter(
      (p) => p === "/browser/relay/permission/enable",
    ),
  ).toHaveLength(1);
});

test("shipped Mac relay approval shows separate acceptance and revokes owner metadata without exposing the native secret", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const { mac } = await paired(page, identityServer.pool);
  await panel(page)
    .getByRole("button", { name: "Review this Mac connection" })
    .click();
  await expect(review(page)).toContainText(mac.deviceId);
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "Accept it separately",
  );
  const approval = panel(page).getByLabel("Approval ID to enter on this Mac", {
    exact: true,
  });
  await expect(approval).toHaveValue(/[a-f0-9-]{36}/);
  const id = await approval.inputValue();
  expect(
    (
      await identityServer.pool.query(
        "SELECT state,credential_hash FROM remote_private_relay_grants WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ state: "pending", credential_hash: null });
  await preview(page, info, "mac-pending");
  await panel(page)
    .getByRole("button", { name: "Load permission history" })
    .click();
  await panel(page)
    .getByRole("button", { name: "Review revoke permission" })
    .click();
  await review(page).getByRole("checkbox").check();
  await review(page)
    .getByRole("button", { name: "Confirm revoke permission" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Remote permission revoked",
  );
  await preview(page, info, "revoked");
  expect(await page.locator("body").textContent()).not.toContain(
    mac.credential,
  );
  expect(
    identityServer.events.some(
      (p) =>
        p.includes("/messages/") || p === "/device/relay/permission/accept",
    ),
  ).toBe(false);
});

test("shipped relay controls retain a lost operation for checking and cancel narrow reviews with Escape", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  await paired(page, identityServer.pool);
  await panel(page)
    .getByRole("button", { name: "Review this Mac connection" })
    .click();
  identityServer.drop("/browser/relay/mac/approve");
  await confirm(page);
  await expect(panel(page).getByRole("alert")).toContainText(
    "not been retried",
  );
  await preview(page, info, "uncertain");
  await panel(page)
    .getByRole("button", { name: "Check request result" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Original request checked",
  );
  expect(
    identityServer.events.filter((p) => p === "/browser/relay/mac/approve"),
  ).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel(page)
    .getByRole("button", { name: "Review this Mac connection" })
    .click();
  await expect(review(page)).toContainText("revokes the previous permission");
  await page.keyboard.press("Escape");
  await expect(review(page)).toHaveCount(0);
  await preview(page, info, "cancelled-phone");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(panel(page)).toBeHidden();
});
