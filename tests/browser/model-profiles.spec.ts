import { test, expect, type Page } from "@playwright/test";
const baseline = {
  id: "baseline",
  runtime: "ollama",
  model: "synthetic:local",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0.2,
};
async function setup(page: Page, reject = false) {
  const profiles = [{ ...baseline }],
    calls: { path: string; method: string; body: any }[] = [];
  let selected = baseline.id;
  page.on("pageerror", (error) =>
    console.log("Profile browser error:", error.message),
  );
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    const body = route.request().postDataJSON();
    calls.push({ path, method, body });
    let value: unknown = {};
    if (path === "/v1/profiles" && method === "POST") {
      if (reject)
        return route.fulfill({
          status: 503,
          json: { error: "MODEL_UNAVAILABLE" },
        });
      profiles.push(body);
      value = body;
    } else if (path === "/v1/profiles/default") selected = body.profileId;
    else if (path === "/v1/profiles")
      value = {
        items: profiles,
        defaultProfile: profiles.find((p) => p.id === selected),
      };
    else if (path === "/v1/models")
      value = { items: [{ name: baseline.model }] };
    else if (["/v1/inboxes", "/v1/imports", "/v1/memories"].includes(path))
      value = { items: [] };
    else if (path === "/v1/requests")
      value = {
        items: [
          {
            id: "old-task",
            revision: 1,
            status: "completed",
            input: {
              prompt: "Earlier synthetic request",
              modelProfileId: baseline.id,
            },
            result: { text: "Synthetic old draft" },
          },
        ],
      };
    else if (path === "/v1/requests/old-task/runs")
      value = {
        items: [
          { id: "old-run", outcome: "completed", model: { profile: baseline } },
        ],
      };
    await route.fulfill({ json: value });
  });
  await page.goto("/?workspace");
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Installed model", { exact: true })).toHaveValue(
    baseline.model,
  );
  return { profiles, calls };
}
async function custom(page: Page) {
  await page
    .getByLabel("Context budget (tokens)", { exact: true })
    .fill("8192");
  await page.getByLabel("Reply limit (tokens)", { exact: true }).fill("1024");
  await page
    .getByLabel("Variation (temperature)", { exact: true })
    .fill("0.35");
  await page
    .getByRole("button", { name: "Create profile and use by default" })
    .click();
}
test("custom settings create an immutable profile, distinguish same-model choices and leave prior run history intact", async ({
  page,
}) => {
  const { profiles, calls } = await setup(page);
  await custom(page);
  await expect(page.locator(".saved-model-profile")).toHaveCount(2);
  expect(profiles[1]).toMatchObject({
    contextTokens: 8192,
    maxOutputTokens: 1024,
    temperature: 0.35,
  });
  expect(profiles[0]).toEqual(baseline);
  expect(
    calls.filter((c) => c.path === "/v1/profiles" && c.method === "POST"),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  const options = page.locator(".queue select option");
  await expect(
    options.filter({
      hasText: /8,192 context.*1,024 reply limit.*0.35 variation/,
    }),
  ).toHaveCount(1);
  await expect(
    options.filter({
      hasText: /4,096 context.*512 reply limit.*0.2 variation/,
    }),
  ).toHaveCount(1);
  await page
    .locator(".tasklist")
    .getByRole("button", { name: /Earlier synthetic request/ })
    .click();
  await expect(page.getByRole("region", { name: "Run history" })).toContainText(
    "Recorded settings: 4,096 context · 512 reply limit · 0.2 variation",
  );
});
test("invalid or incomplete settings never create a profile or change the default", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByLabel("Context budget (tokens)", { exact: true }).fill("768");
  await expect(page.getByRole("status")).toContainText("at least 257 tokens");
  await expect(
    page.getByRole("button", { name: "Create profile and use by default" }),
  ).toBeDisabled();
  await page
    .getByLabel("Context budget (tokens)", { exact: true })
    .fill("4096");
  await page.getByLabel("Variation (temperature)", { exact: true }).fill("");
  await expect(page.getByRole("status")).toContainText("Enter all three");
  await expect(
    page.getByRole("button", { name: "Create profile and use by default" }),
  ).toBeDisabled();
  expect(
    calls.filter(
      (c) => c.method === "POST" || c.path === "/v1/profiles/default",
    ),
  ).toHaveLength(0);
});
test("runtime refusal preserves saved profiles and does not silently change defaults or retry", async ({
  page,
}) => {
  const { calls, profiles } = await setup(page, true);
  await custom(page);
  await expect(page.getByRole("alert")).toContainText("Start Ollama");
  await expect(
    page.getByRole("button", { name: "Create profile and use by default" }),
  ).toBeEnabled();
  expect(profiles).toEqual([baseline]);
  expect(calls.filter((c) => c.path === "/v1/profiles/default")).toHaveLength(
    0,
  );
  expect(
    calls.filter((c) => c.path === "/v1/profiles" && c.method === "POST"),
  ).toHaveLength(1);
});
test("profile settings and saved configurations remain usable at desktop and narrow widths", async ({
  page,
}, info) => {
  await setup(page);
  await custom(page);
  await expect(page.locator(".saved-model-profile")).toHaveCount(2);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: `test-results/model-profiles-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    page.locator(".queue select option").filter({ hasText: /8,192 context/ }),
  ).toHaveCount(1);
  await expect(page.locator("#task-profile-settings")).toContainText(
    "8,192 context",
  );
  await page.screenshot({
    path: `test-results/model-profiles-task-${info.project.name}-390.png`,
    fullPage: true,
  });
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 1)
      .map((e) => ({ tag: e.tagName, class: e.className, id: e.id, right: e.getBoundingClientRect().right, width: e.clientWidth, scroll: e.scrollWidth })),
  }));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Model", exact: true })
      .locator("option")
      .filter({ hasText: /8,192 context/ }),
  ).toHaveCount(1);
  await page.screenshot({
    path: `test-results/model-profiles-template-${info.project.name}-390.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
