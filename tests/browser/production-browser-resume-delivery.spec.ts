import { expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
const panel = (page: Page) =>
  page.getByRole("region", { name: "Mac resume requests", exact: true });
const button = (page: Page, name: string) =>
  panel(page).getByRole("button", { name, exact: true });
async function refresh(page: Page) {
  await button(page, "Refresh resume requests").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Saved requests loaded",
  );
}
async function confirm(page: Page) {
  const ack = panel(page).getByLabel(
    "I reviewed this task, Mac, model, expiry and action.",
    { exact: true },
  );
  await expect(ack).toBeVisible();
  await expect(ack).not.toBeChecked();
  await expect(button(page, "Confirm reviewed action")).toBeDisabled();
  await ack.check();
  await button(page, "Confirm reviewed action").click();
}
test("built resume flow retains an uncertain upload and records exact Mac acceptance", async ({
  page,
  context,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const offer = await f.mac.resumeOffer(
      f.native.record().permission!.expiresAt,
    );
    const grant = await page.evaluate(
      async (p) => {
        const api = window.browserPeersTest,
          status = await api.resumeStatus();
        const r = await api.resumePrepare({
          ...p,
          expectedRevision: status.revision,
        });
        return api.resumeApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      },
      { ...f.route, envelope: offer.envelope, expiresAt: Date.now() + 60000 },
    );
    await openRemotePanel(page, undefined, f.wallet);
    await loginRemotePanel(page);
    await openRecovery(page);
    await refreshRegistration(page);
    await keyControls(page)
      .getByRole("button", { name: "Refresh keys", exact: true })
      .click();
    await expect(keyControls(page).getByRole("status")).toContainText(
      "Key history loaded",
    );
    await refresh(page);
    await panel(page)
      .getByLabel("Saved permission for this task", { exact: true })
      .selectOption(grant.id);
    await button(page, "Review new resume request").click();
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Request saved",
    );
    expect(offer.task().status).toBe("paused");
    await button(page, "Review sending resume request").click();
    await expect(
      panel(page).getByRole("heading", {
        name: "Send resume request",
        exact: true,
      }),
    ).toBeVisible();
    await mkdir("test-results/browser-resume-delivery-ui", { recursive: true });
    await panel(page).screenshot({
      path: `test-results/browser-resume-delivery-ui/${info.project.name}-send-review.png`,
    });
    identityServer.loseResponse("/browser/relay/messages/submit");
    await confirm(page);
    await expect(panel(page).getByRole("alert")).toContainText(
      "result was not confirmed",
    );
    const record = f.native.record();
    const original = await f.native.relay.withTransport(
      { id: record.id, expectedRevision: record.revision },
      async (c) => (await c.poll({ after: null, limit: 1 })).items[0]!.envelope,
    );
    await refresh(page);
    await button(page, "Review sending resume request").click();
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Relay stored the request",
    );
    const repeated = await f.native.relay.withTransport(
      { id: record.id, expectedRevision: record.revision },
      async (c) => (await c.poll({ after: null, limit: 1 })).items[0]!.envelope,
    );
    expect(repeated).toEqual(original);
    // An unrelated offer is ahead of the receipt. Skipping it must not consume it.
    await f.native.relay.withTransport(
      { id: record.id, expectedRevision: record.revision },
      (c) => c.submit({ version: 1, envelope: offer.envelope }),
    );
    const local = await f.native.openLocalApi(),
      mac = await context.newPage();
    try {
      await mac.exposeFunction(
        "nativeTaskApi",
        (path: string, method?: string, body?: unknown) =>
          local.call(path, method, body),
      );
      await mac.goto("https://ai.bittrees.org/?mac-task-delivery-native");
      await mac
        .getByRole("button", { name: "Open Mac resume delivery", exact: true })
        .click();
      const panel = mac.getByRole("region", {
        name: "Mac resume delivery",
        exact: true,
      });
      await panel
        .getByRole("button", {
          name: "Refresh Mac resume delivery",
          exact: true,
        })
        .click();
      await expect(panel.getByRole("status")).toContainText(
        "Resume permissions and saved receipts loaded",
      );
      await panel
        .getByLabel("Connection for resume delivery", { exact: true })
        .selectOption(record.id);
      await panel
        .getByLabel("Permission for this resume", { exact: true })
        .selectOption(offer.data.permissionId);
      await panel
        .getByRole("button", {
          name: "Inspect queued resume request",
          exact: true,
        })
        .click();
      await expect(panel.getByRole("status")).toContainText(
        "Queued item inspected",
      );
      await panel
        .getByRole("button", {
          name: "Review accepting resume request",
          exact: true,
        })
        .click();
      const ack = panel.getByLabel(
        "I reviewed this task, permission and exact action.",
        { exact: true },
      );
      await expect(ack).toBeVisible();
      await expect(ack).not.toBeChecked();
      await panel.screenshot({
        path: `test-results/browser-resume-delivery-ui/${info.project.name}-mac-accept-review.png`,
      });
      await ack.check();
      await panel
        .getByRole("button", { name: "Confirm Mac resume action", exact: true })
        .click();
      await expect(panel.getByRole("status")).toContainText(
        "Mac accepted the resume request",
      );
      expect(offer.task().status).toBe("queued");
      await panel
        .getByRole("button", {
          name: "Review sending resume receipt",
          exact: true,
        })
        .click();
      await expect(ack).not.toBeChecked();
      await ack.check();
      await panel
        .getByRole("button", { name: "Confirm Mac resume action", exact: true })
        .click();
      await expect(panel.getByRole("status")).toContainText(
        "Relay stored the saved receipt",
      );
      await mac.setViewportSize({ width: 390, height: 844 });
      await panel.screenshot({
        path: `test-results/browser-resume-delivery-ui/${info.project.name}-mac-receipt-phone.png`,
      });
      expect(
        local.calls.every((c) => c.status === 200 || c.status === 204),
      ).toBe(true);
    } finally {
      await mac.close();
      await local.close();
    }
    await page.bringToFront();
    await button(page, "Check for Mac resume receipt").click();
    await expect(button(page, "Inspect next relay item")).toBeVisible();
    await button(page, "Inspect next relay item").click();
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Mac acceptance receipt saved",
    );
    await expect(panel(page)).toContainText("Task completion is not confirmed");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => panel(page).evaluate((n) => n.scrollWidth <= n.clientWidth))
      .toBe(true);
    await panel(page).screenshot({
      path: `test-results/browser-resume-delivery-ui/${info.project.name}-accepted-phone.png`,
    });
    expect(offer.task().revision).toBe(offer.data.taskRevision + 1);
  } finally {
    f.mac.close();
  }
});
