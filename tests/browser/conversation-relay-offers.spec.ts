import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { macConversationRelayFixture } from "../helpers/mac-conversation-relay.js";
import { localApi } from "../../apps/companion/http.js";
async function fixture(page: Page) {
  const g = await macConversationRelayFixture(),
    server = createServer();
  const token = randomBytes(32).toString("base64url");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: g.e.store,
      owner: g.e.owner,
      token,
      port,
      privateKeys: g.e.controls,
      privateRelay: g.relay,
    }),
  );
  let downloads = 0;
  const errors: string[] = [];
  page.on("download", () => downloads++);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const response = await fetch(
      `http://127.0.0.1:${port}${url.pathname}${url.search}`,
      {
        method: request.method(),
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        ...(request.postData() ? { body: request.postData()! } : {}),
      },
    );
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  await page.goto("/?inbox-task-review");
  await page.getByRole("button", { name: /PRIVATE_NEVER_IN_OFFER/ }).click();
  await page
    .getByRole("button", { name: "Refresh conversation choices", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Conversation sharing offers",
    exact: true,
  });
  const refresh = async () => {
    await panel
      .getByRole("button", { name: "Refresh saved offers", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Refresh offer connections", exact: true })
      .click();
    await panel
      .getByLabel("Offer connection", { exact: true })
      .selectOption(g.input().connection.id);
  };
  await refresh();
  return {
    ...g,
    panel,
    refresh,
    downloads: () => downloads,
    errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      g.close();
    },
  };
}
async function shot(page: Page, browser: string, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mkdir("test-results/conversation-relay-offer-ui", { recursive: true });
  await page.screenshot({
    path: `test-results/conversation-relay-offer-ui/${browser}-${name}.png`,
    fullPage: true,
  });
}
test("Mac offer upload reviews actual recipient and confirms storage without granting browser consent", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    await g.panel
      .getByRole("button", {
        name: "Review encrypted offer upload",
        exact: true,
      })
      .click();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    const upload = g.panel.getByRole("button", {
      name: "Upload encrypted offer",
      exact: true,
    });
    await expect(upload).toBeDisabled();
    expect(g.outgoing.size).toBe(0);
    await shot(page, info.project.name, "review-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, info.project.name, "review-phone");
    await g.panel.getByRole("checkbox").check();
    await upload.click();
    await expect(g.panel.getByRole("status")).toContainText(
      "browser must still review",
    );
    await expect(g.panel).toContainText(
      "Server storage confirmed for upload attempt 1",
    );
    expect(g.outgoing.size).toBe(1);
    expect([...g.outgoing.values()][0]!.envelope).toEqual(g.offer.envelope);
    expect(g.e.controls.conversationPermissionStatus().revision).toBe(
      g.consent.revision,
    );
    await shot(page, info.project.name, "stored-phone");
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, info.project.name, "stored-desktop");
    expect(g.downloads()).toBe(0);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("lost upload reply keeps uncertain history and a reviewed retry reuses one encrypted offer", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    g.control.loseSubmit = true;
    await g.panel
      .getByRole("button", {
        name: "Review encrypted offer upload",
        exact: true,
      })
      .click();
    await g.panel.getByRole("checkbox").check();
    await g.panel
      .getByRole("button", { name: "Upload encrypted offer", exact: true })
      .click();
    await expect(g.panel.getByRole("alert")).toContainText(
      "No automatic retry",
    );
    expect(g.statusOffer().relayAttempts).toBe(1);
    expect(g.outgoing.size).toBe(1);
    await g.refresh();
    await expect(g.panel).toContainText("Upload attempt 1 is unconfirmed");
    await shot(page, info.project.name, "uncertain-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, info.project.name, "uncertain-phone");
    g.control.loseSubmit = false;
    await g.panel
      .getByRole("button", {
        name: "Review encrypted offer upload",
        exact: true,
      })
      .click();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    await g.panel.getByRole("checkbox").check();
    await g.panel
      .getByRole("button", { name: "Upload encrypted offer", exact: true })
      .click();
    await expect(g.panel).toContainText(
      "Server storage confirmed for upload attempt 2",
    );
    expect(g.outgoing.size).toBe(1);
    expect(g.downloads()).toBe(0);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("leaving the conversation discards the upload review and does not send", async ({
  page,
}) => {
  const g = await fixture(page);
  try {
    await g.panel
      .getByRole("button", {
        name: "Review encrypted offer upload",
        exact: true,
      })
      .click();
    await g.panel.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await expect(g.panel).toHaveCount(0);
    expect(g.outgoing.size).toBe(0);
    expect(g.statusOffer().relayAttempts).toBe(0);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("revoked relay recipient blocks a fresh upload review without recording an attempt", async ({
  page,
}) => {
  const g = await fixture(page);
  try {
    g.control.denyRecipient = true;
    await g.panel
      .getByRole("button", {
        name: "Review encrypted offer upload",
        exact: true,
      })
      .click();
    await expect(g.panel.getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    await expect(
      g.panel.getByRole("button", {
        name: "Upload encrypted offer",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(g.outgoing.size).toBe(0);
    expect(g.statusOffer().relayAttempts).toBe(0);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
