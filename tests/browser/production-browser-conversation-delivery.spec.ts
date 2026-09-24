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
  page.getByRole("region", { name: "Saved conversations", exact: true });
const button = (page: Page, name: string) =>
  panel(page).getByRole("button", { name, exact: true });
const ack = "I reviewed this conversation and this exact action.";
type Fixture = Awaited<ReturnType<typeof ready>>;
async function openBuilt(page: Page, f: Fixture, reload = false) {
  if (reload) {
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
  } else {
    await openRemotePanel(page, undefined, f.wallet);
    await loginRemotePanel(page);
  }
  await openRecovery(page);
  await refreshRegistration(page);
  await keyControls(page)
    .getByRole("button", { name: "Refresh keys", exact: true })
    .click();
  await expect(keyControls(page).getByRole("status")).toContainText(
    "Key history loaded",
  );
  await refresh(page);
}
async function setup(page: Page, f: Fixture, questions = false) {
  const offer = await f.mac.conversationOffer(
    f.native.record().permission!.expiresAt,
    { questions },
  );
  const grant = await page.evaluate(
    async (data) => {
      const api = window.browserPeersTest,
        status = await api.conversationStatus();
      const review = await api.conversationPrepare({
        ...data,
        expectedRevision: status.revision,
      });
      return api.conversationApprove({
        reviewId: review.reviewId,
        expectedRevision: review.expectedRevision,
        confirmed: true,
        acknowledged: true,
      });
    },
    {
      ...f.route,
      envelope: offer.envelope,
      permissions: offer.data.permissions,
      expiresAt: offer.data.expiresAt,
    },
  );
  await openBuilt(page, f);
  return { offer, grant };
}
async function refresh(page: Page) {
  await button(page, "Refresh saved conversations").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Saved conversation list loaded",
  );
}
async function confirm(page: Page, name: string) {
  await expect(button(page, name)).toBeDisabled();
  await expect(panel(page).getByLabel(ack, { exact: true })).not.toBeChecked();
  await panel(page).getByLabel(ack, { exact: true }).check();
  await button(page, name).click();
}
async function openMessage(page: Page, name = "Open message to mac 1") {
  await button(page, name).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Selected message opened",
  );
}
async function saveMessage(page: Page, text = "SYNTHETIC_REVIEWED_DELIVERY") {
  await panel(page).getByLabel("Message text", { exact: true }).fill(text);
  await button(page, "Review saving message").click();
  await confirm(page, "Save reviewed message");
  await expect(panel(page).getByRole("status")).toContainText(
    "Message saved locally",
  );
  await refresh(page);
  await openMessage(page);
}
async function prepareCopy(
  page: Page,
  name = "Open message to mac 1",
  info?: TestInfo,
) {
  await button(page, "Review preparing delivery").click();
  if (info) await preview(page, info, "prepare-copy-review");
  await confirm(page, "Prepare reviewed delivery");
  await expect(panel(page).getByRole("status")).toContainText(
    "Delivery copy prepared locally",
  );
  await refresh(page);
  await openMessage(page, name);
}
async function upload(f: Fixture, envelope: unknown) {
  const r = f.native.record();
  return f.native.relay.withTransport(
    { id: r.id, expectedRevision: r.revision },
    (c) => c.submit({ version: 1, envelope }),
  );
}
async function incomingOriginal(f: Fixture) {
  const r = f.native.record();
  return f.native.relay.withTransport(
    { id: r.id, expectedRevision: r.revision },
    async (c) => (await c.poll({ after: null, limit: 1 })).items[0]!.envelope,
  );
}
async function receiveMac(f: Fixture, permissionId: string) {
  const api = await f.native.openLocalApi();
  try {
    const r = f.native.record(),
      query = {
        connection: { id: r.id, expectedRevision: r.revision },
        after: null,
        confirmed: true,
      };
    const inspected = await api.call(
      "/v1/private-relay/inspect-conversation",
      "POST",
      query,
    );
    return await api.call("/v1/private-relay/check-conversation", "POST", {
      ...query,
      selection: inspected.item.selection,
      target: { action: "receive", permissionId },
    });
  } finally {
    await api.close();
  }
}
async function inspect(page: Page, next = false) {
  await button(
    page,
    next ? "Inspect next queued item" : "Inspect incoming delivery",
  ).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Incoming delivery inspected",
  );
}
async function receive(page: Page, info?: TestInfo) {
  await button(page, "Review receiving queued message").click();
  if (info) await preview(page, info, "receive-review");
  await confirm(page, "Receive reviewed message");
}
async function preview(page: Page, info: TestInfo, state: string) {
  const reviews: Record<string, string> = {
    "prepare-copy-review": "Prepare this delivery copy",
    "send-review": "Send this message to your Mac",
    "receipt-review": "Check storage receipt for this copy",
    "receive-review": "Receive this queued message",
    "send-storage-receipt": "Send this storage receipt",
    "offline-stop-review": "Stop delivery of this copy",
    "answer-review": "Save this answer for your Mac",
  };
  // A click starts async authority checks. Wait for the actual review instead
  // of photographing an intermediate loading frame on a slower browser.
  await expect(button(page, "Refresh saved conversations")).toBeEnabled();
  if (reviews[state]) {
    await expect(
      panel(page).getByRole("heading", { name: reviews[state], exact: true }),
    ).toBeVisible();
    await expect(panel(page).getByLabel(ack, { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("status")).toContainText(
      "Review this exact action",
    );
  }
  await mkdir("test-results/browser-conversation-delivery-ui", {
    recursive: true,
  });
  for (const [layout, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const check = panel(page).getByLabel(ack, { exact: true });
    if (await check.isVisible()) {
      const a = await check.boundingBox(),
        b = await panel(page).locator(".browser-keys-check span").boundingBox();
      expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
    }
    await panel(page).screenshot({
      path: `test-results/browser-conversation-delivery-ui/${info.project.name}-${state}-${layout}.png`,
    });
  }
}

test("built conversation delivery reviews the original message, recovers a lost upload after reload and reconciles its exact Mac storage receipt", async ({
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
    const selected = await setup(page, f);
    await saveMessage(page);
    await expect(button(page, "Review sending to Mac")).toBeDisabled();
    await prepareCopy(page, undefined, info);
    await button(page, "Review sending to Mac").click();
    await expect(panel(page)).toContainText("SYNTHETIC_REVIEWED_DELIVERY");
    await expect(panel(page)).toContainText(f.mac.binding.deviceId);
    await preview(page, info, "send-review");
    identityServer.loseResponse("/browser/relay/messages/submit");
    await confirm(page, "Send reviewed message");
    await expect(panel(page).getByRole("alert")).toContainText(
      "result was not confirmed",
    );
    const original = await incomingOriginal(f);
    await openBuilt(page, f, true);
    await expect(panel(page)).toContainText("1 upload attempt");
    await expect(panel(page)).toContainText("Upload result unconfirmed");
    await preview(page, info, "uncertain-history");
    await openMessage(page);
    await button(page, "Review sending to Mac").click();
    await confirm(page, "Send reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Server storage response saved",
    );
    expect(await incomingOriginal(f)).toEqual(original);
    await receiveMac(f, selected.offer.data.scope.permissionId);
    await upload(f, await selected.offer.receipt(original));
    await refresh(page);
    await inspect(page);
    await panel(page)
      .getByLabel("Saved copy for storage receipt", { exact: true })
      .selectOption({ label: "Message to Mac 1" });
    await button(page, "Review queued storage receipt").click();
    await expect(panel(page)).toContainText("SYNTHETIC_REVIEWED_DELIVERY");
    await preview(page, info, "receipt-review");
    await confirm(page, "Check reviewed storage receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Mac storage receipt authenticated",
    );
    await refresh(page);
    await expect(panel(page)).toContainText(
      "Mac storage receipt authenticated",
    );
    await expect(panel(page)).toContainText("2 upload attempts");
    await preview(page, info, "accepted-history");
  } finally {
    f.mac.close();
  }
});

test("built incoming conversation controls navigate past a missing parent and separately send the stored receipt", async ({
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
    const selected = await setup(page, f),
      parent = await selected.offer.message("SYNTHETIC_PARENT_UI"),
      reply = await selected.offer.message(
        "SYNTHETIC_REPLY_UI",
        parent.header.operationId,
      );
    await upload(f, reply);
    await upload(f, parent);
    await inspect(page);
    await preview(page, info, "incoming-queue");
    await receive(page, info);
    await expect(panel(page).getByRole("alert")).toContainText(
      "earlier message first",
    );
    await refresh(page);
    await inspect(page);
    await inspect(page, true);
    await receive(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Message authenticated and saved",
    );
    await refresh(page);
    await inspect(page);
    await receive(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Message authenticated and saved",
    );
    await refresh(page);
    await openMessage(page, "Open message from mac 2");
    await expect(panel(page)).toContainText("SYNTHETIC_REPLY_UI");
    await prepareCopy(page, "Open message from mac 2");
    await button(page, "Review sending storage receipt").click();
    await preview(page, info, "send-storage-receipt");
    await confirm(page, "Send reviewed storage receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Server storage response saved",
    );
    const receipt = await incomingOriginal(f);
    expect(receipt.header.operationId).toBe(reply.header.operationId);
    expect(receipt).not.toEqual(reply);
  } finally {
    f.mac.close();
  }
});

test("built conversation delivery history and reviewed stopping work offline after reload without revealing text", async ({
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
    await setup(page, f);
    await saveMessage(page, "SYNTHETIC_OFFLINE_RETAINED");
    await prepareCopy(page);
    await openBuilt(page, f, true);
    identityServer.offline(true);
    identityServer.events.length = 0;
    await refresh(page);
    await expect(panel(page)).not.toContainText("SYNTHETIC_OFFLINE_RETAINED");
    await button(page, "Review stopping delivery 1").click();
    await preview(page, info, "offline-stop-review");
    await confirm(page, "Stop reviewed delivery");
    await expect(panel(page).getByRole("status")).toContainText(
      "Further delivery stopped locally",
    );
    await refresh(page);
    await expect(panel(page)).toContainText("Further uploads stopped locally");
    expect(identityServer.events).toEqual([]);
    await preview(page, info, "offline-stopped-history");
    identityServer.offline(false);
    await openMessage(page);
    await expect(panel(page)).toContainText("SYNTHETIC_OFFLINE_RETAINED");
    await expect(button(page, "Review sending to Mac")).toBeDisabled();
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("built conversation delivery closes reviews across focus and panel changes and hides a late upload response", async ({
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
    await setup(page, f);
    await saveMessage(page);
    await prepareCopy(page);
    await button(page, "Review sending to Mac").click();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(panel(page).getByRole("status")).toContainText(
      "Private text hidden",
    );
    await expect(panel(page)).not.toContainText("SYNTHETIC_REVIEWED_DELIVERY");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refresh(page);
    await openMessage(page);
    await button(page, "Review sending to Mac").click();
    await page
      .getByRole("region", {
        name: "Browser conversation permissions",
        exact: true,
      })
      .getByRole("button", {
        name: "Refresh conversation permissions",
        exact: true,
      })
      .click();
    await expect(button(page, "Send reviewed message")).toBeHidden();
    await refresh(page);
    await openMessage(page);
    await button(page, "Review sending to Mac").click();
    identityServer.hold("/browser/relay/messages/submit");
    await confirm(page, "Send reviewed message");
    await expect.poll(identityServer.held).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    identityServer.release();
    await expect(panel(page).getByRole("status")).toContainText(
      "Private text hidden",
    );
    await expect(panel(page).getByRole("status")).not.toContainText(
      "Server storage response saved",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refresh(page);
    await expect(panel(page)).toContainText("1 upload attempt");
    await preview(page, info, "cancelled-upload-history");
  } finally {
    identityServer.release();
    f.mac.close();
  }
});

test("built conversation receipt review binds the exact outgoing copy and leaves a mismatched receipt queued", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await setup(page, f);
    await saveMessage(page, "SYNTHETIC_FIRST_COPY");
    await prepareCopy(page);
    await button(page, "Review sending to Mac").click();
    await confirm(page, "Send reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Server storage response saved",
    );
    const first = await incomingOriginal(f);
    await receiveMac(f, selected.offer.data.scope.permissionId);
    await refresh(page);
    await saveMessage(page, "SYNTHETIC_SECOND_COPY");
    // saveMessage opens the first item; explicitly choose the second before sealing.
    await openMessage(page, "Open message to mac 2");
    await prepareCopy(page, "Open message to mac 2");
    await upload(f, await selected.offer.receipt(first));
    await refresh(page);
    await inspect(page);
    await panel(page)
      .getByLabel("Saved copy for storage receipt", { exact: true })
      .selectOption({ label: "Message to Mac 2" });
    await button(page, "Review queued storage receipt").click();
    await expect(panel(page)).toContainText("SYNTHETIC_SECOND_COPY");
    await confirm(page, "Check reviewed storage receipt");
    await expect(panel(page).getByRole("alert")).toContainText(
      "result was not confirmed",
    );
    await refresh(page);
    await inspect(page);
    await panel(page)
      .getByLabel("Saved copy for storage receipt", { exact: true })
      .selectOption({ label: "Message to Mac 1" });
    await button(page, "Review queued storage receipt").click();
    await confirm(page, "Check reviewed storage receipt");
    await expect(panel(page).getByRole("status")).toContainText(
      "Mac storage receipt authenticated",
    );
  } finally {
    f.mac.close();
  }
});

test("built conversation delivery carries a real worker question and reviewed answer through the relay into one Mac continuation", async ({
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
    const selected = await setup(page, f, true),
      question = await selected.offer.question();
    await upload(f, question.envelope);
    await inspect(page);
    await receive(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Message authenticated and saved",
    );
    await refresh(page);
    await openMessage(page, "Open question from mac 1");
    await button(page, "Answer this question").click();
    await panel(page)
      .getByLabel("Message text", { exact: true })
      .fill("Lisbon");
    await button(page, "Review saving answer").click();
    await preview(page, info, "answer-review");
    await confirm(page, "Save reviewed answer");
    await expect(panel(page).getByRole("status")).toContainText(
      "Message saved locally",
    );
    expect(question.task().status).toBe("awaiting_input");
    await refresh(page);
    await openMessage(page, "Open answer to mac 2");
    await prepareCopy(page, "Open answer to mac 2");
    await button(page, "Review sending to Mac").click();
    await confirm(page, "Send reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Server storage response saved",
    );
    await receiveMac(f, selected.offer.data.scope.permissionId);
    expect(question.task().status).toBe("queued");
    await question.run();
    expect(question.task().status).toBe("completed");
    expect(question.calls()).toBe(3);
    await question.run();
    expect(question.calls()).toBe(3);
  } finally {
    f.mac.close();
  }
});
