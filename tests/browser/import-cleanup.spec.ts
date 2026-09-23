import { test, expect, type Page } from "@playwright/test";
const installedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(page: Page, fail = false) {
  let cleanup = "retry";
  const writes: { path: string; method: string; body: unknown }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    if (request.method() !== "GET")
      writes.push({
        path,
        method: request.method(),
        body: request.postDataJSON(),
      });
    if (path === `/v1/imports/${installedId}/cleanup`) {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: "LOCAL_UNAVAILABLE" },
        });
      cleanup = "released";
      return route.fulfill({ json: {} });
    }
    let json: unknown = {};
    if (
      [
        "/v1/requests",
        "/v1/profiles",
        "/v1/memories",
        "/v1/inboxes",
        "/v1/models",
      ].includes(path)
    )
      json = { items: [] };
    else if (path === "/v1/imports")
      json = {
        items: [
          {
            id: installedId,
            state: "installed",
            createdAt: "2026-09-23T00:00:00Z",
            stagingCleanup: { state: cleanup, updatedAt: 1 },
            installation: {
              modelDigest: "a".repeat(64),
              architecture: "synthetic",
              quantization: "Q4",
              parameterSize: "9B",
              installedBytes: 6000000000,
            },
          },
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            state: "uncertain",
            createdAt: "2026-09-23T00:00:00Z",
          },
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            state: "failed",
            error: "REVIEW_EXPIRED",
            createdAt: "2026-09-23T00:00:00Z",
            stagingCleanup: { state: "released", updatedAt: 1 },
          },
        ],
      };
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.locator(".model-import-job")).toHaveCount(3);
  return { writes };
}
test("cleanup retry keeps verified installation and history visible without another runtime operation", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const installed = page.locator(".model-import-job").nth(0),
    uncertain = page.locator(".model-import-job").nth(1);
  await expect(installed.getByRole("status")).toHaveText("Installed");
  await expect(
    uncertain.getByRole("button", { name: "Retry temporary-file cleanup" }),
  ).toHaveCount(0);
  await expect(
    uncertain.getByRole("button", { name: "Check installed outcome" }),
  ).toBeVisible();
  const retry = installed.getByRole("button", {
    name: "Retry temporary-file cleanup",
  });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    installed.getByText(
      "Temporary import files removed. Import history is retained.",
    ),
  ).toBeVisible();
  await expect(installed.getByRole("status")).toHaveText("Installed");
  await installed
    .getByText("Verified installation details", { exact: true })
    .click();
  await expect(
    installed.getByText(`Installed model digest: ${"a".repeat(64)}`, {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes.filter((w) => w.path.startsWith("/v1/imports/"))).toEqual([
    { path: `/v1/imports/${installedId}/cleanup`, method: "POST", body: {} },
  ]);
});
test("an unavailable cleanup keeps the outcome and explicit retry without automatically repeating writes", async ({
  page,
}) => {
  const { writes } = await fixture(page, true);
  const installed = page.locator(".model-import-job").nth(0);
  const retry = installed.getByRole("button", {
    name: "Retry temporary-file cleanup",
  });
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(installed.getByRole("status")).toHaveText("Installed");
  await expect(
    installed.getByText(/Temporary files could not be removed/),
  ).toBeVisible();
  // Observe a subsequent poll; read-only refresh must not dispatch another cleanup.
  await page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/v1/imports" &&
      r.request().method() === "GET",
  );
  expect(writes.filter((w) => w.path.startsWith("/v1/imports/"))).toHaveLength(
    1,
  );
});
test("cleanup, uncertain outcome and retained installation details stay readable at desktop and narrow widths", async ({
  page,
}, info) => {
  await fixture(page);
  await page
    .locator(".model-import-job")
    .nth(0)
    .getByText("Verified installation details", { exact: true })
    .click();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: `test-results/import-cleanup-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});
