import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setup,
  completeBrowserCheck,
  checks,
  peers,
} from "./support/browser-mac-ui.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
import { mkdir, readFile } from "node:fs/promises";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Browser task permissions", exact: true });
const sendName = "Allow this browser to send tasks to this Mac",
  resultName = "Allow this browser to read results from this Mac",
  ackName = "I reviewed this Mac and these exact permission choices.";
async function refresh(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Refresh permissions", exact: true })
    .click();
  await expect(panel(p).getByRole("status")).toContainText(
    "Permission history loaded",
  );
}
async function choose(p: Page, id: string, results = false) {
  await refresh(p);
  await expect(
    panel(p).getByLabel(sendName, { exact: true }),
  ).not.toBeChecked();
  await expect(
    panel(p).getByLabel(resultName, { exact: true }),
  ).not.toBeChecked();
  await expect(
    panel(p).getByRole("button", {
      name: "Review task permission",
      exact: true,
    }),
  ).toBeDisabled();
  await panel(p)
    .getByLabel("Mac for task permission", { exact: true })
    .selectOption(id);
  await panel(p).getByLabel(sendName, { exact: true }).check();
  if (results) await panel(p).getByLabel(resultName, { exact: true }).check();
}
async function review(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Review task permission", exact: true })
    .click();
  await expect(
    panel(p).getByRole("heading", {
      name: "Review browser task permission",
      exact: true,
    }),
  ).toBeFocused();
}
async function confirm(p: Page, name = "Save browser permission") {
  const b = panel(p).getByRole("button", { name, exact: true });
  await expect(b).toBeDisabled();
  await expect(panel(p).getByLabel(ackName, { exact: true })).not.toBeChecked();
  await panel(p).getByLabel(ackName, { exact: true }).check();
  await b.click();
}
async function ready(p: Page) {
  const f = await setup(p);
  try {
    await completeBrowserCheck(p, f);
    return f;
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
async function exported(p: Page) {
  const event = p.waitForEvent("download");
  await panel(p)
    .getByRole("button", { name: "Export permission history", exact: true })
    .click();
  return JSON.parse(await readFile((await (await event).path())!, "utf8"));
}
async function preview(p: Page, engine: string, state: string) {
  await mkdir("test-results", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1100],
    ["phone", 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel(p).screenshot({
      path: `test-results/browser-permission-controls-${engine}-${name}-${state}.png`,
    });
  }
}

test("built permission controls require independent choices, preserve them across reload and export metadata only", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates.*directive/i.test(m.text()))
      violations.push(m.text());
  });
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId, false);
    await panel(page)
      .getByLabel("Permission duration", { exact: true })
      .selectOption("24");
    await review(page);
    await expect(panel(page)).toContainText("Read results: off");
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser permission saved. No task was sent.",
    );
    expect(f.mac.consent.list().grants).toEqual([]);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    const data = await exported(page);
    expect(data.format).toBe("bittrees-browser-task-permissions-v1");
    expect(data.history.grants).toHaveLength(1);
    expect(data.history.grants[0].choices).toMatchObject({
      sendTasks: true,
      receiveResults: false,
      peerId: f.mac.binding.deviceId,
      expiresAt: f.binding.expiresAt,
    });
    expect(JSON.stringify(data)).not.toMatch(
      /privateHandle|privateKey|ciphertext|prompt|modelProfileId/,
    );
    expect(violations).toEqual([]);
  } finally {
    f.mac.close();
  }
});
test("a reviewed Mac identity alone cannot enable task permission", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await choose(page, f.mac.binding.deviceId);
    await panel(page)
      .getByRole("button", { name: "Review task permission", exact: true })
      .click();
    await expect(panel(page).getByRole("alert")).toContainText(
      "completed check",
    );
    await expect(
      panel(page).getByRole("button", {
        name: "Save browser permission",
        exact: true,
      }),
    ).toBeHidden();
    await refresh(page);
    expect((await exported(page)).history.grants).toEqual([]);
  } finally {
    f.mac.close();
  }
});
test("the original review choices survive unrelated status rendering and hidden form changes cannot substitute choices", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId, false);
    await review(page);
    await page
      .getByRole("button", { name: "Load devices", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Load devices", exact: true }),
    ).toBeEnabled();
    await panel(page)
      .getByLabel(resultName, { exact: true })
      .evaluate((n) => {
        (n as HTMLInputElement).checked = true;
        n.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser permission saved",
    );
    await refresh(page);
    expect(
      (await exported(page)).history.grants[0].choices.receiveResults,
    ).toBe(false);
  } finally {
    f.mac.close();
  }
});
for (const action of [
  "blur",
  "escape",
  "wallet",
  "keys",
  "peers",
  "checks",
  "deadline",
  "rollback",
] as const)
  test(`permission review cancels for ${action} without saving a grant`, async ({
    page,
  }) => {
    if (action === "deadline" || action === "rollback")
      await page.clock.install();
    const f = await ready(page);
    try {
      await choose(page, f.mac.binding.deviceId, true);
      await review(page);
      await panel(page).getByLabel(ackName, { exact: true }).check();
      if (action === "blur")
        await page.evaluate(() => window.remoteAuthWalletTest.blur());
      if (action === "escape") await page.keyboard.press("Escape");
      if (action === "wallet")
        await page.evaluate(() => window.remoteAuthWalletTest.change());
      if (action === "keys")
        await keyControls(page)
          .getByRole("button", { name: "Refresh keys", exact: true })
          .click();
      if (action === "peers")
        await peers(page)
          .getByRole("button", { name: "Refresh saved devices", exact: true })
          .click();
      if (action === "checks")
        await checks(page)
          .getByRole("button", { name: "Refresh device checks", exact: true })
          .click();
      if (action === "deadline") await page.clock.runFor(120001);
      if (action === "rollback") {
        await page.clock.setFixedTime(new Date(Date.now() - 60000));
        await page.clock.runFor(600);
      }
      await expect(
        panel(page).getByRole("button", {
          name: "Save browser permission",
          exact: true,
        }),
      ).toBeHidden();
      if (action !== "wallet") {
        await page.bringToFront();
        await refresh(page);
        expect((await exported(page)).history.grants).toEqual([]);
      } else
        await expect(page.locator("#account")).toHaveText("Not signed in.");
    } finally {
      f.mac.close();
    }
  });
