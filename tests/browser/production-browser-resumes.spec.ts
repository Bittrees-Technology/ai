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
    name: "Browser resume permissions",
    exact: true,
  });
const ackName =
  "I reviewed this exact task, task version, model, Mac and expiry.";
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
    return { ...f, offer: await f.mac.resumeOffer() };
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
async function refresh(page: Page) {
  await panel(page)
    .getByRole("button", {
      name: "Refresh resume permissions",
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
      .getByLabel("Encrypted resume offer from your Mac", { exact: true })
      .fill(JSON.stringify(f.offer.envelope));
  await panel(page)
    .getByLabel("Mac for task resume", { exact: true })
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
  await panel(page)
    .getByLabel("Resume permission duration", { exact: true })
    .selectOption("1");
  await panel(page)
    .getByRole("button", { name: "Review resume permission", exact: true })
    .click();
  await expect(
    panel(page).getByRole("heading", {
      name: "Review browser resume permission",
      exact: true,
    }),
  ).toBeFocused();
}
async function confirm(page: Page, name = "Save resume permission") {
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
      name: "Export resume permission history",
      exact: true,
    })
    .click();
  return JSON.parse(await readFile((await (await downloaded).path())!, "utf8"));
}
async function preview(page: Page, engine: string, state: string) {
  await mkdir("test-results/browser-resume-ui", { recursive: true });
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
      path: `test-results/browser-resume-ui/${engine}-${label}-${state}.png`,
    });
  }
}
test("built browser reviews an actual Mac resume offer and retains exact permission with offline revoke and deletion", async ({
  page,
  identityServer,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await ready(page);
  try {
    const before = f.offer.task();
    const macGrants = f.offer.grants();
    await open(page, f, true);
    expect((await exported(page)).history.grants).toHaveLength(0);
    await preview(page, info.project.name, "opened");
    await review(page);
    for (const text of [
      f.offer.data.taskId,
      f.offer.data.modelDigest,
      f.offer.data.permissionId,
      f.mac.binding.deviceId,
    ])
      await expect(panel(page)).toContainText(text);
    await expect(panel(page)).toContainText(
      `Task version ${f.offer.data.taskRevision}`,
    );
    await preview(page, info.project.name, "review");
    await confirm(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser resume permission saved. No task was resumed.",
    );
    expect(f.offer.task()).toEqual(before);
    expect(f.offer.grants()).toEqual(macGrants);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    const data = await exported(page);
    expect(data.format).toBe("bittrees-browser-resume-permissions-v1");
    expect(data.history.grants).toHaveLength(1);
    const grant = data.history.grants[0];
    expect(grant.choices).toMatchObject({
      peerId: f.mac.binding.deviceId,
      permissionId: f.offer.data.permissionId,
      taskId: f.offer.data.taskId,
      taskRevision: f.offer.data.taskRevision,
      modelDigest: f.offer.data.modelDigest,
    });
    expect(grant.choices.expiresAt).toBeLessThan(f.offer.data.expiresAt);
    expect(JSON.stringify(data)).not.toMatch(
      /privateKey|ciphertext|Synthetic paused task/,
    );
    await preview(page, info.project.name, "history");
    identityServer.offline(true);
    await panel(page)
      .getByRole("button", { name: "Review revoking permission", exact: true })
      .click();
    await confirm(page, "Revoke browser permission");
    await expect(panel(page).getByRole("status")).toContainText(
      "Permission revoked on this browser only",
    );
    await refresh(page);
    expect((await exported(page)).history.grants[0].revoked).toBe(true);
    await panel(page)
      .getByRole("button", {
        name: "Review resume permission deletion",
        exact: true,
      })
      .click();
    await confirm(page, "Delete browser permissions");
    await expect(panel(page).getByRole("status")).toContainText(
      "Browser permissions deleted",
    );
    await refresh(page);
    const cleared = await exported(page);
    expect(cleared.history.grants).toHaveLength(0);
    expect(cleared.history.needsFreshDevice).toBe(true);
    expect(f.offer.task()).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("built browser rejects changed resume offers and clears task selection before review", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await refresh(page);
    await panel(page)
      .getByLabel("Mac for task resume", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    const bad = structuredClone(f.offer.envelope);
    bad.ciphertext =
      (bad.ciphertext[0] === "A" ? "B" : "A") + bad.ciphertext.slice(1);
    await panel(page)
      .getByLabel("Encrypted resume offer from your Mac", { exact: true })
      .fill(JSON.stringify(bad));
    await panel(page)
      .getByRole("button", { name: "Open selected Mac offer", exact: true })
      .click();
    await expect(panel(page).getByRole("alert")).toContainText(
      "offer or access could not be verified",
    );
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
    await open(page, f);
    await panel(page)
      .getByLabel("Mac for task resume", { exact: true })
      .selectOption("");
    await expect(
      panel(page).getByRole("button", {
        name: "Review resume permission",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(panel(page)).not.toContainText(f.offer.data.taskId);
    await open(page, f);
    await panel(page)
      .getByLabel("Choose an encrypted offer file", { exact: true })
      .setInputFiles({
        name: "bad.json",
        mimeType: "application/json",
        buffer: Buffer.from("{}"),
      });
    await expect(panel(page).getByRole("alert")).toContainText(
      "not a supported encrypted offer",
    );
    await expect(
      panel(page).getByRole("button", {
        name: "Review resume permission",
        exact: true,
      }),
    ).toBeDisabled();
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
    expect(f.offer.task().status).toBe("paused");
  } finally {
    f.mac.close();
  }
});

test("built browser closes resume reviews on Escape, focus loss and another permission panel", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await open(page, f);
    await review(page);
    await panel(page).getByLabel(ackName, { exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(
      panel(page).getByRole("button", {
        name: "Save resume permission",
        exact: true,
      }),
    ).toBeHidden();
    await open(page, f);
    await review(page);
    await expect(
      panel(page).getByLabel(ackName, { exact: true }),
    ).not.toBeChecked();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(
      panel(page).getByRole("button", {
        name: "Save resume permission",
        exact: true,
      }),
    ).toBeHidden();
    await open(page, f);
    await review(page);
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
    await expect(
      panel(page).getByRole("button", {
        name: "Save resume permission",
        exact: true,
      }),
    ).toBeHidden();
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
    expect(f.offer.task().status).toBe("paused");
  } finally {
    f.mac.close();
  }
});

test("built browser expires an acknowledged resume review without saving permission", async ({
  page,
}) => {
  await page.clock.install();
  const f = await ready(page);
  try {
    await open(page, f);
    await review(page);
    await panel(page).getByLabel(ackName, { exact: true }).check();
    await page.clock.fastForward(120001);
    await expect(
      panel(page).getByRole("button", {
        name: "Save resume permission",
        exact: true,
      }),
    ).toBeHidden();
    await expect(panel(page).getByRole("status")).toContainText("expired");
    await refresh(page);
    expect((await exported(page)).history.grants).toHaveLength(0);
    expect(f.offer.task().status).toBe("paused");
  } finally {
    f.mac.close();
  }
});

test("built browser discards a late resume inspection after leaving its review window", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await refresh(page);
    await panel(page)
      .getByLabel("Mac for task resume", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    await panel(page)
      .getByLabel("Encrypted resume offer from your Mac", { exact: true })
      .fill(JSON.stringify(f.offer.envelope));
    const lateResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/browser/registration/identity",
    );
    identityServer.hold();
    await panel(page)
      .getByRole("button", { name: "Open selected Mac offer", exact: true })
      .click();
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    identityServer.release();
    await (await lateResponse).finished();
    await expect(panel(page).getByRole("status")).toContainText(
      "leaving this window",
    );
    await refresh(page);
    await expect(panel(page)).not.toContainText(f.offer.data.taskId);
    await expect(
      panel(page).getByRole("button", {
        name: "Review resume permission",
        exact: true,
      }),
    ).toBeDisabled();
    expect((await exported(page)).history.grants).toHaveLength(0);
    expect(f.offer.task().status).toBe("paused");
  } finally {
    identityServer.release();
    f.mac.close();
  }
});
