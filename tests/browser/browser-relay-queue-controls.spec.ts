import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready, send } from "./support/relay-endpoints.js";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Browser private tasks", exact: true });
import { corrupt, stored } from "./support/relay-queue.js";
const queue = (p: Page) =>
  p.getByRole("region", { name: "Queued message recovery", exact: true });
const reply = "Synthetic result from independently consented Mac task.";
async function refresh(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(panel(p).getByRole("status")).toContainText(
    "Task history loaded",
  );
}
async function open(p: Page, f: Awaited<ReturnType<typeof ready>>) {
  // Shipped session coordination intentionally cleans up a cookie created by the
  // lower-level setup fixture. Sign in through its normal UI with the same owner.
  await openRemotePanel(p, undefined, f.wallet);
  await loginRemotePanel(p);
  await openRecovery(p);
  await refreshRegistration(p);
  await keyControls(p)
    .getByRole("button", { name: "Refresh keys", exact: true })
    .click();
  await expect(keyControls(p).getByRole("status")).toContainText(
    "Key history loaded",
  );
  await refresh(p);
}
async function confirm(p: Page, name: string) {
  const button = panel(p).getByRole("button", { name, exact: true });
  await expect(button).toBeDisabled();
  await expect(panel(p).getByRole("checkbox")).not.toBeChecked();
  await panel(p).getByRole("checkbox").check();
  await button.click();
}
async function preview(p: Page, info: TestInfo, state: string) {
  await expect
    .poll(() =>
      p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await panel(p).screenshot({
    path: `test-results/browser-queue-${info.project.name}-${state}.png`,
  });
}
async function inspect(p: Page) {
  await queue(p)
    .getByRole("button", { name: "Review inspecting the queue", exact: true })
    .click();
  await confirm(p, "Inspect reviewed queue");
  await expect(panel(p).getByRole("status")).toContainText(
    "Queued reply inspected",
  );
}
test("browser queue UI reaches a valid result behind an unreadable receipt without discarding it or opening result text", async ({
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
    await send(page, f);
    await f.native.check();
    const first = await f.native.sendResponse(
      (await f.native.prepareResponse(f.entry.id, "accepted")).id,
    );
    await corrupt(identityServer.pool, first.receipt.messageId);
    await f.mac.work();
    const sent = await f.native.sendResponse(
      (await f.native.prepareResponse(f.entry.id, "result")).id,
    );
    await open(page, f);
    await queue(page)
      .getByRole("button", { name: "Review inspecting the queue", exact: true })
      .click();
    expect(
      identityServer.events.filter((p) => p === "/browser/relay/messages/poll"),
    ).toHaveLength(0);
    await confirm(page, "Inspect reviewed queue");
    await expect(queue(page)).toContainText(first.receipt.messageId);
    await expect(queue(page)).toContainText("has not been authenticated");
    await preview(page, info, "inspected");
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .click();
    await expect(panel(page).getByText(/^Account /)).toContainText(
      first.receipt.messageId,
    );
    await preview(page, info, "selected-review");
    await confirm(page, "Check reviewed message");
    await expect(panel(page).getByRole("alert")).not.toBeEmpty();
    await refresh(page);
    await expect(queue(page)).toContainText(first.receipt.messageId);
    await queue(page)
      .getByRole("button", {
        name: "Review looking past this message",
        exact: true,
      })
      .click();
    await expect(panel(page)).toContainText(
      "does not delete it or mark it accepted",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await preview(page, info, "look-past-phone");
    await confirm(page, "Look past reviewed message");
    await expect(queue(page)).toContainText(sent.receipt.messageId);
    await preview(page, info, "later-phone");
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .click();
    await confirm(page, "Check reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Authenticated Mac result saved",
    );
    await expect(queue(page)).toContainText(
      "Authenticated reply saved locally",
    );
    await expect(
      queue(page).getByRole("button", {
        name: "Review checking this message",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(panel(page)).not.toContainText(reply);
    await page.setViewportSize({ width: 1280, height: 900 });
    await preview(page, info, "saved");
    await queue(page)
      .getByRole("button", {
        name: "Review looking past this message",
        exact: true,
      })
      .click();
    await confirm(page, "Look past reviewed message");
    await expect(queue(page)).toContainText("No queued message was found");
    await preview(page, info, "empty");
    const polls = identityServer.events.filter(
      (p) => p === "/browser/relay/messages/poll",
    ).length;
    await queue(page)
      .getByRole("button", { name: "Return to queue start", exact: true })
      .click();
    expect(
      identityServer.events.filter((p) => p === "/browser/relay/messages/poll"),
    ).toHaveLength(polls);
    await inspect(page);
    await expect(queue(page)).toContainText(first.receipt.messageId);
    expect(await stored(identityServer.pool, first.receipt.messageId)).toEqual({
      state: "stored",
      received_at: null,
      deleted_at: null,
    });
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(1);
    await panel(page)
      .getByRole("button", { name: "Review opening this result", exact: true })
      .click();
    await confirm(page, "Open reviewed task result");
    await expect(panel(page)).toContainText(reply);
  } finally {
    f.mac.close();
  }
});

test("browser queue UI clears a held inspection on blur and clears a selected position on Escape", async ({
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
    await send(page, f);
    await f.native.check();
    const sent = await f.native.sendResponse(
      (await f.native.prepareResponse(f.entry.id, "accepted")).id,
    );
    await open(page, f);
    identityServer.hold("/browser/relay/messages/poll");
    await queue(page)
      .getByRole("button", { name: "Review inspecting the queue", exact: true })
      .click();
    await confirm(page, "Inspect reviewed queue");
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    identityServer.release();
    await expect(queue(page)).toBeHidden();
    await refresh(page);
    await expect(queue(page)).toContainText("No queue position is selected");
    await inspect(page);
    await expect(queue(page)).toContainText(sent.receipt.messageId);
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    await expect(panel(page).getByRole("status")).toContainText(
      "Task review closed",
    );
    await refresh(page);
    await expect(queue(page)).toContainText("No queue position is selected");
    await inspect(page);
    // Deterministic same-turn cancellation while async local-history reads are
    // pending and the initiating control has already been hidden.
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .evaluate((b: HTMLButtonElement) => {
        b.click();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    await expect(panel(page).getByRole("status")).toContainText(
      "Task review closed",
    );
    await refresh(page);
    await expect(queue(page)).toContainText("No queue position is selected");
    expect(await stored(identityServer.pool, sent.receipt.messageId)).toEqual({
      state: "stored",
      received_at: null,
      deleted_at: null,
    });
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(0);
  } finally {
    identityServer.release();
    f.mac.close();
  }
});

test("browser queue UI rejects a changed reviewed message before authentication and requires a new inspection", async ({
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
    await send(page, f);
    await f.native.check();
    const sent = await f.native.sendResponse(
      (await f.native.prepareResponse(f.entry.id, "accepted")).id,
    );
    await open(page, f);
    await inspect(page);
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .click();
    await identityServer.pool.query(
      "UPDATE remote_private_messages SET stored_at=stored_at-1 WHERE message_id=$1",
      [sent.receipt.messageId],
    );
    await confirm(page, "Check reviewed message");
    await expect(panel(page).getByRole("alert")).toContainText(
      "changed during review",
    );
    await refresh(page);
    await expect(
      panel(page).getByRole("list", { name: "Saved browser tasks" }),
    ).toContainText("Prepared task");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(0);
    await inspect(page);
    await expect(queue(page)).toContainText("version 1");
    await queue(page)
      .getByRole("button", {
        name: "Review checking this message",
        exact: true,
      })
      .click();
    await confirm(page, "Check reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Authenticated Mac acceptance saved",
    );
  } finally {
    f.mac.close();
  }
});