test("leaving during held permission preparation discards a late result", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId);
    identityServer.hold();
    await panel(page)
      .getByRole("button", { name: "Review task permission", exact: true })
      .click();
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.remoteAuthWalletTest.blur());
    identityServer.release();
    await expect(panel(page).getByRole("status")).toContainText(
      "after leaving",
    );
    await expect(
      panel(page).getByRole("button", {
        name: "Save browser permission",
        exact: true,
      }),
    ).toBeHidden();
    await page.bringToFront();
    await refresh(page);
    expect((await exported(page)).history.grants).toEqual([]);
  } finally {
    identityServer.release();
    f.mac.close();
  }
});
test("lost final permission verification exposes the saved outcome only after refresh and never repeats approval", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId, true);
    await review(page);
    identityServer.reject("/browser/registration/identity", 1);
    const before = identityServer.events.filter(
      (p) => p === "/browser/registration/identity",
    ).length;
    await confirm(page);
    await expect(panel(page).getByRole("alert")).toContainText(
      "failed response can follow a saved change",
    );
    await expect(
      panel(page).getByRole("button", {
        name: "Save browser permission",
        exact: true,
      }),
    ).toBeHidden();
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/registration/identity",
      ).length - before,
    ).toBe(2);
    await refresh(page);
    const data = await exported(page);
    expect(data.history.revision).toBe(1);
    expect(data.history.grants).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("offline permission revocation and deletion are distinct reviewed changes and same-browser reset is refused", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId, true);
    await review(page);
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser permission saved",
    );
    identityServer.offline(true);
    await refresh(page);
    await panel(page)
      .getByRole("button", { name: "Review revoking permission", exact: true })
      .click();
    await confirm(page, "Revoke browser permission");
    await expect(panel(page).getByRole("status")).toContainText(
      "revoked on this browser only",
    );
    await refresh(page);
    expect((await exported(page)).history.grants[0].revoked).toBe(true);
    await panel(page)
      .getByRole("button", { name: "Review permission deletion", exact: true })
      .click();
    await confirm(page, "Delete browser permissions");
    await expect(panel(page).getByRole("status")).toContainText(
      "permissions deleted",
    );
    await refresh(page);
    const deleted = await exported(page);
    expect(deleted.history.grants).toEqual([]);
    expect(deleted.history.needsFreshDevice).toBe(true);
    identityServer.offline(false);
    await panel(page)
      .getByRole("button", { name: "Review permission reset", exact: true })
      .click();
    await confirm(page, "Reset browser permissions");
    await expect(panel(page).getByRole("alert")).toContainText(
      "different browser registration",
    );
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});
test("permission choices, review and history remain readable at desktop and phone widths", async ({
  page,
}, info) => {
  const f = await ready(page);
  try {
    await choose(page, f.mac.binding.deviceId, true);
    await preview(page, info.project.name, "choices");
    await review(page);
    await preview(page, info.project.name, "review");
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser permission saved",
    );
    await refresh(page);
    await preview(page, info.project.name, "history");
  } finally {
    f.mac.close();
  }
});
for (const action of ["permission", "check", "server"] as const)
  test(`another tab's ${action} change prevents confirming the old browser permission review`, async ({
    page,
    context,
  }) => {
    const f = await ready(page),
      other = await context.newPage();
    try {
      await other.goto("https://ai.bittrees.org/?browser-peers");
      await other.waitForFunction(() => !!window.browserPeersTest);
      await other.evaluate(() => window.browserPeersTest.resume());
      await page.bringToFront();
      await choose(page, f.mac.binding.deviceId, true);
      await review(page);
      if (action === "permission") {
        const r = await other.evaluate(
          (choices) =>
            window.browserPeersTest.consentPrepare({
              expectedRevision: 0,
              choices,
            }),
          {
            peerId: f.mac.binding.deviceId,
            peerKeyEpoch: (await f.mac.keys.resolve()).proof.keyEpoch,
            sendTasks: true,
            receiveResults: false,
            expiresAt: Date.now() + 120000,
          },
        );
        await other.evaluate(
          (r) =>
            window.browserPeersTest.consentApprove({
              reviewId: r.reviewId,
              expectedRevision: r.expectedRevision,
              confirmed: true,
              acknowledged: true,
            }),
          r,
        );
      } else if (action === "check") {
        const c = await other.evaluate(() =>
          window.browserPeersTest.checkStatus(),
        );
        await other.evaluate(
          (expectedRevision) =>
            window.browserPeersTest.checkClear({
              expectedRevision,
              confirmed: true,
            }),
          c.revision,
        );
      } else
        await other.evaluate(
          (b) =>
            window.browserPeersTest.registerRevoke({
              deviceId: b.deviceId,
              credentialEpoch: b.credentialEpoch,
              confirmed: true,
            }),
          f.binding,
        );
      await confirm(page);
      await expect(panel(page).getByRole("alert")).toContainText(
        "Refresh permissions",
      );
      await expect(
        panel(page).getByRole("button", {
          name: "Save browser permission",
          exact: true,
        }),
      ).toBeHidden();
      await refresh(page);
      const data = await exported(page);
      expect(data.history.grants).toHaveLength(action === "permission" ? 1 : 0);
      expect(data.history.revision).toBe(action === "permission" ? 1 : 0);
      if (action === "permission")
        expect(data.history.grants[0].choices.receiveResults).toBe(false);
    } finally {
      await other.close();
      f.mac.close();
    }
  });
