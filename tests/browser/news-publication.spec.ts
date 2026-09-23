import { test, expect, type Page, type Route } from "@playwright/test";
const operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const credential = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function source() {
  const item = {
    id: "a".repeat(64),
    source_id: "public:science",
    url: "https://example.org/front",
    title: "Original front headline",
    summary: "Original front summary",
    excerpt: "Exact original excerpt, also public.",
    summary_kind: "user_edited",
    user_edited: true,
    original_title: "Earlier source headline",
    topic: "science",
    kind: "article",
    published_at: "2026-09-23T00:00:00.000Z",
    authors: ["Sample Author"],
    publication: "Sample Publisher",
    tags: ["science"],
    briefing_preview: "Full public briefing preview.",
    translation: {
      title: "Translated front headline",
      summary: "Translated front summary.\nExact second line.",
      language: "en",
      model: "sample-local",
    },
  };
  return {
    contractVersion: "news-reviewed-publication-v1",
    revision: 7,
    publicationVersion: 2,
    reviewDigest: "d".repeat(64),
    url: "https://news.bittrees.org/my-news",
    content: {
      name: "Your reviewed edition",
      slug: "my-news",
      description: "Public description.",
      navigation: [{ name: "Latest science", slug: "science" }],
      snapshot: {
        front: [item],
        feeds: [
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            name: "Saved science section",
            slug: "science",
            items: [
              {
                ...item,
                id: "b".repeat(64),
                title: "Named feed headline",
                summary: "Named feed text must be reviewed.",
                url: "https://example.org/feed",
                translation: undefined,
                user_edited: false,
                summary_kind: "excerpt",
              },
            ],
          },
        ],
        builtAt: "2026-09-23T00:00:00.000Z",
      },
    },
    eligibility: { eligible: true, blockedItemIds: [] },
    previousPublication: {
      published: true,
      lastPublishedAt: "2026-09-22T00:00:00.000Z",
      snapshotDigest: "e".repeat(64),
    },
    observedAt: "2026-09-23T09:00:00.000Z",
  };
}
async function fixture(
  page: Page,
  opts: { publish?: boolean; blocked?: boolean; connected?: boolean } = {},
) {
  let review: any = {
    id: operation,
    source: source(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  if (opts.blocked)
    review.source.eligibility = {
      eligible: false,
      blockedItemIds: ["b".repeat(64)],
    };
  let record: any,
    uncertain = false,
    receiptFound = true,
    hold: "review" | "confirm" | null = null,
    pending: Route | undefined;
  const calls: { path: string; body: any }[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const receipt = () => ({
    contractVersion: "news-reviewed-publication-v1",
    operationId: operation,
    reviewDigest: review.source.reviewDigest,
    revision: 7,
    publicationVersion: 3,
    url: review.source.url,
    committedAt: new Date().toISOString(),
    status: "published",
    historical: true,
  });
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
      if (path.endsWith("/publication/review")) {
        if (hold === "review") {
          pending = route;
          return;
        }
        json = review;
      } else if (path.endsWith("/publication/confirm")) {
        record = {
          operationId: operation,
          identity: { accountId: account, credentialId: credential },
          review: review.source,
          confirmed: true,
          audience: "public",
          recordedAt: new Date().toISOString(),
          receipt: uncertain ? null : receipt(),
          lastCheckedAt: null,
        };
        if (hold === "confirm") {
          pending = route;
          return;
        }
        if (uncertain)
          return route.fulfill({
            status: 400,
            json: { error: "NEWS_PUBLICATION_UNCONFIRMED" },
          });
        json = record;
      } else if (path.endsWith("/publication/history"))
        json = {
          items: record
            ? [
                {
                  operationId: record.operationId,
                  identity: record.identity,
                  name: record.review.content.name,
                  url: record.review.url,
                  recordedAt: record.recordedAt,
                  receipt: record.receipt,
                  lastCheckedAt: record.lastCheckedAt,
                },
              ]
            : [],
        };
      else if (path.includes("/publication/history/")) json = record;
      else if (path.endsWith("/publication/reconcile")) {
        record = {
          ...record,
          receipt: receiptFound ? receipt() : null,
          lastCheckedAt: new Date().toISOString(),
        };
        json = record;
      } else if (path.endsWith("/publication/delete")) {
        record = undefined;
        json = { removed: true, sourceWithdrawn: false };
      } else if (path.endsWith("/publication/cancel"))
        json = { cancelled: true };
      else
        json = {
          available: true,
          publication: "per_action_review",
          connection:
            opts.connected === false
              ? null
              : {
                  accountId: account,
                  credentialId: credential,
                  expiresAt: "2050-01-01T00:00:00.000Z",
                  state: "stored",
                  scopes:
                    opts.publish === false
                      ? ["read"]
                      : ["read", "curate", "publish"],
                },
        };
    }
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "News publication",
    exact: true,
  });
  await expect(panel).toBeVisible();
  return {
    panel,
    calls,
    errors,
    review: () => review,
    setExpiry: (s: number) => {
      review.expiresAt = new Date(Date.now() + s).toISOString();
    },
    uncertain: () => {
      uncertain = true;
    },
    receiptFound: (b: boolean) => {
      receiptFound = b;
    },
    hold: (kind: "review" | "confirm") => {
      hold = kind;
    },
    pending: () => pending,
    result: () => record,
  };
}
async function load(f: Awaited<ReturnType<typeof fixture>>) {
  await f.panel
    .getByRole("button", { name: "Review public edition", exact: true })
    .click();
  const review = f.panel.getByRole("region", {
    name: "Review public edition",
    exact: true,
  });
  await expect(review).toBeVisible();
  return review;
}
test("public review shows every section and public text; separate keyboard confirmation records a historical receipt", async ({
  page,
}, info) => {
  const f = await fixture(page),
    review = await load(f),
    publish = review.getByRole("button", {
      name: "Publish reviewed edition",
      exact: true,
    });
  await expect(
    review.getByRole("heading", {
      name: "Translated front headline",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review.getByRole("heading", { name: "Named feed headline", exact: true }),
  ).toBeVisible();
  await expect(
    review
      .getByText("Named feed text must be reviewed.", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    review.getByText("Latest science", { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("link", { name: "https://example.org/feed", exact: true }),
  ).toBeVisible();
  const front = review.getByRole("region", { name: "Public front page" });
  await front
    .getByText("All public text and story details", { exact: true })
    .click();
  for (const text of [
    "Original front headline",
    "Original front summary",
    "Exact original excerpt, also public.",
    "Full public briefing preview.",
    "Earlier source headline",
  ])
    await expect(front.getByText(text, { exact: true })).toBeVisible();
  await front
    .getByText("All public text and story details", { exact: true })
    .click();
  await expect(publish).toBeDisabled();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await review.screenshot({
      path: `test-results/news-publication-review-${info.project.name}-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await review.getByRole("checkbox").check();
  await publish.focus();
  await page.keyboard.press("Enter");
  const saved = f.panel.getByRole("article", {
    name: "Selected publication record",
  });
  await expect(
    saved.getByRole("heading", { name: "Historical publication receipt" }),
  ).toBeVisible();
  await expect(saved).toContainText(
    "does not verify that the edition is still public",
  );
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await saved.screenshot({
      path: `test-results/news-publication-receipt-${info.project.name}-${width}.png`,
    });
  }
  expect(
    f.calls.filter((c) => c.path.endsWith("/publication/confirm")),
  ).toEqual([
    {
      path: "/v1/connections/news/publication/confirm",
      body: { id: operation, confirmed: true, audience: "public" },
    },
  ]);
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("article", { name: "News connection", exact: true })
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  await expect(
    f.panel.getByRole("button", { name: "Review public edition", exact: true }),
  ).toBeDisabled();
  await f.panel
    .getByRole("button", { name: "Load publication history" })
    .click();
  await f.panel
    .getByRole("button", { name: "Open publication record" })
    .click();
  await expect(
    f.panel.getByRole("button", { name: "Check publication receipt" }),
  ).toBeDisabled();
  await expect(
    f.panel.getByRole("article", { name: "Selected publication record" }),
  ).toBeVisible();
  expect(f.errors).toEqual([]);
});
test("unconfirmed publication loads durable history, checks absent receipt without resending, then deletes only after separate acknowledgement", async ({
  page,
}, info) => {
  const f = await fixture(page),
    review = await load(f);
  f.uncertain();
  await review.getByRole("checkbox").check();
  await review
    .getByRole("button", { name: "Publish reviewed edition" })
    .click();
  await expect(f.panel.getByRole("alert")).toContainText(
    "could not be confirmed",
  );
  await f.panel
    .getByRole("button", { name: "Load publication history" })
    .click();
  await f.panel
    .getByRole("button", { name: "Open publication record" })
    .click();
  const record = f.panel.getByRole("article", {
    name: "Selected publication record",
  });
  await expect(
    record.getByRole("heading", { name: "Unconfirmed publication" }),
  ).toBeVisible();
  f.receiptFound(false);
  await record
    .getByRole("button", { name: "Check publication receipt" })
    .click();
  await expect(f.panel.getByRole("status")).toContainText(
    "No receipt was found",
  );
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await record.screenshot({
      path: `test-results/news-publication-unconfirmed-${info.project.name}-${width}.png`,
    });
  }
  await expect(
    record.getByRole("button", { name: "Delete local publication record" }),
  ).toBeDisabled();
  await record.getByRole("checkbox").check();
  await record
    .getByRole("button", { name: "Delete local publication record" })
    .click();
  await expect(record).toHaveCount(0);
  await expect(f.panel.getByRole("status")).toContainText(
    "accepted publication continues",
  );
  expect(
    f.calls.filter((c) => c.path.endsWith("/publication/confirm")),
  ).toHaveLength(1);
  expect(
    f.calls.filter((c) => c.path.endsWith("/publication/reconcile")),
  ).toHaveLength(1);
  expect(
    f.calls.filter((c) => c.path.endsWith("/publication/delete"))[0]!.body,
  ).toEqual({
    operationId: operation,
    confirmed: true,
    forgetPublicationTracking: true,
  });
  expect(f.errors).toEqual([]);
});
test("publication cancel, focus loss and expiry discard consent, including a delayed review response", async ({
  page,
}) => {
  const f = await fixture(page);
  let review = await load(f);
  await review.getByRole("checkbox").check();
  await review
    .getByRole("button", { name: "Cancel publication review" })
    .click();
  await expect(review).toHaveCount(0);
  await expect
    .poll(
      () =>
        f.calls.filter((c) => c.path.endsWith("/publication/cancel")).length,
    )
    .toBe(1);
  review = await load(f);
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(review).toHaveCount(0);
  f.setExpiry(1500);
  review = await load(f);
  await expect(review).toHaveCount(0, { timeout: 4000 });
  f.setExpiry(120000);
  f.hold("review");
  await f.panel
    .getByRole("button", { name: "Review public edition", exact: true })
    .click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.pending()!.fulfill({ json: f.review() });
  await expect(
    f.panel.getByRole("button", { name: "Review public edition", exact: true }),
  ).toBeEnabled();
  await expect(review).toHaveCount(0);
  expect(f.calls.some((c) => c.path.endsWith("/publication/confirm"))).toBe(
    false,
  );
  expect(f.errors).toEqual([]);
});
test("source-blocked feeds cannot publish and a read-only connection cannot request publication", async ({
  page,
}, info) => {
  const f = await fixture(page, { blocked: true }),
    review = await load(f);
  await expect(review.getByRole("checkbox")).toBeDisabled();
  await expect(
    review.getByRole("button", { name: "Publish reviewed edition" }),
  ).toBeDisabled();
  await expect(
    review.getByText("This story cannot be published.", { exact: false }),
  ).toBeVisible();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await review.screenshot({
      path: `test-results/news-publication-blocked-${info.project.name}-${width}.png`,
    });
  }
  expect(f.calls.some((c) => c.path.endsWith("/publication/confirm"))).toBe(
    false,
  );
  const cancelled = page.waitForResponse(
    (r) =>
      r.url().endsWith("/publication/cancel") &&
      r.request().method() === "POST",
  );
  await review
    .getByRole("button", { name: "Cancel publication review" })
    .click();
  await cancelled;
  await page.unrouteAll({ behavior: "wait" });
  const reader = await fixture(page, { publish: false });
  await expect(
    reader.panel.getByRole("button", {
      name: "Review public edition",
      exact: true,
    }),
  ).toBeDisabled();
  await reader.panel
    .getByRole("button", { name: "Load publication history" })
    .click();
  expect(reader.calls.some((c) => c.path.endsWith("/publication/review"))).toBe(
    false,
  );
  expect(f.errors.concat(reader.errors)).toEqual([]);
});
test("leaving while publication is in flight cannot restore content or resend; explicit history recovers the recorded receipt", async ({
  page,
}) => {
  const f = await fixture(page),
    review = await load(f);
  f.hold("confirm");
  await review.getByRole("checkbox").check();
  await review
    .getByRole("button", { name: "Publish reviewed edition" })
    .click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.pending()!.fulfill({ json: f.result() });
  await expect(
    f.panel.getByRole("button", { name: "Load publication history" }),
  ).toBeEnabled();
  await expect(
    f.panel.getByRole("article", { name: "Selected publication record" }),
  ).toHaveCount(0);
  await expect(f.panel.getByRole("status")).toHaveCount(0);
  await f.panel
    .getByRole("button", { name: "Load publication history" })
    .click();
  await f.panel
    .getByRole("button", { name: "Open publication record" })
    .click();
  await expect(
    f.panel.getByRole("heading", { name: "Historical publication receipt" }),
  ).toBeVisible();
  expect(
    f.calls.filter((c) => c.path.endsWith("/publication/confirm")),
  ).toHaveLength(1);
  expect(f.errors).toEqual([]);
});
