import { test, expect, type Page, type Route } from "@playwright/test";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(page: Page, initiallyHidden: boolean) {
  let hidden = initiallyHidden,
    pending: Route | undefined;
  const calls: string[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    calls.push(path);
    let json: unknown = {};
    if (path === "/v1/requests")
      json = {
        items: [
          {
            id,
            revision: 3,
            status: "completed",
            input: {
              prompt: hidden
                ? "Local reference unavailable"
                : "Synthetic dependent task",
              modelProfileId: "p",
            },
            result: hidden ? null : { text: "Synthetic current result" },
            ...(hidden ? { dependencyAccess: "unavailable" } : {}),
          },
        ],
      };
    else if (path.endsWith("/runs")) {
      pending = route;
      return;
    } else if (path.endsWith("/quality-review"))
      json = {
        taskId: id,
        taskRevision: 3,
        runId: "r",
        model: { profile: { model: "synthetic:local" } },
        durationMs: 1250,
        reviewRevision: 0,
        review: null,
        updatedAt: null,
      };
    else if (
      ["/v1/profiles", "/v1/memories", "/v1/imports", "/v1/inboxes"].includes(
        path,
      )
    )
      json = { items: [] };
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page
    .locator(".tasklist")
    .getByRole("button", {
      name: initiallyHidden
        ? /Local reference unavailable/
        : /Synthetic dependent task/,
    })
    .click();
  return {
    calls,
    hide: () => {
      hidden = true;
    },
    pending: () => pending,
  };
}
test("unavailable local references explain hidden content and expose no suggestion, reuse or rating controls", async ({
  page,
}, info) => {
  const f = await fixture(page, true);
  await expect(
    page.getByText(/A source or memory used by this task/),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Run history" })
      .getByText(/History is hidden/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use prompt again" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Your quality review" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save for review" }),
  ).toHaveCount(0);
  expect(
    f.calls.some((path) =>
      /\/(runs|quality-review|memory-suggestions)$/.test(path),
    ),
  ).toBe(false);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: `test-results/local-memory-dependencies-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});
test("dependency loss removes result and quality review and suppresses an already requested late history", async ({
  page,
}) => {
  const f = await fixture(page, false);
  await expect(
    page.getByText("Synthetic current result", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => !!f.pending()).toBe(true);
  f.hide();
  await expect(
    page.getByText(/A source or memory used by this task/),
  ).toBeVisible({ timeout: 10000 });
  await f
    .pending()!
    .fulfill({
      json: {
        items: [
          {
            id: "late",
            outcome: "completed",
            model: { profile: { model: "PRIVATE_LATE_HISTORY" } },
          },
        ],
      },
    });
  await expect(
    page.getByText("Synthetic current result", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/PRIVATE_LATE_HISTORY/)).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Your quality review" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use prompt again" }),
  ).toHaveCount(0);
});
