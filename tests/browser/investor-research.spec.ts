import { test, expect } from "@playwright/test";
test("local research requires explicit source and model choices; confirmation does not publish", async ({
  page,
}) => {
  let submitted: any = null;
  const jobs: any[] = [];
  await page.route("**/v1/research/investors**", async (route) => {
    if (route.request().url().endsWith("/start")) {
      submitted = route.request().postDataJSON();
      jobs.push({
        id: "run",
        state: "paused",
        input: submitted,
        added: 0,
        done: [],
        queue: submitted.urls,
        failures: [],
        skipped: 0,
      });
    }
    await route.fulfill({ json: { available: true, jobs } });
  });
  await page.goto("/?investor-research");
  await expect(
    page.getByRole("button", { name: "Start private investor research" }),
  ).toBeDisabled();
  await page.getByLabel("Research model").selectOption("local-test");
  await page
    .getByLabel("Approved public source URLs")
    .fill("https://example.org/team");
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "Start private investor research" })
    .click();
  expect(submitted).toBeNull();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Start private investor research" })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume research" }),
  ).toBeVisible();
  expect(submitted.confirmed).toBe(true);
  expect(submitted.urls).toEqual(["https://example.org/team"]);
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
