import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const peerId = "00000000-0000-4000-8000-000000000011";
const conversationId = "00000000-0000-4000-8000-000000000012";
const permissionId = "00000000-0000-4000-8000-000000000013";
const reviewId = "00000000-0000-4000-8000-000000000014";
const directions = {
  messagesToMac: true,
  messagesToBrowser: false,
  questionsToBrowser: false,
  answersToMac: false,
};
async function fixture(page: Page) {
  const status = {
    available: true,
    canSetup: true,
    revision: 0,
    keyRevision: 1,
    peerRevision: 1,
    needsFreshPairing: false,
    hasSelectedKey: true,
    peers: [{ peerId, keyEpoch: 1, fingerprint: "a".repeat(64) }],
    grants: [] as any[],
  };
  let prepared: any,
    hold = false,
    pending: Route | undefined,
    lose = false;
  const confirms: any[] = [],
    reviews: any[] = [];
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: any = { items: [] };
    if (path === "/v1/inboxes")
      json = { items: [{ id: "personal", ownerType: "user" }] };
    if (path === "/v1/inboxes/personal/conversations")
      json = {
        items: [
          {
            id: conversationId,
            preview: "Selected synthetic thread",
            updatedAt: 1,
          },
        ],
        nextCursor: null,
      };
    if (path === "/v1/messages")
      json = {
        items:
          url.searchParams.get("conversationId") === conversationId &&
          Number(url.searchParams.get("after") ?? 0) < 1
            ? [
                {
                  id: "message",
                  sequence: 1,
                  createdAt: Date.now(),
                  receipts: [],
                  input: {
                    conversationId,
                    recipientInboxId: "personal",
                    type: "notification",
                    content: "Synthetic local message",
                  },
                },
              ]
            : [],
      };
    if (path === "/v1/private-conversation-permissions") json = status;
    if (path === "/v1/private-conversation-permissions/review") {
      const body = route.request().postDataJSON();
      reviews.push(body);
      prepared = {
        id: reviewId,
        action: body.action,
        expiresAt: Date.now() + 300000,
        peerId,
        permissionId: body.action === "revoke" ? permissionId : null,
        fingerprint: "a".repeat(64),
        binding: { ownerId: "owner", deviceId: "mac" },
        choices:
          body.action === "revoke"
            ? status.grants[0].choices
            : {
                conversationId: body.conversationId,
                inboxId: body.inboxId,
                peerId,
                peerKeyEpoch: 1,
                permissions: body.permissions,
                expiresAt: Date.now() + body.minutes * 60000,
              },
      };
      if (hold) {
        hold = false;
        pending = route;
        return;
      }
      json = prepared;
    }
    if (path === "/v1/private-conversation-permissions/confirm") {
      confirms.push(route.request().postDataJSON());
      status.revision++;
      status.grants = [
        {
          id: permissionId,
          choices: prepared.choices,
          state: prepared.action === "grant" ? "saved" : "revoked",
        },
      ];
      if (lose) {
        lose = false;
        return route.abort("failed");
      }
      json = status;
    }
    await route.fulfill({ json });
  });
  await page.goto("/?inbox-task-review");
  await page
    .getByRole("button", { name: "Selected synthetic thread", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Conversation sharing permissions",
    exact: true,
  });
  await expect(panel).toBeVisible();
  return {
    panel,
    status,
    reviews,
    confirms,
    hold: () => {
      hold = true;
    },
    held: () => !!pending,
    release: async () => {
      const r = pending!;
      pending = undefined;
      await r.fulfill({ json: prepared });
    },
    lose: () => {
      lose = true;
    },
  };
}
async function choose(page: Page) {
  const panel = page.getByRole("region", {
    name: "Conversation sharing permissions",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Refresh conversation choices" })
    .click();
  await panel
    .getByLabel("Paired browser", { exact: true })
    .selectOption(peerId);
  await panel
    .getByRole("checkbox", {
      name: "Messages from this browser to the Mac",
      exact: true,
    })
    .check();
  await panel
    .getByRole("button", { name: "Review conversation access", exact: true })
    .click();
}
async function shot(page: Page, project: string, name: string) {
  for (const label of await page.locator(".conversation-choice").all()) {
    const input = await label.locator("input").boundingBox(),
      text = await label.locator("span").boundingBox();
    expect(input).not.toBeNull();
    expect(text).not.toBeNull();
    expect(input!.x + input!.width).toBeLessThanOrEqual(text!.x);
    expect(Math.abs(input!.y - text!.y)).toBeLessThan(8);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mkdir("test-results/conversation-permission-ui", { recursive: true });
  await page.screenshot({
    path: `test-results/conversation-permission-ui/${project}-${name}.png`,
    fullPage: true,
  });
}
test("selected Inbox thread reviews exact conversation access, confirms once and can revoke offline", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.panel
    .getByRole("button", { name: "Refresh conversation choices" })
    .click();
  for (const checkbox of await f.panel.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await expect(
    f.panel.getByRole("button", {
      name: "Review conversation access",
      exact: true,
    }),
  ).toBeDisabled();
  await choose(page);
  await expect(
    f.panel.getByRole("button", {
      name: "Save conversation access",
      exact: true,
    }),
  ).toBeDisabled();
  expect(f.reviews[0]).toEqual({
    action: "grant",
    expectedRevision: 0,
    expectedKeyRevision: 1,
    expectedPeerRevision: 1,
    peerId,
    peerKeyEpoch: 1,
    conversationId,
    inboxId: "personal",
    minutes: 15,
    permissions: directions,
  });
  await shot(page, info.project.name, "review-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, info.project.name, "review-phone");
  await f.panel
    .getByRole("checkbox", {
      name: "I reviewed this conversation, browser and access.",
    })
    .check();
  await f.panel
    .getByRole("button", { name: "Save conversation access", exact: true })
    .click();
  await expect(f.panel.getByRole("status")).toContainText(
    "No messages were sent",
  );
  expect(f.confirms).toEqual([
    { reviewId, confirmed: true, acknowledged: true },
  ]);
  f.status.canSetup = false;
  await f.panel
    .getByRole("button", { name: "Refresh conversation choices" })
    .click();
  await f.panel
    .getByRole("button", { name: "Review revoking conversation access" })
    .click();
  await shot(page, info.project.name, "revoke-phone");
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, info.project.name, "revoke-desktop");
  await f.panel
    .getByRole("checkbox", {
      name: "I reviewed this conversation, browser and access.",
    })
    .check();
  await f.panel
    .getByRole("button", { name: "Revoke conversation access", exact: true })
    .click();
  await expect(
    f.panel.getByText("Revoked locally", { exact: true }),
  ).toBeVisible();
  expect(f.confirms).toHaveLength(2);
});
test("blur and thread changes discard late conversation reviews, and a lost confirmation is reconciled without automatic retry", async ({
  page,
}) => {
  const f = await fixture(page);
  f.hold();
  await choose(page);
  await expect.poll(f.held).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.release();
  await expect(
    f.panel.getByRole("button", {
      name: "Save conversation access",
      exact: true,
    }),
  ).toHaveCount(0);
  await choose(page);
  await page.keyboard.press("Escape");
  await expect(f.panel.getByRole("checkbox")).toHaveCount(0);
  await choose(page);
  f.lose();
  await f.panel
    .getByRole("checkbox", {
      name: "I reviewed this conversation, browser and access.",
    })
    .check();
  await f.panel
    .getByRole("button", { name: "Save conversation access", exact: true })
    .click();
  await expect(f.panel.getByRole("alert")).toContainText("No automatic retry");
  expect(f.confirms).toHaveLength(1);
  await f.panel
    .getByRole("button", { name: "Refresh conversation choices" })
    .click();
  await expect(
    f.panel.getByText("Choices saved; connection not checked", { exact: true }),
  ).toBeVisible();
  expect(f.confirms).toHaveLength(1);
  await choose(page);
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save conversation access", exact: true }),
  ).toHaveCount(0);
});
