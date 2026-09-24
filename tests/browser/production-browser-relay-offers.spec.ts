import { expect, type Page, type TestInfo } from "@playwright/test";
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
  page.getByRole("region", {
    name: "Browser conversation permissions",
    exact: true,
  });
const button = (page: Page, name: string) =>
  panel(page).getByRole("button", { name, exact: true });
const checkbox = "I reviewed this conversation, Mac and these exact choices.";
async function refresh(page: Page) {
  await button(page, "Refresh conversation permissions").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Permission history loaded",
  );
}
async function inspect(page: Page) {
  await button(page, "Inspect offer queue").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Queue inspected",
  );
}
async function confirm(page: Page, name: string) {
  await expect(button(page, name)).toBeDisabled();
  const ack = panel(page).getByLabel(checkbox, { exact: true });
  await expect(ack).not.toBeChecked();
  await ack.check();
  await button(page, name).click();
}
async function open(page: Page, f: Awaited<ReturnType<typeof ready>>) {
  const r = f.native.record(),
    offer = await f.mac.conversationOffer(r.permission!.expiresAt);
  await f.native.relay.withTransport(
    { id: r.id, expectedRevision: r.revision },
    (c) => c.submit({ version: 1, envelope: offer.envelope }),
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
  await inspect(page);
  return offer;
}
async function approve(page: Page, f: Awaited<ReturnType<typeof ready>>) {
  await panel(page)
    .getByLabel("Mac for conversation access", { exact: true })
    .selectOption(f.mac.binding.deviceId);
  await button(page, "Open queued Mac offer").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Mac offer authenticated",
  );
  for (const box of await panel(page).getByRole("checkbox").all())
    if (await box.isVisible()) await expect(box).not.toBeChecked();
  await panel(page)
    .getByLabel("Allow messages from this browser to the Mac", { exact: true })
    .check();
  await panel(page)
    .getByLabel("Conversation access duration", { exact: true })
    .selectOption("1");
  await button(page, "Review conversation access").click();
  await confirm(page, "Save conversation access");
  await expect(panel(page).getByRole("status")).toContainText(
    "Browser conversation access saved",
  );
  await refresh(page);
  await inspect(page);
}
async function preview(page: Page, info: TestInfo, state: string) {
  await mkdir("test-results/browser-relay-offer-ui", { recursive: true });
  for (const [layout, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel(page).screenshot({
      path: `test-results/browser-relay-offer-ui/${info.project.name}-${state}-${layout}.png`,
    });
  }
}
test("shipped browser offer queue separates inspection, consent and reviewed receipt on desktop and phone", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const offer = await open(page, f);
    await expect(panel(page)).toContainText(offer.envelope.header.messageId);
    await preview(page, info, "queue");
    await approve(page, f);
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
    await button(page, "Review acknowledging queued offer").click();
    await expect(
      panel(page).getByRole("heading", {
        name: "Acknowledge this offer’s receipt",
        exact: true,
      }),
    ).toBeFocused();
    await preview(page, info, "review");
    await confirm(page, "Acknowledge offer receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Offer receipt confirmed",
    );
    await refresh(page);
    await expect(panel(page)).toContainText(
      "Server receipt last confirmed: received",
    );
    await preview(page, info, "received");
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(1);
    await inspect(page);
    await expect(panel(page)).toContainText("No queued item here");
  } finally {
    f.mac.close();
  }
});
test("shipped browser receipt uncertainty retries only after fresh review and leaving the panel cancels approval", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    await open(page, f);
    await approve(page, f);
    await button(page, "Review acknowledging queued offer").click();
    identityServer.loseResponse("/browser/relay/messages/acknowledge");
    await confirm(page, "Acknowledge offer receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Response not confirmed",
    );
    await refresh(page);
    await expect(panel(page)).toContainText("Server receipt is unconfirmed");
    await preview(page, info, "uncertain");
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(1);
    await button(page, "Review retrying offer receipt").click();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(button(page, "Acknowledge offer receipt")).not.toBeVisible();
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(1);
    await refresh(page);
    await button(page, "Review retrying offer receipt").click();
    await confirm(page, "Acknowledge offer receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Offer receipt confirmed",
    );
    await refresh(page);
    await expect(panel(page)).toContainText("Receipt attempts: 2");
    await expect(panel(page)).toContainText(
      "Server receipt last confirmed: received",
    );
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});
