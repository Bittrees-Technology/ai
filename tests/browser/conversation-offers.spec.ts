import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { conversationOfferEndpoints } from "../helpers/conversation-offer-endpoints.js";
import { localApi } from "../../apps/companion/http.js";
async function fixture(page: Page) {
  const f = await conversationOfferEndpoints(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: f.e.store,
      owner: f.e.owner,
      token,
      port,
      privateKeys: f.e.controls,
    }),
  );
  let hold = false,
    lose = false,
    pending: (() => Promise<void>) | undefined;
  const calls: { path: string; body: any }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/v1/**", async (route) => {
    const path =
      new URL(route.request().url()).pathname +
      new URL(route.request().url()).search;
    const body = route.request().postData();
    calls.push({ path, body: body ? JSON.parse(body) : null });
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: route.request().method(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
    });
    const text = await response.text();
    const send = async () => {
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: text,
      });
    };
    if (hold && path === "/v1/private-conversation-offers/review") {
      hold = false;
      pending = send;
      return;
    }
    if (lose && path === "/v1/private-conversation-offers/confirm") {
      lose = false;
      return route.abort("failed");
    }
    await send();
  });
  await page.goto("/?inbox-task-review");
  await page.getByRole("button", { name: /SYNTHETIC_NEVER_IN_OFFER/ }).click();
  await page
    .getByRole("button", { name: "Refresh conversation choices", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Conversation sharing offers",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "Refresh saved offers", exact: true })
    .click();
  return {
    ...f,
    panel,
    calls,
    errors,
    hold: () => {
      hold = true;
    },
    held: () => !!pending,
    release: async () => {
      const p = pending!;
      pending = undefined;
      await p();
    },
    lose: () => {
      lose = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      f.close();
    },
  };
}
async function shot(page: Page, browser: string, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const panel = page.getByRole("region", {
    name: "Conversation sharing offers",
    exact: true,
  });
  for (const label of await panel.locator(".conversation-choice").all()) {
    const input = await label.locator("input").boundingBox(),
      text = await label.locator("span").boundingBox();
    expect(input).not.toBeNull();
    expect(text).not.toBeNull();
    expect(input!.x + input!.width).toBeLessThanOrEqual(text!.x);
    expect(Math.abs(input!.y - text!.y)).toBeLessThan(8);
  }
  await mkdir("test-results/conversation-offer-ui", { recursive: true });
  await page.screenshot({
    path: `test-results/conversation-offer-ui/${browser}-${name}.png`,
    fullPage: true,
  });
}
async function download(page: Page) {
  const panel = page.getByRole("region", {
    name: "Conversation sharing offers",
    exact: true,
  });
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(
    panel.getByRole("button", {
      name: "Download encrypted offer",
      exact: true,
    }),
  ).toBeDisabled();
  await panel.getByRole("checkbox").check();
  const downloaded = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Download encrypted offer", exact: true })
    .click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(
    /^bittrees-conversation-offer-.*\.json$/,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of (await file.createReadStream())!)
    chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
test("conversation offers use actual Mac review API, download original encrypted bytes and stop offline", async ({
  page,
}, info) => {
  const f = await fixture(page);
  try {
    await f.panel
      .getByRole("button", { name: "Review a new sharing offer", exact: true })
      .click();
    expect(f.e.controls.conversationOfferStatus().offers).toHaveLength(0);
    await expect(f.panel.getByRole("checkbox")).not.toBeChecked();
    await shot(page, info.project.name, "create-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, info.project.name, "create-phone");
    const wire = await download(page),
      opened = await f.open(wire);
    expect(opened.type).toBe("conversation.offer");
    expect(opened.scope.permissionId).toBe(f.input.permissionId);
    expect(JSON.stringify(opened)).not.toContain(f.conversationId);
    await f.panel
      .getByRole("button", { name: "Refresh saved offers", exact: true })
      .click();
    await f.panel
      .getByRole("button", { name: "Review saved offer download", exact: true })
      .click();
    await shot(page, info.project.name, "saved-phone");
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, info.project.name, "saved-desktop");
    expect(await download(page)).toEqual(wire);
    f.e.deny();
    await f.panel
      .getByRole("button", { name: "Refresh saved offers", exact: true })
      .click();
    await f.panel
      .getByRole("button", { name: "Review stopping this offer", exact: true })
      .click();
    await shot(page, info.project.name, "stop-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, info.project.name, "stop-phone");
    await f.panel.getByRole("checkbox").check();
    await f.panel
      .getByRole("button", { name: "Stop offer downloads", exact: true })
      .click();
    await expect(f.panel.getByRole("status")).toContainText(
      "Future downloads stopped",
    );
    expect(f.e.controls.conversationOfferStatus().offers[0]!.state).toBe(
      "stopped",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("discarded and lost offer responses cannot download automatically and saved history permits explicit recovery", async ({
  page,
}, info) => {
  const f = await fixture(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    f.hold();
    await f.panel
      .getByRole("button", { name: "Review a new sharing offer", exact: true })
      .click();
    await expect.poll(f.held).toBe(true);
    await page.keyboard.press("Escape");
    await f.release();
    await expect(f.panel).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Refresh conversation choices",
        exact: true,
      })
      .click();
    await f.panel
      .getByRole("button", { name: "Refresh saved offers", exact: true })
      .click();
    await f.panel
      .getByRole("button", { name: "Review a new sharing offer", exact: true })
      .click();
    f.lose();
    await f.panel.getByRole("checkbox").check();
    await f.panel
      .getByRole("button", { name: "Download encrypted offer", exact: true })
      .click();
    await expect(f.panel.getByRole("alert")).toContainText(
      "No automatic retry",
    );
    expect(downloads).toBe(0);
    expect(f.e.controls.conversationOfferStatus().offers).toHaveLength(1);
    await shot(page, info.project.name, "uncertain-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, info.project.name, "uncertain-phone");
    await f.panel
      .getByRole("button", { name: "Refresh saved offers", exact: true })
      .click();
    await f.panel
      .getByRole("button", { name: "Review saved offer download", exact: true })
      .click();
    await download(page);
    expect(downloads).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("changing selected conversation clears an outstanding offer review and download control", async ({
  page,
}) => {
  const f = await fixture(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    await f.panel
      .getByRole("button", { name: "Review a new sharing offer", exact: true })
      .click();
    await f.panel.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await expect(f.panel).toHaveCount(0);
    expect(downloads).toBe(0);
    expect(f.e.controls.conversationOfferStatus().offers).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
