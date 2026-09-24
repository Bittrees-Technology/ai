import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setup,
  completeBrowserCheck,
  refresh as refreshChecks,
  incoming,
  confirm as confirmCheck,
  output,
} from "./support/browser-mac-ui.js";
import {
  openRecovery,
  refreshRegistration,
} from "./support/browser-recovery-ui.js";
import { mkdir, readFile } from "node:fs/promises";
const panel = (p: Page) =>
  p.getByRole("region", {
    name: "Browser conversation permissions",
    exact: true,
  });
const messageName = "Allow messages from this browser to the Mac";
const ackName = "I reviewed this conversation, Mac and these exact choices.";
async function ready(page: Page) {
  const f = await setup(page);
  try {
    await completeBrowserCheck(page, f);
    const own = await f.macBegin(),
      wire = await f.mac.checks.delivery({ id: own.id, confirmed: true });
    await refreshChecks(page);
    await incoming(page, wire, "answer");
    await confirmCheck(page, "Answer Mac check");
    await f.mac.checks.complete({
      envelope: await output(page),
      confirmed: true,
    });
    return { ...f, offer: await f.mac.conversationOffer() };
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
async function refresh(page: Page) {
  await panel(page)
    .getByRole("button", {
      name: "Refresh conversation permissions",
      exact: true,
    })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Permission history loaded",
  );
}
async function open(
  page: Page,
  f: Awaited<ReturnType<typeof ready>>,
  file = false,
) {
  await refresh(page);
  if (file) {
    await panel(page)
      .getByLabel("Choose an encrypted offer file", { exact: true })
      .setInputFiles({
        name: "mac-offer.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(f.offer.envelope)),
      });
    await expect(panel(page).getByRole("status")).toContainText(
      "Offer file loaded",
    );
  } else
    await panel(page)
      .getByLabel("Encrypted conversation offer from your Mac", { exact: true })
      .fill(JSON.stringify(f.offer.envelope));
  await panel(page)
    .getByLabel("Mac for conversation access", { exact: true })
    .selectOption(f.mac.binding.deviceId);
  await panel(page)
    .getByRole("button", { name: "Open selected Mac offer", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Mac offer authenticated",
  );
  for (const box of await panel(page).getByRole("checkbox").all())
    if (await box.isVisible()) await expect(box).not.toBeChecked();
}
async function review(page: Page) {
  await panel(page).getByLabel(messageName, { exact: true }).check();
  await panel(page)
    .getByLabel("Conversation access duration", { exact: true })
    .selectOption("1");
  await panel(page)
    .getByRole("button", { name: "Review conversation access", exact: true })
    .click();
  await expect(
    panel(page).getByRole("heading", {
      name: "Review browser conversation access",
      exact: true,
    }),
  ).toBeFocused();
}
async function confirm(page: Page, name = "Save conversation access") {
  const button = panel(page).getByRole("button", { name, exact: true });
  await expect(button).toBeDisabled();
  await expect(
    panel(page).getByLabel(ackName, { exact: true }),
  ).not.toBeChecked();
  await panel(page).getByLabel(ackName, { exact: true }).check();
  await button.click();
}
async function exported(page: Page) {
  const downloaded = page.waitForEvent("download");
  await panel(page)
    .getByRole("button", {
      name: "Export conversation permission history",
      exact: true,
    })
    .click();
  return JSON.parse(await readFile((await (await downloaded).path())!, "utf8"));
}
async function preview(page: Page, engine: string, state: string) {
  await mkdir("test-results/browser-conversation-ui", { recursive: true });
  for (const [label, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const item of await panel(page).locator(".browser-keys-check").all()) {
      if (!(await item.isVisible())) continue;
      const input = await item.locator("input").boundingBox(),
        text = await item.locator("span").boundingBox();
      expect(input).not.toBeNull();
      expect(text).not.toBeNull();
      expect(input!.x + input!.width).toBeLessThanOrEqual(text!.x);
      expect(Math.abs(input!.y - text!.y)).toBeLessThan(8);
    }
    await panel(page).screenshot({
      path: `test-results/browser-conversation-ui/${engine}-${label}-${state}.png`,
    });
  }
}
test("built browser imports an actual Mac offer, narrows independent choices and retains reviewed offline maintenance", async ({
  page,
  identityServer,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await ready(page);
  try {
    await open(page, f, true);
    await expect(
      panel(page).getByRole("button", {
        name: "Review conversation access",
        exact: true,
      }),
    ).toBeDisabled();
    expect((await exported(page)).history.grants).toHaveLength(0);
    await preview(page, info.project.name, "opened");
    await review(page);
    await preview(page, info.project.name, "review");
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser conversation access saved. No messages were sent.",
    );
    expect(f.mac.consent.list().grants).toEqual([]);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    const data = await exported(page);
    expect(data.format).toBe("bittrees-browser-conversation-permissions-v1");
    expect(data.history.grants).toHaveLength(1);
    const grant = data.history.grants[0];
    expect(grant.choices.scope).toEqual(f.offer.data.scope);
    expect(grant.choices.permissions).toEqual({
      messagesToMac: true,
      messagesToBrowser: false,
      questionsToBrowser: false,
      answersToMac: false,
    });
    expect(grant.choices.expiresAt).toBeLessThan(f.offer.data.expiresAt);
    expect(JSON.stringify(data)).not.toMatch(
      /privateKey|ciphertext|SYNTHETIC|modelProfileId/,
    );
    await preview(page, info.project.name, "history");
    identityServer.offline(true);
    await panel(page)
      .getByRole("button", { name: "Review revoking permission", exact: true })
      .click();
    await preview(page, info.project.name, "revoke");
    await confirm(page, "Revoke browser permission");
    await expect(panel(page).getByRole("status")).toContainText(
      "Permission revoked on this browser only",
    );
    await refresh(page);
    expect((await exported(page)).history.grants[0].revoked).toBe(true);
    await panel(page)
      .getByRole("button", {
        name: "Review conversation permission deletion",
        exact: true,
      })
      .click();
    await preview(page, info.project.name, "delete");
    await confirm(page, "Delete browser permissions");
    await refresh(page);
    const cleared = await exported(page);
    expect(cleared.history.grants).toHaveLength(0);
    expect(cleared.history.needsFreshDevice).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});
test("changed and unauthenticated browser offers cannot retain selected choices or create conversation grants", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await refresh(page);
    await panel(page)
      .getByLabel("Mac for conversation access", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    const bad = structuredClone(f.offer.envelope);
    bad.ciphertext =
      (bad.ciphertext[0] === "A" ? "B" : "A") + bad.ciphertext.slice(1);
    await panel(page)
      .getByLabel("Encrypted conversation offer from your Mac", { exact: true })
      .fill(JSON.stringify(bad));
    await panel(page)
      .getByRole("button", { name: "Open selected Mac offer", exact: true })
      .click();
    await expect(panel(page).getByRole("alert")).toContainText("not confirmed");
    await open(page, f);
    await panel(page).getByLabel(messageName, { exact: true }).check();
    await panel(page)
      .getByLabel("Mac for conversation access", { exact: true })
      .selectOption("");
    await expect(
      panel(page).getByLabel(messageName, { exact: true }),
    ).not.toBeChecked();
    await expect(
      panel(page).getByRole("button", {
        name: "Review conversation access",
        exact: true,
      }),
    ).toBeDisabled();
    await open(page, f);
    await panel(page).getByLabel(messageName, { exact: true }).check();
    await panel(page)
      .getByLabel("Choose an encrypted offer file", { exact: true })
      .setInputFiles({
        name: "invalid.json",
        mimeType: "application/json",
        buffer: Buffer.from("{}"),
      });
    await expect(panel(page).getByRole("alert")).toContainText(
      "not a supported encrypted offer",
    );
    await expect(
      panel(page).getByLabel(messageName, { exact: true }),
    ).not.toBeChecked();
    await expect(
      panel(page).getByRole("button", {
        name: "Review conversation access",
        exact: true,
      }),
    ).toBeDisabled();
    await open(page, f);
    await review(page);
    await page.keyboard.press("Escape");
    await expect(
      panel(page).getByRole("button", {
        name: "Save conversation access",
        exact: true,
      }),
    ).toBeHidden();
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});
test("browser conversation review expiry and competing task-permission controls discard pending approval", async ({
  page,
}) => {
  await page.clock.install();
  const f = await ready(page);
  try {
    await open(page, f);
    await review(page);
    await panel(page).getByLabel(ackName, { exact: true }).check();
    await page
      .getByRole("region", { name: "Browser task permissions", exact: true })
      .getByRole("button", { name: "Refresh permissions", exact: true })
      .click();
    await expect(
      panel(page).getByRole("button", {
        name: "Save conversation access",
        exact: true,
      }),
    ).toBeHidden();
    await open(page, f);
    await review(page);
    await page.clock.fastForward(120001);
    await expect(
      panel(page).getByRole("button", {
        name: "Save conversation access",
        exact: true,
      }),
    ).toBeHidden();
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});
