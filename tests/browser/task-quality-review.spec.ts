import { test, expect, type Page, type Route } from "@playwright/test";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(page: Page) {
  let state = {
    taskId: id,
    taskRevision: 3,
    runId: "synthetic-run",
    model: { profile: { model: "synthetic:local" } },
    durationMs: 1250,
    reviewRevision: 0,
    review: null as null | { outcome: string; note: string },
    updatedAt: null as number | null,
  };
  const writes: any[] = [];
  let deny = false,
    lose = false,
    hold = false,
    pending: Route | undefined;
  await page.route("**/*", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    let json: unknown = {};
    if (path.endsWith("/quality-review")) {
      if (deny)
        return route.fulfill({ status: 400, json: { error: "SOURCE_DENIED" } });
      if (request.method() === "PUT") {
        const input = request.postDataJSON();
        if (!writes.some((w) => w.operationId === input.operationId))
          state = {
            ...state,
            reviewRevision: state.reviewRevision + 1,
            review: input.review,
            updatedAt: 1,
          };
        writes.push(input);
        if (lose) {
          lose = false;
          return route.fulfill({
            status: 503,
            json: { error: "LOCAL_UNAVAILABLE" },
          });
        }
      } else if (hold) {
        hold = false;
        pending = route;
        return;
      }
      json = state;
    } else if (path === "/v1/requests")
      json = {
        items: [
          {
            id,
            revision: 3,
            status: "completed",
            input: { prompt: "Synthetic review task", modelProfileId: "p" },
            result: { text: "Synthetic result" },
          },
        ],
      };
    else if (path.endsWith("/runs"))
      json = {
        items: [
          { id: "synthetic-run", outcome: "completed", model: state.model },
        ],
      };
    else if (
      ["/v1/profiles", "/v1/memories", "/v1/inboxes", "/v1/imports"].includes(
        path,
      )
    )
      json = { items: [] };
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page
    .locator(".tasklist")
    .getByRole("button", { name: /Synthetic review task/ })
    .click();
  const review = page.getByRole("region", { name: "Your quality review" });
  await expect(review.getByRole("radio", { name: "Used as-is" })).toBeVisible();
  return {
    review,
    writes,
    deny: () => {
      deny = true;
    },
    lose: () => {
      lose = true;
    },
    hold: () => {
      hold = true;
    },
    pending: () => pending,
    snapshot: () => structuredClone(state),
  };
}
async function draft(page: Page, note = "The date needed correction.") {
  const review = page.getByRole("region", { name: "Your quality review" });
  await review.getByRole("radio", { name: "Needed edits" }).check();
  await review.getByLabel("Optional review note").fill(note);
  await review
    .getByRole("checkbox", { name: "I reviewed this result." })
    .check();
}
test("human review requires confirmation, saves one exact run, deletes independently and remains readable", async ({
  page,
}, info) => {
  const f = await fixture(page),
    save = f.review.getByRole("button", { name: "Save my review" });
  await expect(save).toBeDisabled();
  await draft(page);
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(f.review.getByText("Your review was saved.")).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({
    expectedTaskRevision: 3,
    runId: "synthetic-run",
    expectedReviewRevision: 0,
    review: { outcome: "edited", note: "The date needed correction." },
    confirmed: true,
  });
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({
      path: `test-results/task-quality-${info.project.name}-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await f.review
    .getByLabel("Optional review note")
    .fill("A different correction.");
  await expect(save).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await f.review.getByRole("button", { name: "Delete my review" }).click();
  await expect(f.review.getByText("Your review was deleted.")).toBeVisible();
  expect(f.writes[1].review).toBeNull();
  expect(f.writes[1].expectedReviewRevision).toBe(1);
  await expect(
    page
      .getByRole("region", { name: "Run history" })
      .getByText(/synthetic:local/),
  ).toBeVisible();
});
test("uncertain save preserves input and exact user retry does not add another review", async ({
  page,
}) => {
  const f = await fixture(page);
  await draft(page, "PRIVATE_REVIEW_NOTE");
  f.lose();
  await f.review.getByRole("button", { name: "Save my review" }).click();
  await expect(f.review.getByText(/save could not be confirmed/)).toBeVisible();
  await expect(f.review.getByLabel("Optional review note")).toHaveValue(
    "PRIVATE_REVIEW_NOTE",
  );
  expect(f.writes).toHaveLength(1);
  await f.review.getByRole("button", { name: "Save my review" }).click();
  await expect(f.review.getByText("Your review was saved.")).toBeVisible();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(f.snapshot().reviewRevision).toBe(1);
});
test("late reads cannot overwrite a newer save and source denial clears the visible review", async ({
  page,
}) => {
  const f = await fixture(page),
    old = f.snapshot();
  await draft(page);
  f.hold();
  await f.review.getByRole("button", { name: "Refresh review" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await f.review.getByRole("button", { name: "Save my review" }).click();
  await expect(f.review.getByText("Your review was saved.")).toBeVisible();
  await f.pending()!.fulfill({ json: old });
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await expect(f.review.getByText("Saved review: Needed edits")).toBeVisible();
  f.deny();
  await f.review.getByRole("button", { name: "Refresh review" }).click();
  await expect(f.review.getByText(/Review unavailable/)).toBeVisible();
  await expect(f.review.getByLabel("Optional review note")).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
});
test("leaving the window clears unsaved notes and discards an earlier response", async ({
  page,
}) => {
  const f = await fixture(page);
  await draft(page, "PRIVATE_UNSAVED_REVIEW");
  const old = f.snapshot();
  f.hold();
  await f.review.getByRole("button", { name: "Refresh review" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.pending()!.fulfill({ json: old });
  await expect(f.review.getByText(/Review hidden/)).toBeVisible();
  await expect(f.review.getByLabel("Optional review note")).toHaveCount(0);
  expect(f.writes).toHaveLength(0);
});
