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

test("possible name variants remain visible for review without publication actions", async ({
  page,
}) => {
  await page.route("**/v1/research/investors**", (route) =>
    route.fulfill({
      json: {
        available: true,
        jobs: [
          {
            id: "held",
            state: "sources_exhausted",
            input: { brief: "Research investment decision makers" },
            added: 0,
            done: ["https://example.org/team"],
            queue: [],
            failures: [],
            skipped: 1,
            duplicateReviews: [
              {
                name: "Christopher S. Calicott",
                url: "https://example.org/team",
                matches: [{ id: "canonical", name: "Christopher Calicott" }],
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/?investor-research");
  await page
    .getByText("1 possible duplicate names held for review", { exact: true })
    .click();
  await expect(
    page.getByText("Christopher S. Calicott", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Possible match: Christopher Calicott/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Source", exact: true }),
  ).toHaveAttribute("href", "https://example.org/team");
  await expect(
    page.getByRole("button", { name: /merge|publish/i }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
