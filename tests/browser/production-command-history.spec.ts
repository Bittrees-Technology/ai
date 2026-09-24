import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import { RemoteDeviceStore } from "../../modules/remote/devices.js";
import { RemoteStatusStore } from "../../modules/remote/status-store.js";
import { RemoteCommandStore } from "../../modules/remote/commands.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Saved command history", exact: true });
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
  await devices.approveControls(ownerId, mac.deviceId, mac.epoch);
  const control = await devices.enableControls(mac.credential);
  const taskId = randomUUID();
  await new RemoteStatusStore(pool, 86400000).publish(
    { ownerId, deviceId: mac.deviceId, epoch: mac.epoch },
    {
      sequence: 1,
      items: [
        {
          id: taskId,
          deviceId: mac.deviceId,
          revision: 2,
          status: "running",
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  );
  await p.getByRole("button", { name: "Load devices", exact: true }).click();
  await p
    .getByRole("button", { name: "View shared statuses", exact: true })
    .click();
  await expect(
    p.getByRole("button", { name: "Review pause", exact: true }),
  ).toBeEnabled();
  return { ownerId, mac, taskId, control, devices };
}
async function send(p: Page) {
  await p.getByRole("button", { name: "Review pause", exact: true }).click();
  await p
    .getByRole("button", { name: "Confirm this command", exact: true })
    .click();
}
async function load(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Refresh saved commands", exact: true })
    .click();
  await expect(panel(p).getByRole("status")).toContainText("history loaded");
}
async function preview(p: Page, info: TestInfo, state: string) {
  await expect
    .poll(() =>
      p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await p.screenshot({
    path: `test-results/browser-command-history-${info.project.name}-${state}.png`,
    fullPage: true,
  });
}

test("shipped command history recovers a lost submission after reload, checks without resending and exports/deletes only local metadata", async ({
  page,
  identityServer,
}, info) => {
  const { ownerId, mac, control, taskId } = await paired(
    page,
    identityServer.pool,
  );
  identityServer.loseResponse("/browser/commands");
  await send(page);
  await expect(page.locator("#error")).not.toBeEmpty();
  const rows = (
    await identityServer.pool.query(
      "SELECT * FROM remote_commands WHERE device_id=$1",
      [mac.deviceId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  const id = rows[0].id;
  await page.reload();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
  await load(page);
  await expect(panel(page)).toContainText(id);
  await expect(panel(page)).toContainText("No server outcome is saved");
  await preview(page, info, "uncertain-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page, info, "uncertain-phone");
  const calls = identityServer.events.filter(
    (p) => p === "/browser/commands",
  ).length;
  await new RemoteCommandStore(identityServer.pool, 86400000).acknowledge(
    {
      ownerId,
      deviceId: mac.deviceId,
      epoch: control.epoch,
      controlId: control.controlId,
    },
    {
      id,
      deviceId: mac.deviceId,
      outcome: "applied",
      completedAt: new Date().toISOString(),
    },
  );
  await panel(page)
    .getByRole("button", { name: "Check saved receipt", exact: true })
    .click();
  await expect(panel(page)).toContainText("Last server outcome: applied");
  await expect(
    panel(page).getByRole("button", {
      name: "Review retrying original command",
    }),
  ).toBeDisabled();
  expect(
    identityServer.events.filter((p) => p === "/browser/commands"),
  ).toHaveLength(calls);
  await panel(page)
    .getByRole("button", { name: "Review command history export" })
    .click();
  await expect(panel(page).getByRole("checkbox")).not.toBeChecked();
  await expect(
    panel(page).getByRole("button", {
      name: "Export reviewed command history",
    }),
  ).toBeDisabled();
  await panel(page).getByRole("checkbox").check();
  const downloadEvent = page.waitForEvent("download");
  await panel(page)
    .getByRole("button", { name: "Export reviewed command history" })
    .click();
  const download = await downloadEvent;
  const value = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(value.ownerId).toBe(ownerId);
  expect(value.entries).toHaveLength(1);
  expect(value.entries[0].command).toMatchObject({
    id,
    taskId,
    deviceId: mac.deviceId,
    expectedRevision: 2,
  });
  expect(value.entries[0].observation.value.receipt.outcome).toBe("applied");
  expect(JSON.stringify(value)).not.toMatch(
    /token|credential|prompt|privateKey|authority/,
  );
  await load(page);
  await panel(page)
    .getByRole("button", { name: "Review command history deletion" })
    .click();
  await expect(panel(page)).toContainText("does not cancel commands");
  await preview(page, info, "delete-phone");
  await page.setViewportSize({ width: 1280, height: 900 });
  await preview(page, info, "delete-desktop");
  await panel(page).getByRole("checkbox").check();
  await panel(page)
    .getByRole("button", { name: "Delete reviewed command history" })
    .click();
  await expect(panel(page)).toContainText("No commands are saved");
  expect(
    (
      await identityServer.pool.query(
        "SELECT outcome FROM remote_commands WHERE id=$1",
        [id],
      )
    ).rows[0].outcome,
  ).toBe("applied");
  expect(
    identityServer.events.filter((p) => p === "/browser/commands"),
  ).toHaveLength(calls);
  await page.reload();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
  await load(page);
  await expect(panel(page)).toContainText("No commands are saved");
});

test("shipped command history retries only the exact original intent and clears review on escape or changed permission", async ({
  page,
  identityServer,
}, info) => {
  const { mac, ownerId, devices } = await paired(page, identityServer.pool);
  identityServer.loseResponse("/browser/commands");
  await send(page);
  await expect(page.locator("#error")).not.toBeEmpty();
  const before = (
    await identityServer.pool.query(
      "SELECT * FROM remote_commands WHERE device_id=$1",
      [mac.deviceId],
    )
  ).rows;
  await load(page);
  await panel(page)
    .getByRole("button", { name: "Review retrying original command" })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Retry reviewed command" }),
  ).toBeDisabled();
  await preview(page, info, "retry-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page, info, "retry-phone");
  await page.keyboard.press("Escape");
  await expect(
    panel(page).getByRole("button", { name: "Retry reviewed command" }),
  ).toBeHidden();
  expect(
    identityServer.events.filter((p) => p === "/browser/commands"),
  ).toHaveLength(1);
  await load(page);
  await panel(page)
    .getByRole("button", { name: "Review retrying original command" })
    .click();
  await panel(page).getByRole("checkbox").check();
  await panel(page)
    .getByRole("button", { name: "Retry reviewed command" })
    .click();
  await expect(panel(page)).toContainText("Last server outcome: pending");
  expect(
    identityServer.events.filter((p) => p === "/browser/commands"),
  ).toHaveLength(2);
  expect(
    (
      await identityServer.pool.query(
        "SELECT * FROM remote_commands WHERE device_id=$1",
        [mac.deviceId],
      )
    ).rows,
  ).toEqual(before);
  // Real permission change after review prevents delivery despite local history.
  await panel(page)
    .getByRole("button", { name: "Review retrying original command" })
    .click();
  await devices.disableControls(ownerId, mac.deviceId);
  await panel(page).getByRole("checkbox").check();
  await panel(page)
    .getByRole("button", { name: "Retry reviewed command" })
    .click();
  await expect(panel(page).getByRole("alert")).not.toBeEmpty();
  await load(page);
  await panel(page)
    .getByRole("button", { name: "Check saved receipt", exact: true })
    .click();
  await expect(panel(page)).toContainText("Last server outcome: cancelled");
  await expect(
    panel(page).getByRole("button", {
      name: "Review retrying original command",
    }),
  ).toBeDisabled();
});

test("shipped command history fences a late receipt on wallet change and never dispatches without available journal storage", async ({
  page,
  identityServer,
}) => {
  const { mac } = await paired(page, identityServer.pool);
  await send(page);
  await expect(page.locator("#notice")).toContainText("Command outcome saved");
  await load(page);
  identityServer.hold("/browser/commands/receipt");
  await panel(page)
    .getByRole("button", { name: "Check saved receipt", exact: true })
    .click();
  await expect.poll(identityServer.held).toBe(true);
  await page.evaluate(() => window.remoteAuthWalletTest.change());
  identityServer.release();
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(panel(page)).toBeHidden();
  await loginRemotePanel(page);
  await load(page);
  await expect(panel(page)).toContainText("Last server outcome: pending");
  const count = identityServer.events.filter(
    (p) => p === "/browser/commands",
  ).length;
  // Simulate a newer installed journal version. The real provider must fail
  // closed before HTTP dispatch; no browser APIs or transport are mocked.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-command-history", 2);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
  });
  await page.getByRole("button", { name: "Load devices", exact: true }).click();
  await page
    .getByRole("button", { name: "View shared statuses", exact: true })
    .click();
  await send(page);
  await expect(page.locator("#error")).not.toBeEmpty();
  expect(
    identityServer.events.filter((p) => p === "/browser/commands"),
  ).toHaveLength(count);
  expect(
    (
      await identityServer.pool.query(
        "SELECT id FROM remote_commands WHERE device_id=$1",
        [mac.deviceId],
      )
    ).rows,
  ).toHaveLength(1);
});
