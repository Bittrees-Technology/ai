import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const taskId = "00000000-0000-4000-8000-000000000001",
  questionId = "00000000-0000-4000-8000-000000000002",
  replyId = "00000000-0000-4000-8000-000000000003";
async function fixture(page: Page, paused = false) {
  const question = {
    taskId,
    questionId,
    inboxId: "personal",
    conversationId: "thread",
    revision: 3,
    status: paused ? "paused" : "awaiting_input",
    question: "Which scope should the Mac companion use?",
    deadline: Date.now() + 600000,
    replyId: null as string | null,
    canAnswer: true,
  };
  const posts: any[] = [];
  let denied = false,
    loseResponse = false,
    hold = false,
    pending: Route | undefined;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = { items: [] };
    if (url.pathname.endsWith("/task-question")) {
      if (hold) {
        hold = false;
        pending = route;
        return;
      }
      return route.fulfill({
        status: denied ? 403 : 200,
        json: denied ? { error: "SOURCE_DENIED" } : question,
      });
    }
    if (url.pathname.endsWith("/task-answer")) {
      posts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      question.replyId = replyId;
      question.canAnswer = false;
      question.revision++;
      if (loseResponse) return route.abort("failed");
      question.status = paused ? "paused" : "queued";
      return route.fulfill({
        json: {
          taskId,
          questionId,
          replyId,
          revision: question.revision,
          status: question.status,
          duplicate: false,
        },
      });
    }
    if (url.pathname === "/v1/inboxes")
      json = { items: [{ id: "personal", ownerType: "user" }] };
    if (url.pathname === "/v1/inboxes/personal/conversations")
      json = {
        items: [
          { id: "thread", preview: "Companion setup question", updatedAt: 1 },
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
          {
            id: questionId,
            sequence: 1,
            createdAt: Date.now(),
            receipts: [],
            input: {
              conversationId: "thread",
              recipientInboxId: "personal",
              requestId: taskId,
              content: "Cached text must stay hidden",
              replyExpected: true,
            },
          },
        ],
      };
    await route.fulfill({ json });
  });
  await page.goto("/?inbox-task-review");
  await page
    .getByRole("button", { name: "Companion setup question", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Answer task question", exact: true }),
  ).toBeVisible();
  return {
    question,
    posts,
    deny: () => (denied = true),
    lose: () => (loseResponse = true),
    hold: () => (hold = true),
    pending: () => !!pending,
    release: async () => {
      const r = pending!;
      pending = undefined;
      await r.fulfill({ json: question });
    },
  };
}
async function open(page: Page) {
  await page
    .getByRole("button", { name: "Answer task question", exact: true })
    .click();
}
async function review(page: Page) {
  await open(page);
  await page
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill("Use only this Mac. Leave Acer news briefings unchanged.");
  await page
    .getByRole("button", { name: "Review answer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review your answer", exact: true }),
  ).toBeVisible();
}
async function shot(page: Page, project: string, name: string) {
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: `test-results/task-answer-${project}-${name}.png`,
    fullPage: true,
  });
}
test("Inbox task answer reviews exact input and sends once after confirmation", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  await expect(
    page.getByText("Cached text must stay hidden", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill("Use only this Mac. Leave Acer news briefings unchanged.");
  await shot(page, info.project.name, "edit");
  await page
    .getByRole("button", { name: "Review answer", exact: true })
    .click();
  const save = page.getByRole("button", { name: "Save answer", exact: true });
  await expect(save).toBeDisabled();
  expect(f.posts).toHaveLength(0);
  await expect(
    page.getByText(
      "Saving queues this task to continue with its existing permissions.",
      { exact: true },
    ),
  ).toBeVisible();
  await shot(page, info.project.name, "review");
  await page
    .getByRole("checkbox", { name: "I reviewed this question and answer." })
    .check();
  await save.click();
  await expect(
    page.getByText(
      "Answer saved. Refresh the task to see its current progress.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0].body).toEqual({
    questionId,
    expectedRevision: 3,
    content: "Use only this Mac. Leave Acer news briefings unchanged.",
    confirmed: true,
  });
  expect(f.posts[0].key).toMatch(/^[a-f0-9-]{36}$/);
  await open(page);
  await expect(page.getByText(/An answer is already saved/)).toBeVisible();
  expect(f.posts).toHaveLength(1);
});
test("paused answer review explains separate resume and reconciles a lost save response", async ({
  page,
}, info) => {
  const f = await fixture(page, true);
  await review(page);
  await expect(
    page.getByText(
      "Saving keeps this task paused. Resume it separately when ready.",
      { exact: true },
    ),
  ).toBeVisible();
  await shot(page, info.project.name, "paused");
  f.lose();
  await page
    .getByRole("checkbox", { name: "I reviewed this question and answer." })
    .check();
  await page.getByRole("button", { name: "Save answer", exact: true }).click();
  await expect(page.getByText(/Saving could not be confirmed/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save answer", exact: true }),
  ).toHaveCount(0);
  await shot(page, info.project.name, "uncertain");
  expect(f.posts).toHaveLength(1);
  await open(page);
  await expect(page.getByText(/An answer is already saved/)).toBeVisible();
  expect(f.posts).toHaveLength(1);
});
test("narrow answer review expires, clears on Escape and suppresses held reads after blur or conversation change", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const f = await fixture(page);
  await review(page);
  await shot(page, info.project.name, "phone-review");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Save answer", exact: true }),
  ).toHaveCount(0);
  await review(page);
  await page.clock.fastForward(120250);
  await expect(page.getByText(/Answer review expired/)).toBeVisible();
  await expect(
    page.getByText(f.question.question, { exact: true }),
  ).toHaveCount(0);
  await shot(page, info.project.name, "phone-expired");
  f.hold();
  await open(page);
  await expect.poll(f.pending).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.release();
  await expect(
    page.getByRole("textbox", { name: "Your answer", exact: true }),
  ).toHaveCount(0);
  await open(page);
  await page
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill("A changed permission must stop review");
  f.deny();
  await page
    .getByRole("button", { name: "Review answer", exact: true })
    .click();
  await expect(page.getByText(/Question or access changed/)).toBeVisible();
  f.hold();
  await open(page);
  await expect.poll(f.pending).toBe(true);
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await f.release();
  await expect(
    page.getByText(f.question.question, { exact: true }),
  ).toHaveCount(0);
  expect(f.posts).toHaveLength(0);
});
