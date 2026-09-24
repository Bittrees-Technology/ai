import { test, expect, type Page, type TestInfo } from "@playwright/test";
const panel = (page: Page) =>
  page.getByRole("region", { name: "Private task delivery", exact: true });
const review = (page: Page) =>
  page.getByRole("region", {
    name: "Review private task delivery",
    exact: true,
  });
async function calls(page: Page, suffix: string) {
  return page.evaluate(
    (s) =>
      (window as any).taskDeliveryFixture.calls.filter((c: any) =>
        c.path.endsWith(s),
      ),
    suffix,
  );
}
async function preview(page: Page, info: TestInfo, state: string) {
  await page.screenshot({
    path: `test-results/mac-task-delivery-${info.project.name}-${state}.png`,
    fullPage: true,
  });
}
async function open(page: Page) {
  await page.goto("/?mac-task-delivery");
  await page
    .getByRole("button", { name: "Open private task delivery", exact: true })
    .click();
  await expect(
    panel(page).getByText("No private tasks have been accepted locally."),
  ).toBeVisible();
  await select(page);
}
async function select(page: Page) {
  const id = await page.evaluate(() => (window as any).taskDeliveryFixture.id);
  await panel(page)
    .getByLabel("Connection for private delivery")
    .selectOption(id);
}
async function confirm(page: Page) {
  await expect(review(page).getByRole("checkbox")).not.toBeChecked();
  const button = review(page).getByRole("button", { name: /^Confirm / });
  await expect(button).toBeDisabled();
  await review(page).getByRole("checkbox").check();
  await button.click();
}
async function receive(page: Page) {
  await panel(page)
    .getByRole("button", { name: "Review checking for a task" })
    .click();
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "accepted locally",
  );
}
async function prepare(page: Page) {
  await panel(page)
    .getByRole("button", { name: "Review acceptance reply" })
    .click();
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "nothing was sent automatically",
  );
}
test("Mac delivery opens explicitly and reviews receive, prepare and send separately", async ({
  page,
}, info) => {
  await page.goto("/?mac-task-delivery");
  await expect(
    page.getByRole("button", { name: "Open private task delivery" }),
  ).toBeVisible();
  expect(await calls(page, "/private-tasks")).toHaveLength(0);
  expect(await calls(page, "/check-task")).toHaveLength(0);
  await page
    .getByRole("button", { name: "Open private task delivery" })
    .click();
  await select(page);
  await panel(page)
    .getByRole("button", { name: "Review checking for a task" })
    .click();
  await expect(review(page)).toContainText("Check for one task");
  expect(await calls(page, "/check-task")).toHaveLength(0);
  await preview(page, info, "check");
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page, info, "check-phone");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "accepted locally",
  );
  await prepare(page);
  expect(await calls(page, "/responses/send")).toHaveLength(0);
  await preview(page, info, "prepared");
  await panel(page)
    .getByRole("button", { name: "Review sending this reply" })
    .click();
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "Browser authentication or reading is not confirmed",
  );
  expect(await calls(page, "/responses/send")).toHaveLength(1);
  await panel(page)
    .getByRole("button", { name: "Refresh private task history" })
    .click();
  await expect(
    panel(page).getByText(/Last relay confirmation: stored for delivery/),
  ).toBeVisible();
  expect(await calls(page, "/responses/send")).toHaveLength(1);
  await preview(page, info, "stored");
});
test("Mac lost-send result requires fresh history and a new review of the same reply", async ({
  page,
}, info) => {
  await open(page);
  await receive(page);
  await prepare(page);
  await page.evaluate(() => {
    (window as any).taskDeliveryFixture.failSend = true;
  });
  await panel(page)
    .getByRole("button", { name: "Review sending this reply" })
    .click();
  await confirm(page);
  await expect(panel(page).getByRole("alert")).toContainText(
    "nothing will be retried automatically",
  );
  await preview(page, info, "uncertain");
  expect(await calls(page, "/responses/send")).toHaveLength(1);
  await page.evaluate(() => {
    (window as any).taskDeliveryFixture.failSend = false;
  });
  await panel(page)
    .getByRole("button", { name: "Refresh private task history" })
    .click();
  await expect(
    panel(page).getByText(/The latest sending attempt is unconfirmed/),
  ).toBeVisible();
  await select(page);
  await panel(page)
    .getByRole("button", { name: "Review sending this reply" })
    .click();
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "original message was already recorded",
  );
  const sent = await calls(page, "/responses/send");
  expect(sent).toHaveLength(2);
  expect(sent[1].body.response.id).toBe(sent[0].body.response.id);
  expect(sent[1].body.response.expectedRevision).toBeGreaterThan(
    sent[0].body.response.expectedRevision,
  );
});
test("Mac hidden task delivery cancels held work and discards stale confirmation", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).taskDeliveryFixture.holdCheck = true;
  });
  await panel(page)
    .getByRole("button", { name: "Review checking for a task" })
    .click();
  await confirm(page);
  await expect
    .poll(async () => (await calls(page, "/check-task")).length)
    .toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(async () => (await calls(page, "/cancel-review")).length)
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as any).taskDeliveryFixture.release();
  });
  await expect(
    panel(page).getByRole("button", { name: "Refresh private task history" }),
  ).toBeEnabled();
  await expect(review(page)).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toHaveText("");
  await panel(page)
    .getByRole("button", { name: "Refresh private task history" })
    .click();
  await expect(
    panel(page).getByText("No private tasks have been accepted locally."),
  ).toBeVisible();
  await select(page);
  await panel(page)
    .getByRole("button", { name: "Review checking for a task" })
    .click();
  await page.evaluate(() => (window as any).taskDeliveryFixture.change());
  await confirm(page);
  await expect(panel(page).getByRole("alert")).not.toBeEmpty();
  expect(await calls(page, "/check-task")).toHaveLength(1);
});
test("Mac can stop reply retries offline without claiming recall or cancelling work", async ({
  page,
}, info) => {
  await open(page);
  await receive(page);
  await prepare(page);
  await page.evaluate(() => (window as any).taskDeliveryFixture.offline());
  await panel(page)
    .getByRole("button", { name: "Refresh private task history" })
    .click();
  await expect(
    panel(page).getByText("No active connection is available.", {
      exact: false,
    }),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Review stopping this reply" })
    .click();
  await expect(review(page)).toContainText(
    "cannot recall a message already sent",
  );
  await confirm(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "Previously sent messages and local task work are unchanged",
  );
  expect(await calls(page, "/responses/send")).toHaveLength(0);
  expect(await calls(page, "/responses/stop")).toHaveLength(1);
  await preview(page, info, "stopped");
});
