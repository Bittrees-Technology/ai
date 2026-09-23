import { test, expect, type Page, type Route } from "@playwright/test";
const item = {
  id: "a".repeat(64),
  source_id: "private:synthetic",
  title: "Original private headline",
  url: "https://example.org/source",
  excerpt: "Source excerpt stays unchanged.",
  summary: "Original summary",
  summary_kind: "excerpt",
  user_edited: false,
  published_at: "2026-09-23T00:00:00.000Z",
};
async function fixture(page: Page, curate = true) {
  let current = {
    name: "Your private newspaper",
    revision: 7,
    front: [item],
    feedCount: 2,
    exists: true,
    checkedAt: "2026-09-23T09:00:00.000Z",
  };
  let edited: any,
    uncertain = false,
    hold = false,
    pending: Route | undefined;
  const calls: { path: string; body: any }[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
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
      const body = req.postData() ? req.postDataJSON() : null;
      calls.push({ path, body });
      if (path.endsWith("/curation/review")) {
        edited = body;
        json = {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          revision: current.revision,
          name: current.name,
          before: current.front[0],
          after: body,
          feedCount: 2,
        };
      } else if (path.endsWith("/curation/confirm")) {
        current = {
          ...current,
          revision: 8,
          front: [
            {
              ...item,
              title: edited.title,
              summary: edited.summary,
              summary_kind: "user_edited",
              user_edited: true,
            },
          ],
        };
        if (hold) {
          pending = route;
          return;
        }
        if (uncertain)
          return route.fulfill({
            status: 400,
            json: { error: "NEWS_SAVE_UNCONFIRMED" },
          });
        json = { saved: true, published: false, preview: current };
      } else if (path.endsWith("/preview")) json = current;
      else
        json = {
          available: true,
          connection: {
            accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            expiresAt: "2050-01-01T00:00:00.000Z",
            scopes: curate
              ? ["read", "curate", "publish", "delivery"]
              : ["read"],
            state: "stored",
          },
        };
    }
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Private News preview" });
  await panel
    .getByRole("button", { name: "Load private preview", exact: true })
    .click();
  await expect(panel.getByRole("link", { name: item.title })).toBeVisible();
  return {
    panel,
    calls,
    errors,
    uncertain: () => {
      uncertain = true;
    },
    hold: () => {
      hold = true;
    },
    pending: () => pending,
    result: () => current,
  };
}
async function review(page: Page) {
  const panel = page.getByRole("region", { name: "Private News preview" });
  await panel.getByRole("button", { name: "Edit this story" }).click();
  await panel
    .getByLabel("Headline", { exact: true })
    .fill("Reviewed private headline");
  await panel
    .getByLabel("Summary", { exact: true })
    .fill("Exact owner text.\nSecond line remains visible.");
  await panel.getByRole("button", { name: "Review story change" }).click();
  await expect(
    panel.getByRole("heading", { name: "Review the exact change" }),
  ).toBeVisible();
  return panel;
}
test("News story edit shows exact before/after, invalidates changes and needs separate curation confirmation", async ({
  page,
}, info) => {
  const f = await fixture(page),
    panel = await review(page),
    save = panel.getByRole("button", { name: "Save reviewed story" });
  await expect(save).toBeDisabled();
  expect(
    f.calls.filter((c) => c.path.endsWith("/curation/confirm")),
  ).toHaveLength(0);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await panel.screenshot({
      path: `test-results/news-curation-review-${info.project.name}-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await panel.getByRole("button", { name: "Cancel story review" }).click();
  await expect(save).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Load private preview", exact: true }),
  ).toBeEnabled();
  expect(f.calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Load private preview", exact: true })
    .click();
  await review(page);
  await panel.getByRole("checkbox").check();
  await panel
    .getByLabel("Headline", { exact: true })
    .fill("Changed after review");
  await expect(save).toHaveCount(0);
  await panel.getByRole("button", { name: "Review story change" }).click();
  await expect(save).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("status")).toContainText(
    "Nothing was published or sent",
  );
  await expect(
    panel.getByRole("link", { name: "Changed after review" }),
  ).toBeVisible();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await panel.screenshot({
      path: `test-results/news-curation-saved-${info.project.name}-${width}.png`,
    });
  }
  expect(f.calls.filter((c) => c.path.endsWith("/curation/confirm"))).toEqual([
    {
      path: "/v1/connections/news/curation/confirm",
      body: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        confirmed: true,
        curate: true,
      },
    },
  ]);
  expect(
    f.calls.some((c) => /publish|subscription|generate|delivery/.test(c.path)),
  ).toBe(false);
  expect(f.errors).toEqual([]);
});
test("News read-only connection can view a preview without edit controls", async ({
  page,
}) => {
  const f = await fixture(page, false);
  await expect(
    f.panel.getByRole("button", { name: "Edit this story" }),
  ).toHaveCount(0);
  await expect(
    f.panel.getByText("This key allows reading only.", { exact: false }),
  ).toBeVisible();
  expect(f.calls.some((c) => c.path.includes("curation"))).toBe(false);
  expect(f.errors).toEqual([]);
});
test("News uncertain save clears review and reconciles only on explicit source reload", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await review(page);
  f.uncertain();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Save reviewed story" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "save could not be confirmed",
  );
  await expect(
    panel.getByRole("button", { name: "Save reviewed story" }),
  ).toHaveCount(0);
  expect(
    f.calls.filter((c) => c.path.endsWith("/curation/confirm")),
  ).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Load private preview", exact: true })
    .click();
  await expect(
    panel.getByRole("link", { name: "Reviewed private headline" }),
  ).toBeVisible();
  expect(
    f.calls.filter((c) => c.path.endsWith("/curation/confirm")),
  ).toHaveLength(1);
  expect(f.errors).toEqual([]);
});
test("News focus loss discards a late curation response without undoing or retrying the source save", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await review(page);
  f.hold();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Save reviewed story" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f
    .pending()!
    .fulfill({ json: { saved: true, published: false, preview: f.result() } });
  await expect(
    panel.getByRole("button", { name: "Load private preview", exact: true }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("link", { name: "Reviewed private headline" }),
  ).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveCount(0);
  expect(
    f.calls.filter((c) => c.path.endsWith("/curation/confirm")),
  ).toHaveLength(1);
  expect(f.errors).toEqual([]);
});
