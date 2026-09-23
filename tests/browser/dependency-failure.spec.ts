import { test, expect } from "@playwright/test";
test("Local prerequisite failure explains terminal work without implying a draft or automatic retry", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?dependencies");
  const region = page.getByRole("region", {
    name: "Required task did not complete",
  });
  await expect(region).toContainText("It will not retry automatically");
  await expect(region.getByRole("listitem")).toHaveCount(3);
  for (const state of ["failed", "cancelled", "expired"])
    await expect(region).toContainText(state);
  await expect(page.getByRole("heading", { name: "Draft result" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: `test-results/dependency-failure-desktop-${info.project.name}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(region).toBeVisible();
  await page.screenshot({
    path: `test-results/dependency-failure-mobile-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
