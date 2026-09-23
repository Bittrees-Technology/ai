import { test, expect, type Page } from "@playwright/test";
async function fill(page: Page) {
  await page
    .getByLabel("Reviewed device", { exact: true })
    .selectOption({ index: 1 });
  await page
    .getByLabel("Allow this device to submit text tasks to this Mac", {
      exact: true,
    })
    .check();
  await page
    .getByLabel("Local model for incoming tasks", { exact: true })
    .selectOption("local");
  await page
    .getByLabel("Return acceptance receipts for new incoming tasks", {
      exact: true,
    })
    .check();
}
async function prepare(page: Page) {
  await fill(page);
  await page
    .getByRole("button", { name: "Review permission choices", exact: true })
    .click();
}
test("Mac task permission panel starts off, requires exact review and keeps offline revocation separate", async ({
  page,
}) => {
  await page.goto("/?permissions");
  await expect(page.getByRole("checkbox")).toHaveCount(4);
  for (const checkbox of await page.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await expect(
    page.getByLabel("Share results for new incoming tasks", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Review permission choices",
      exact: true,
    }),
  ).toBeDisabled();
  await fill(page);
  const results = page.getByLabel("Share results for new incoming tasks", {
    exact: true,
  });
  const receipts = page.getByLabel(
    "Return acceptance receipts for new incoming tasks",
    { exact: true },
  );
  await results.check();
  await receipts.uncheck();
  await expect(results).not.toBeChecked();
  await expect(results).toBeDisabled();
  await page
    .getByLabel("Allow this device to submit text tasks to this Mac", {
      exact: true,
    })
    .uncheck();
  await expect(receipts).not.toBeChecked();
  await expect(receipts).toBeDisabled();
  await expect(
    page.getByLabel("Local model for incoming tasks", { exact: true }),
  ).toHaveCount(0);
  await prepare(page);
  const review = page.getByRole("region", {
    name: "Review task permission change",
  });
  await expect(review).toContainText("Incoming text tasks: Allowed");
  await expect(review).toContainText("Outgoing text tasks: Off");
  await expect(review).toContainText("Results for new incoming tasks: Off");
  await expect(
    page.getByRole("button", { name: "Save permission choices" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save permission choices" }).click();
  await expect(page.getByRole("status")).toContainText(
    "delivery is not active",
  );
  for (const checkbox of await page.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await page
    .getByRole("button", { name: /Review permission revocation for/ })
    .click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(review).toContainText("Already accepted local work continues");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Revoke task permissions", exact: true })
    .click();
  await expect(
    page.getByText("Revoked locally", { exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).permissionFixture.calls,
  );
  expect(calls.filter((c: any) => c.path.endsWith("confirm"))).toHaveLength(2);
  const body = calls.find((c: any) => c.body?.action === "grant").body;
  expect(body.sendTasks).toBe(false);
  expect(body.sendResults).toBe(false);
  expect(body.expectedKeyRevision).toBe(2);
});
test("Mac permission panel suppresses hidden delayed reviews and never retries an uncertain save", async ({
  page,
}) => {
  await page.goto("/?permissions");
  await page.getByRole("checkbox").first().waitFor();
  await page.evaluate(() => {
    (window as any).permissionFixture.holdReview = true;
  });
  await prepare(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).permissionFixture.calls.some((c: any) =>
          c.path.endsWith("review"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    (window as any).permissionFixture.release();
  });
  await expect(
    page.getByRole("region", { name: "Review task permission change" }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Reviewed device", { exact: true }),
  ).toBeEnabled();
  for (const checkbox of await page.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await page.evaluate(() => {
    (window as any).permissionFixture.holdReview = false;
    (window as any).permissionFixture.failConfirm = true;
  });
  await prepare(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save permission choices" }).click();
  await expect(page.getByRole("alert")).toContainText("No automatic retry");
  expect(
    await page.evaluate(
      () =>
        (window as any).permissionFixture.calls.filter((c: any) =>
          c.path.endsWith("confirm"),
        ).length,
    ),
  ).toBe(1);
});
test("Mac permission form and review remain readable and keyboard accessible at desktop/mobile sizes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?permissions");
  await page.getByRole("checkbox").first().waitFor();
  await page.screenshot({
    path: `test-results/private-permissions-desktop-form-${info.project.name}.png`,
    fullPage: true,
  });
  await prepare(page);
  await page.getByRole("button", { name: "Refresh saved choices" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Save permission choices" }),
  ).toBeEnabled();
  await page.screenshot({
    path: `test-results/private-permissions-desktop-review-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Review task permission change" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/private-permissions-mobile-form-${info.project.name}.png`,
    fullPage: true,
  });
  await prepare(page);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await page
      .getByRole("button", { name: "Save permission choices" })
      .boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: `test-results/private-permissions-mobile-review-${info.project.name}.png`,
    fullPage: true,
  });
});
