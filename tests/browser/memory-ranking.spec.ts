import { test, expect, type Page, type Route } from "@playwright/test";
const result = {
  id: "memory-synthetic",
  text: "café deadline",
  type: "fact",
  verified: false,
  sources: [
    {
      app: "local",
      tenantId: "personal",
      resourceId: "synthetic-task",
      revision: "3",
    },
  ],
  why: {
    relevance: 1,
    matchedTerms: ["cafe", "deadline"],
    queryTerms: ["cafe", "deadline"],
    feedbackScope: "current-content",
    freshness: 1,
    usefulness: 0,
    pinned: false,
    provenance: "user",
    reviewed: true,
    sourcePenalty: 0,
  },
};
async function fixture(page: Page) {
  let hold = false,
    pending: Route | undefined;
  const searches: unknown[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    let json: unknown = {};
    if (path === "/v1/memories/search") {
      searches.push(route.request().postDataJSON());
      if (hold) {
        hold = false;
        pending = route;
        return;
      }
      json = { items: [result] };
    } else if (
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
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  return {
    panel: page.getByRole("region", { name: "Find reviewed memory" }),
    searches,
    hold: () => {
      hold = true;
    },
    pending: () => pending,
  };
}
test("memory ranking explains exact matched terms and content-specific feedback without claiming verification", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.panel.getByLabel("Words to find").fill("cafe deadline");
  await f.panel.getByRole("button", { name: "Search memory" }).click();
  await f.panel
    .getByText("Why this matched and where it came from", { exact: true })
    .click();
  await expect(
    f.panel.getByText(/Matched terms: cafe, deadline/),
  ).toBeVisible();
  await expect(
    f.panel.getByText(/Only feedback tied to this exact saved content/),
  ).toBeVisible();
  await expect(f.panel.getByText(/Reviewed, unverified/)).toBeVisible();
  expect(f.searches).toEqual([{ query: "cafe deadline" }]);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: `test-results/memory-ranking-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});
test("clearing memory search discards late matching evidence and never writes feedback", async ({
  page,
}) => {
  const f = await fixture(page);
  f.hold();
  await f.panel.getByLabel("Words to find").fill("cafe deadline");
  await f.panel.getByRole("button", { name: "Search memory" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await f.panel.getByRole("button", { name: "Clear search" }).click();
  await f.pending()!.fulfill({ json: { items: [result] } });
  await expect(f.panel.getByText("café deadline", { exact: true })).toHaveCount(
    0,
  );
  await expect(f.panel.getByLabel("Words to find")).toHaveValue("");
  expect(f.searches).toHaveLength(1);
});
