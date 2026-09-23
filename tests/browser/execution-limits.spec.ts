import { test, expect, type Page, type Route } from "@playwright/test";
async function fixture(page: Page) {
  let state = {
    version: 1,
    revision: 0,
    limits: {
      parallelTasks: 1,
      maxTaskSeconds: 120,
      minFreeMemoryGiB: 0,
      pauseNewTasks: false,
    },
    activeTasks: 0,
    freeMemoryBytes: 4 * 1024 ** 3,
    reason: "ready",
  };
  let lose = false,
    held: Route | undefined,
    hold = false;
  const writes: any[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    let json: unknown = {};
    if (path === "/v1/device/execution") {
      if (request.method() === "PUT") {
        const input = request.postDataJSON();
        writes.push(input);
        if (input.expectedRevision !== state.revision)
          return route.fulfill({ status: 409, json: { error: "CONFLICT" } });
        state = {
          ...state,
          revision: state.revision + 1,
          limits: input.limits,
          reason: input.limits.pauseNewTasks ? "paused" : "ready",
        };
        if (lose) {
          lose = false;
          return route.fulfill({
            status: 503,
            json: { error: "LOCAL_UNAVAILABLE" },
          });
        }
      } else if (hold) {
        hold = false;
        held = route;
        return;
      }
      json = state;
    } else if (path === "/v1/device")
      json = {
        sampledAt: new Date().toISOString(),
        platform: "darwin",
        architecture: "arm64",
        logicalProcessors: 12,
        memory: {
          totalBytes: 24 * 1024 ** 3,
          freeBytes: 4 * 1024 ** 3,
          companionBytes: 100000000,
        },
        diskFreeBytes: 100 * 1024 ** 3,
        uptimeSeconds: 60,
        limits: {
          importFileBytes: 8 * 1024 ** 3,
          importTotalBytes: 16 * 1024 ** 3,
          importMemoryBytes: 14 * 1024 ** 3,
          parallelGenerations: state.limits.parallelTasks,
        },
        execution: state,
        remoteAccess: false,
        cloudFallback: false,
      };
    else if (
      [
        "/v1/requests",
        "/v1/profiles",
        "/v1/memories",
        "/v1/inboxes",
        "/v1/imports",
      ].includes(path)
    )
      json = { items: [] };
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page.getByRole("button", { name: "Device", exact: true }).click();
  const panel = page.getByRole("region", { name: "Local execution limits" });
  await expect(panel.getByLabel("Tasks at once")).toBeVisible();
  return {
    panel,
    writes,
    lose: () => {
      lose = true;
    },
    hold: () => {
      hold = true;
    },
    held: () => held,
    state: () => structuredClone(state),
    conflict: () => {
      state = {
        ...state,
        revision: state.revision + 1,
        limits: { ...state.limits, parallelTasks: 3 },
      };
    },
  };
}
test("Mac limits require confirmation, keep running work explicit and fit desktop and narrow screens", async ({
  page,
}, info) => {
  const f = await fixture(page),
    save = f.panel.getByRole("button", { name: "Save limits" });
  await expect(save).toBeDisabled();
  await f.panel.getByLabel("Tasks at once").fill("2");
  await f.panel.getByLabel("Time limit per task (seconds)").fill("240");
  await f.panel.getByLabel("Minimum free memory (GiB)").fill("3");
  await f.panel.getByLabel("Pause new tasks", { exact: true }).check();
  await f.panel
    .getByLabel("Apply these limits to new tasks on this Mac.")
    .focus();
  await page.keyboard.press("Space");
  await save.click();
  await expect(f.panel.getByText(/Limits saved for new tasks/)).toBeVisible();
  expect(f.writes).toEqual([
    {
      expectedRevision: 0,
      confirmed: true,
      limits: {
        parallelTasks: 2,
        maxTaskSeconds: 240,
        minFreeMemoryGiB: 3,
        pauseNewTasks: true,
      },
    },
  ]);
  await expect(save).toBeDisabled();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await f.panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/execution-limits-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});
test("lost settings acknowledgement requires reconciliation and never automatically repeats a write", async ({
  page,
}) => {
  const f = await fixture(page),
    save = f.panel.getByRole("button", { name: "Save limits" });
  await f.panel.getByLabel("Tasks at once").fill("2");
  await f.panel
    .getByLabel("Apply these limits to new tasks on this Mac.")
    .check();
  f.lose();
  await save.click();
  await expect(f.panel.getByText(/save could not be confirmed/)).toBeVisible();
  await expect(f.panel.getByLabel("Tasks at once")).toHaveValue("2");
  await expect(save).toBeDisabled();
  expect(f.writes).toHaveLength(1);
  await f.panel.getByRole("button", { name: "Load current limits" }).click();
  await expect(f.panel.getByText("Current limits loaded.")).toBeVisible();
  await expect(f.panel.getByLabel("Tasks at once")).toHaveValue("2");
  await expect(save).toBeDisabled();
  expect(f.writes).toHaveLength(1);
});
test("stale settings cannot replace a newer revision and a departed view ignores its late response", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.panel.getByLabel("Tasks at once").fill("2");
  await f.panel
    .getByLabel("Apply these limits to new tasks on this Mac.")
    .check();
  f.conflict();
  await f.panel.getByRole("button", { name: "Save limits" }).click();
  await expect(f.panel.getByText(/save could not be confirmed/)).toBeVisible();
  f.hold();
  await f.panel.getByRole("button", { name: "Load current limits" }).click();
  await expect.poll(() => !!f.held()).toBe(true);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await f.held()!.fulfill({ json: f.state() });
  await expect(page.getByText("Current limits loaded.")).toHaveCount(0);
  await page.getByRole("button", { name: "Device", exact: true }).click();
  await expect(f.panel.getByLabel("Tasks at once")).toHaveValue("3");
});
