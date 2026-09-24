import { test, expect, type Page, type Route } from "@playwright/test";
const key = "tbn_" + "a".repeat(64),
  id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const connection = {
  contractVersion: "news-mcp-connection-v1",
  credentialId: id,
  accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expiresAt: "2050-01-01T00:00:00.000Z",
  scopes: ["read", "curate", "publish", "delivery"],
  state: "stored",
};
const article = {
  id: "a".repeat(64),
  title: "Synthetic private science report",
  url: "https://example.org/story",
  source_id: "Selected source",
  excerpt:
    "A synthetic source excerpt remains unverified. It does not instruct the companion to publish or send anything.",
  summary: null,
  published_at: "2026-09-23T00:00:00.000Z",
};
async function fixture(page: Page) {
  let stored = false,
    deny = false,
    hold = false,
    pending: Route | undefined;
  const calls: { path: string; body: any }[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    if (path === "/v1/private-relay")
      return route.fulfill({
        json: {
          available: false,
          canSetup: false,
          canCheckRemote: false,
          transportActive: false,
          state: { version: 1, restoreAuthority: false, items: [] },
        },
      });
    let json: any = {
      available: false,
      connection: null,
      items: [],
      checks: [],
      peers: [],
      grants: [],
      profiles: [],
      state: {
        slots: [],
        revision: 0,
        needsFreshPairing: false,
        pendingKeyDeletionCount: 0,
      },
    };
    if (path.startsWith("/v1/connections/news")) {
      calls.push({
        path,
        body: request.postData() ? request.postDataJSON() : null,
      });
      if (path.endsWith("/review"))
        json = {
          id,
          connection,
          reviewExpiresAt: new Date(Date.now() + 120000).toISOString(),
        };
      else if (path.endsWith("/confirm")) {
        stored = true;
        json = { connection };
      } else if (path.endsWith("/articles")) {
        if (deny)
          return route.fulfill({
            status: 400,
            json: { error: "SOURCE_DENIED" },
          });
        if (hold) {
          pending = route;
          return;
        }
        json = { items: [article], checkedAt: new Date().toISOString() };
      } else if (path.endsWith("/forget")) {
        stored = false;
        json = { removed: true, sourceRevoked: false };
      } else json = { available: true, connection: stored ? connection : null };
    }
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const card = page.getByRole("article", { name: "News connection" });
  await expect(card.getByLabel("Existing News connection key")).toBeVisible();
  return {
    card,
    calls,
    errors,
    deny: () => {
      deny = true;
    },
    hold: () => {
      hold = true;
    },
    pending: () => pending,
  };
}
async function review(page: Page) {
  const card = page.getByRole("article", { name: "News connection" });
  await card.getByLabel("Existing News connection key").fill(key);
  await card.getByRole("button", { name: "Review key", exact: true }).click();
  await expect(
    card.getByRole("heading", { name: "Review this connection" }),
  ).toBeVisible();
  return card;
}
async function connect(page: Page) {
  const card = await review(page);
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Save News connection" }).click();
  await expect(
    card.getByRole("button", { name: "Load my News articles" }),
  ).toBeVisible();
  return card;
}
test("News connection reviews an existing key before storing and loads articles only on explicit request", async ({
  page,
}, info) => {
  const f = await fixture(page),
    card = await review(page);
  await expect(
    card.getByRole("button", { name: "Save News connection" }),
  ).toBeDisabled();
  expect(
    f.calls.filter(
      (c) => c.path.endsWith("/confirm") || c.path.endsWith("/articles"),
    ),
  ).toHaveLength(0);
  await expect(card.getByLabel("Existing News connection key")).toHaveCount(0);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await card.screenshot({
      path: `test-results/news-connection-review-${info.project.name}-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Save News connection" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    card.getByRole("button", { name: "Load my News articles" }),
  ).toBeVisible();
  expect(f.calls.filter((c) => c.path.endsWith("/articles"))).toHaveLength(0);
  await card.getByRole("button", { name: "Load my News articles" }).click();
  await expect(card.getByRole("link", { name: article.title })).toHaveAttribute(
    "href",
    article.url,
  );
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await card.screenshot({
      path: `test-results/news-connection-read-${info.project.name}-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  expect(f.calls.find((c) => c.path.endsWith("/confirm"))?.body).toEqual({
    id,
    confirmed: true,
  });
  expect(f.errors).toEqual([]);
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Remove from this Mac" }).click();
  await expect(card.getByLabel("Existing News connection key")).toBeVisible();
  await expect(card.getByRole("link", { name: article.title })).toHaveCount(0);
});
test("source denial clears an earlier News snapshot without retry or publication calls", async ({
  page,
}) => {
  const f = await fixture(page),
    card = await connect(page);
  await card.getByRole("button", { name: "Load my News articles" }).click();
  await expect(card.getByRole("link", { name: article.title })).toBeVisible();
  f.deny();
  await card.getByRole("button", { name: "Load my News articles" }).click();
  await expect(card.getByRole("alert")).toBeVisible();
  await expect(card.getByRole("link", { name: article.title })).toHaveCount(0);
  expect(f.calls.filter((c) => c.path.endsWith("/articles"))).toHaveLength(2);
  expect(f.calls.some((c) => /publish|curate|delivery/.test(c.path))).toBe(
    false,
  );
  expect(f.errors).toEqual([]);
});
test("focus loss clears News secrets and discards a late private article response", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.card.getByLabel("Existing News connection key").fill(key);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(f.card.getByLabel("Existing News connection key")).toHaveValue(
    "",
  );
  const card = await connect(page);
  f.hold();
  await card.getByRole("button", { name: "Load my News articles" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f
    .pending()!
    .fulfill({
      json: { items: [article], checkedAt: new Date().toISOString() },
    });
  await expect(
    card.getByRole("button", { name: "Load my News articles" }),
  ).toBeEnabled();
  await expect(card.getByRole("link", { name: article.title })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
