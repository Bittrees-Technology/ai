import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
import { openRemotePanel } from "./support/remote-panel.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Browser private tasks", exact: true });
const reply = "Synthetic result from independently consented Mac task.";
const supplied =
  "SYNTHETIC_REVIEWED_PRIVATE_DELIVERY — summarize only this supplied text.";
async function refresh(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(panel(p).getByRole("status")).toContainText(
    "Task history loaded",
  );
}
async function open(p: Page, f: Awaited<ReturnType<typeof ready>>) {
  await openRemotePanel(p, undefined, f.wallet, true);
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
    path: `test-results/browser-relay-tasks-${info.project.name}-${state}.png`,
  });
}
async function check(p: Page) {
  await panel(p)
    .getByRole("button", {
      name: "Review checking for a Mac reply",
      exact: true,
    })
    .click();
  await confirm(p, "Check for Mac reply");
}
const row = (p: Page, id: string) =>
  panel(p)
    .getByRole("list", { name: "Saved browser tasks" })
    .getByRole("listitem")
    .filter({ hasText: id });
async function send(p: Page, id: string) {
  await row(p, id)
    .getByRole("button", { name: "Review sending this task", exact: true })
    .click();
  await confirm(p, "Send reviewed task");
}
test("shipped private task controls review exact preparation and delivery, then save and separately open a native result", async ({
  page,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await open(page, f);
    await panel(page)
      .getByLabel("Mac for this task", { exact: true })
      .selectOption(f.route.peerId);
    await panel(page)
      .getByLabel("What should your Mac work on?", { exact: true })
      .fill(supplied);
    await panel(page)
      .getByRole("button", {
        name: "Review task for private delivery",
        exact: true,
      })
      .click();
    await expect(
      panel(page).getByRole("heading", {
        name: "Review task for private delivery",
        exact: true,
      }),
    ).toBeFocused();
    await expect(panel(page)).toContainText(supplied);
    await expect(panel(page)).toContainText(f.route.peerId);
    await preview(page, info, "prepare");
    await page.setViewportSize({ width: 390, height: 844 });
    await preview(page, info, "prepare-phone");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(0);
    await confirm(page, "Save task for private delivery");
    await expect(panel(page).getByRole("status")).toContainText(
      "nothing was sent automatically",
    );
    const fresh = panel(page)
      .getByRole("list", { name: "Saved browser tasks" })
      .getByRole("listitem")
      .filter({ hasNotText: f.entry.id });
    await expect(fresh).toHaveCount(1);
    const id = (
      await fresh.getByText(/^Task [a-f0-9-]{36}$/).innerText()
    ).slice(5);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await row(page, id)
      .getByRole("button", { name: "Review sending this task", exact: true })
      .click();
    await expect(panel(page)).toContainText("task version");
    await preview(page, info, "send-review");
    await confirm(page, "Send reviewed task");
    await expect(panel(page).getByRole("status")).toContainText(
      "does not confirm Mac acceptance or task completion",
    );
    await expect(row(page, id)).toContainText("Prepared task");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(1);
    const admitted = await f.native.check();
    expect(f.native.task(admitted.received!.taskId).input.prompt).toBe(
      supplied,
    );
    await f.native.sendResponse(
      (await f.native.prepareResponse(id, "accepted")).id,
    );
    await check(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Authenticated Mac acceptance saved",
    );
    await expect(row(page, id)).toContainText("Accepted by your Mac");
    await expect(
      row(page, id).getByRole("button", {
        name: "Review opening this result",
        exact: true,
      }),
    ).toHaveCount(0);
    await f.mac.work();
    await f.native.sendResponse(
      (await f.native.prepareResponse(id, "result")).id,
    );
    await check(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Authenticated Mac result saved",
    );
    await expect(panel(page)).not.toContainText(reply);
    await preview(page, info, "result-saved");
    await row(page, id)
      .getByRole("button", { name: "Review opening this result", exact: true })
      .click();
    await confirm(page, "Open reviewed task result");
    await expect(panel(page)).toContainText(reply);
    await preview(page, info, "result-open");
    await page.keyboard.press("Escape");
    await expect(panel(page)).not.toContainText(reply);
    expect(errors).toEqual([]);
  } finally {
    f.mac.close();
  }
});
test("shipped private task controls retain one submitted task after a lost reply and retry only after a fresh review", async ({
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
    identityServer.loseResponse("/browser/relay/messages/submit");
    await send(page, f.entry.id);
    await expect(panel(page).getByRole("alert")).toContainText(
      "this review cannot be retried",
    );
    await preview(page, info, "uncertain");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(1);
    await expect(
      panel(page).getByRole("button", {
        name: "Send reviewed task",
        exact: true,
      }),
    ).toBeHidden();
    await refresh(page);
    await send(page, f.entry.id);
    await expect(panel(page).getByRole("status")).toContainText(
      "original message was already recorded",
    );
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(2);
    const rows = (
      await identityServer.pool.query(
        "SELECT message_id FROM remote_private_messages WHERE owner_id=$1",
        [f.registration.binding.ownerId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    await f.native.check();
    expect(f.native.tasks()).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("shipped reply checking cancels hidden delivery and requires fresh review without exposing result text", async ({
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
    await open(page, f);
    await send(page, f.entry.id);
    await expect(panel(page).getByRole("status")).toContainText(
      "stored for delivery",
    );
    await f.native.check();
    await f.mac.work();
    await f.native.sendResponse(
      (await f.native.prepareResponse(f.entry.id, "result")).id,
    );
    await panel(page)
      .getByRole("button", {
        name: "Review checking for a Mac reply",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    expect(
      identityServer.events.filter((p) => p === "/browser/relay/messages/poll"),
    ).toHaveLength(0);
    await refresh(page);
    identityServer.hold("/browser/relay/messages/poll");
    await check(page);
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    identityServer.release();
    await expect(panel(page)).not.toContainText(reply);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(0);
    await refresh(page);
    await check(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Authenticated Mac result saved",
    );
    await expect(panel(page)).not.toContainText(reply);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("shipped task controls omit connection delivery actions without explicit host policy", async ({
  page,
}) => {
  await openRemotePanel(page);
  await page
    .getByRole("button", { name: "Sign in with wallet", exact: true })
    .click();
  await openRecovery(page);
  await expect(
    panel(page).getByRole("button", {
      name: "Review task for private delivery",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", {
      name: "Review checking for a Mac reply",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", {
      name: "Review task content",
      exact: true,
    }),
  ).toBeVisible();
});
