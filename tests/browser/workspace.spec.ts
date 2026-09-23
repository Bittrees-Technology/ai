import { test, expect, type Page, type Route } from "@playwright/test";
const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tasks = [first, second].map((id, index) => ({
  id,
  revision: 1,
  status: "completed",
  input: {
    prompt: index ? "Second synthetic task" : "First synthetic task",
    modelProfileId: "test",
  },
  result: { text: "Synthetic result" },
}));
const run = (model: string) => ({
  items: [{ id: model, outcome: "completed", model: { profile: { model } } }],
});
async function deliver(page: Page, route: Route, body: unknown, status = 200) {
  const response = page.waitForResponse(
    (response) => response.url() === route.request().url(),
  );
  await route.fulfill({ status, json: body });
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function fixture(
  page: Page,
  intercept?: (route: Route, path: string) => Promise<boolean>,
) {
  const calls: string[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    calls.push(path);
    if (await intercept?.(route, path)) return;
    let body: unknown = {};
    if (path === "/v1/requests") body = { items: tasks };
    else if (path === "/v1/profiles")
      body = { items: [{ id: "test", model: "synthetic:local" }] };
    else if (path === "/v1/memories") body = { items: [] };
    else if (path === "/v1/device")
      body = {
        sampledAt: new Date().toISOString(),
        platform: "darwin",
        architecture: "arm64",
        logicalProcessors: 12,
        memory: {
          totalBytes: 24 * 1024 ** 3,
          freeBytes: 8 * 1024 ** 3,
          companionBytes: 100 * 1024 ** 2,
        },
        diskFreeBytes: 100 * 1024 ** 3,
        limits: {
          importFileBytes: 8 * 1024 ** 3,
          importTotalBytes: 12 * 1024 ** 3,
          importMemoryBytes: 12 * 1024 ** 3,
          parallelGenerations: 1,
        },
      };
    else if (path === "/v1/recovery-copies")
      body = { items: [], nextCursor: null };
    else if (path === "/v1/models")
      body = { items: [{ name: "synthetic:local" }] };
    else if (path.endsWith("/runs"))
      body = run(path.includes(first) ? "First model" : "Second model");
    await route.fulfill({ json: body });
  });
  await page.goto("/?workspace");
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".queue")
      .getByRole("button", { name: /First synthetic task/ }),
  ).toBeVisible();
  return calls;
}
async function select(page: Page, name: "First" | "Second") {
  await page
    .locator(".queue")
    .getByRole("button", { name: new RegExp(name + " synthetic task") })
    .click();
}

test("dashboard binds run history to the selected task and conceals delayed successes and errors", async ({
  page,
}) => {
  let held: Route | undefined,
    hold = false;
  await fixture(page, async (route, path) => {
    if (hold && path.endsWith("/runs")) {
      held = route;
      return true;
    }
    return false;
  });
  await select(page, "First");
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "First model",
  );
  hold = true;
  await select(page, "Second");
  await expect.poll(() => !!held).toBe(true);
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "Loading run history",
  );
  await expect(
    page.getByRole("region", { name: "Run history" }),
  ).not.toContainText("First model");
  const old = held!;
  held = undefined;
  hold = false;
  await select(page, "First");
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "First model",
  );
  await deliver(page, old, run("Second model"));
  await expect(
    page.getByRole("region", { name: "Run history" }),
  ).not.toContainText("Second model");
  hold = true;
  await select(page, "Second");
  await expect.poll(() => !!held).toBe(true);
  const stale = held!;
  hold = false;
  await select(page, "First");
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "First model",
  );
  await deliver(page, stale, { error: "UNAUTHORIZED" }, 401);
  // Force a subsequent real dashboard navigation after consuming the old denial.
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose your local model" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("dashboard reports unavailable history and allows an explicit refresh", async ({
  page,
}) => {
  let unavailable = true;
  const calls = await fixture(page, async (route, path) => {
    if (unavailable && path.endsWith("/runs")) {
      await route.fulfill({
        status: 503,
        json: { error: "LOCAL_UNAVAILABLE" },
      });
      return true;
    }
    return false;
  });
  await select(page, "First");
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "Run history is unavailable",
  );
  expect(calls.filter((path) => path.endsWith("/runs"))).toHaveLength(1);
  unavailable = false;
  await page.getByRole("button", { name: "Refresh run history" }).click();
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "First model",
  );
});

test("locking fences delayed model-profile continuation across a fresh pairing", async ({
  page,
}) => {
  let held: Route | undefined;
  const calls = await fixture(page, async (route, path) => {
    if (path === "/v1/profiles" && route.request().method() === "POST") {
      held = route;
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Installed model", { exact: true })).toHaveValue(
    "synthetic:local",
  );
  await page
    .getByRole("button", { name: "Create profile and use by default" })
    .click();
  await expect.poll(() => !!held).toBe(true);
  await page.getByRole("button", { name: "Lock workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect to this Mac" }),
  ).toBeVisible();
  await page.getByLabel("Pairing code").fill("synthetic-new-pairing");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await deliver(page, held!, { id: "old-profile" });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    page
      .locator(".queue")
      .getByRole("button", { name: /First synthetic task/ }),
  ).toBeVisible();
  expect(calls.filter((path) => path === "/v1/profiles/default")).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("completed task history stays readable at desktop and narrow widths", async ({
  page,
}, info) => {
  await fixture(page);
  await select(page, "First");
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "First model",
  );
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: info.outputPath(`workspace-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});

test("locking discards a delayed export without starting a download in the new workspace", async ({
  page,
}) => {
  let held: Route | undefined,
    downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  await fixture(page, async (route, path) => {
    if (path === "/v1/export") {
      held = route;
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "Device", exact: true }).click();
  await page.getByRole("button", { name: "Export my local data" }).click();
  await expect.poll(() => !!held).toBe(true);
  await page.getByRole("button", { name: "Lock workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect to this Mac" }),
  ).toBeVisible();
  await deliver(page, held!, { privateSyntheticText: "Old workspace export" });
  expect(downloads).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("confirmed deletion discards delayed reads and remounts controls with a usable request scope", async ({
  page,
}) => {
  let held: Route | undefined,
    hold = true,
    deleted = false;
  await fixture(page, async (route, path) => {
    if (path === "/v1/data") {
      deleted = true;
      await route.fulfill({ json: {} });
      return true;
    }
    if (path === "/v1/requests" && deleted) {
      await route.fulfill({ json: { items: [] } });
      return true;
    }
    if (path === "/v1/recovery-copies" && hold) {
      held = route;
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "Device", exact: true }).click();
  await page.getByRole("button", { name: "Show saved copies" }).click();
  await expect.poll(() => !!held).toBe(true);
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page
    .getByRole("button", { name: "Delete local data", exact: true })
    .click();
  await expect(page.getByLabel("Type DELETE to confirm")).toHaveValue("");
  hold = false;
  await deliver(page, held!, { error: "UNAUTHORIZED" }, 401);
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show saved copies" }).click();
  await expect(
    page.getByText("No retained copies on this page."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    page
      .locator(".queue")
      .getByRole("button", { name: /First synthetic task/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
