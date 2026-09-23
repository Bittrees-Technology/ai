import { test, expect } from "@playwright/test";
test("Mac key panel requires review acknowledgement and reports local creation/deletion accurately", async ({
  page,
}) => {
  await page.goto("/?keys");
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .click();
  const review = page.getByRole("region", { name: "Review key change" });
  await expect(review).toBeVisible();
  await expect(review).toContainText(
    "storage recovery kit does not include these keys",
  );
  const confirm = page.getByRole("button", {
    name: "Confirm set up device key",
  });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText(
    "Private task access is not enabled",
  );
  await page.getByRole("button", { name: "Remove key 1", exact: true }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(review).toContainText("may become unreadable");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm remove key" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Remote copies and prior exports are unchanged",
  );
  await expect(
    page.getByText("No selected device key", { exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).keyFixture.calls);
  expect(calls.filter((c: any) => c.path.endsWith("/confirm"))).toHaveLength(2);
  expect(
    calls
      .filter((c: any) => c.path.endsWith("/confirm"))
      .every((c: any) => c.body.acknowledged === true),
  ).toBe(true);
});
test("Mac key panel discards delayed review after focus loss and never retries a conflicting confirmation", async ({
  page,
}) => {
  await page.goto("/?keys");
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .waitFor();
  await page.evaluate(() => {
    (window as any).keyFixture.holdReview = true;
  });
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).keyFixture.calls.some((c: any) =>
          c.path.endsWith("/review"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    (window as any).keyFixture.release();
  });
  await expect(
    page.getByRole("region", { name: "Review key change" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set up device key", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).keyFixture.holdReview = false;
    (window as any).keyFixture.failConfirm = true;
  });
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm set up device key" }).click();
  await expect(page.getByRole("alert")).toContainText("saved keys changed");
  await expect(
    page.getByRole("region", { name: "Review key change" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).keyFixture.calls.filter((c: any) =>
          c.path.endsWith("/confirm"),
        ).length,
    ),
  ).toBe(1);
});
test("Mac key review supports keyboard dismissal and readable desktop/mobile layout", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?keys");
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .click();
  const checkbox = page.getByRole("checkbox");
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.screenshot({
    path: `test-results/private-keys-desktop-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Review key change" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Set up device key", exact: true })
    .click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = await page
    .getByRole("button", { name: "Confirm set up device key" })
    .boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: `test-results/private-keys-mobile-${info.project.name}.png`,
    fullPage: true,
  });
});
