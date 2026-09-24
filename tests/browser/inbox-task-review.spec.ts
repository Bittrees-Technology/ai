import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const msg = {
  id: "question",
  sequence: 1,
  createdAt: Date.now(),
  receipts: [],
  input: {
    conversationId: "thread",
    recipientInboxId: "personal",
    requestId: "task",
    content: "SYNTHETIC_SOURCE_MESSAGE",
    replyExpected: true,
  },
};
async function fixture(page: Page) {
  let denied = false,
    hold = false,
    pending: Route | undefined;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = { items: [] };
    if (url.pathname === "/v1/messages/question") {
      if (hold) {
        hold = false;
        pending = route;
        return;
      }
      return route.fulfill({
        status: denied ? 403 : 200,
        json: denied ? { error: "SOURCE_DENIED" } : msg,
      });
    }
    if (url.pathname === "/v1/inboxes")
      json = { items: [{ id: "personal", ownerType: "user" }] };
    if (url.pathname === "/v1/inboxes/personal/conversations")
      json = {
        items: [
          { id: "thread", preview: "Synthetic conversation", updatedAt: 1 },
        ],
        nextCursor: null,
      };
    if (
      url.pathname === "/v1/messages" &&
      url.searchParams.get("conversationId") === "thread" &&
      url.searchParams.get("after") === "0"
    )
      json = {
        items: [
          msg,
          {
            ...msg,
            id: "ordinary",
            sequence: 2,
            input: {
              ...msg.input,
              requestId: undefined,
              replyExpected: false,
              content: "Ordinary local message",
            },
          },
        ],
      };
    await route.fulfill({ json });
  });
  await page.goto("/?inbox-task-review");
  await page
    .getByRole("button", { name: "Synthetic conversation", exact: true })
    .click();
  await expect(
    page.getByText("Ordinary local message", { exact: true }),
  ).toBeVisible();
  return {
    deny: () => {
      denied = true;
    },
    hold: () => {
      hold = true;
    },
    pending: () => pending,
    release: async () => {
      const r = pending;
      pending = undefined;
      await r!.fulfill({ json: msg });
    },
  };
}
async function shot(page: Page, project: string, name: string) {
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: `test-results/inbox-task-review-${project}-${name}.png`,
    fullPage: true,
  });
}
test("task-linked history opens freshly and denied source access clears text", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await shot(page, info.project.name, "hidden");
  await page
    .getByRole("button", { name: "Open task-linked message", exact: true })
    .click();
  await expect(
    page.getByText(msg.input.content, { exact: true }),
  ).toBeVisible();
  f.deny();
  await page
    .getByRole("button", { name: "Open task-linked message", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await shot(page, info.project.name, "denied");
});
test("blur and conversation change suppress held message reads", async ({
  page,
}, info) => {
  const f = await fixture(page);
  f.hold();
  await page
    .getByRole("button", { name: "Open task-linked message", exact: true })
    .click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.release();
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await shot(page, info.project.name, "blurred");
  f.hold();
  await page
    .getByRole("button", { name: "Open task-linked message", exact: true })
    .click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await f.release();
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Open task-linked message", exact: true }),
  ).toHaveCount(0);
  await shot(page, info.project.name, "changed");
});
test("narrow task message review clears on Escape and display expiry", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  await fixture(page);
  const open = page.getByRole("button", {
    name: "Open task-linked message",
    exact: true,
  });
  await open.click();
  await expect(
    page.getByText(msg.input.content, { exact: true }),
  ).toBeVisible();
  await shot(page, info.project.name, "phone-open");
  await page.keyboard.press("Escape");
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await open.click();
  await expect(
    page.getByText(msg.input.content, { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(15250);
  await expect(page.getByText(msg.input.content, { exact: true })).toHaveCount(
    0,
  );
  await shot(page, info.project.name, "phone-expired");
});
