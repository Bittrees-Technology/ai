import { test, expect } from "@playwright/test";
test("activity separates saved research, live model work and interrupted jobs", async ({
  page,
}) => {
  const job = {
    id: "active",
    state: "running",
    input: { brief: "Research approved public sources", target: 5 },
    added: 1,
    done: ["https://example.org/team"],
    queue: ["https://example.org/about"],
    failures: [],
    skipped: 2,
    updatedAt: "2026-10-16T12:00:00Z",
    modelName: "Local fixture model",
    activity: {
      phase: "Local model extracting source evidence",
      url: "https://example.org/about",
    },
    crmProgress: {
      crmPeople: 0,
      crmOrganizations: 0,
      researchPeople: 1,
      researchOrganizations: 1,
      checkedAt: "2026-10-16T12:00:00Z",
      entryIds: [],
    },
    results: [
      {
        id: "person",
        name: "Jane Smith",
        title: "Managing Partner",
        url: "https://example.org/team",
        savedAt: "2026-10-16T12:00:00Z",
      },
    ],
  };
  await page.route("**/v1/research/investors", (r) =>
    r.fulfill({
      json: {
        available: true,
        jobs: [
          {
            ...job,
            id: "paused",
            state: "paused",
            added: 0,
            crmProgress: {
              crmPeople: 0,
              crmOrganizations: 0,
              researchPeople: 1,
              researchOrganizations: 1,
              checkedAt: "2026-10-16T12:00:00Z",
              entryIds: [],
            },
            results: [],
            error: "This operation was aborted",
          },
          job,
        ],
      },
    }),
  );
  await page.route("**/v1/workflows/central", (r) =>
    r.fulfill({ json: { configured: false, enabled: false } }),
  );
  await page.goto("/?research-activity");
  await expect(
    page.getByRole("region", { name: "Work lanes", exact: true }),
  ).toBeVisible();
  const progress = page.getByText("Progress & evidence", { exact: true });
  await progress.nth(0).click();
  await progress.nth(1).click();

  await expect(
    page.getByText("1 of 5 people saved as research", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByText("Local model extracting source evidence", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Jane Smith", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Run interrupted; saved progress is preserved."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Source", exact: true }),
  ).toHaveAttribute("href", "https://example.org/team");
  await expect(
    page.getByText("In CRM: 0 people · 0 organizations").first(),
  ).toBeVisible();
  await expect(
    page.getByText("CRM addition not confirmed", { exact: false }),
  ).toBeVisible();
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
test("central activity retains run identity and separates unconfirmed output from completed steps", async ({
  page,
}) => {
  await page.route("**/v1/research/investors", (r) =>
    r.fulfill({ json: { jobs: [] } }),
  );
  await page.route("**/v1/workflows/central", (r) =>
    r.fulfill({
      json: {
        configured: true,
        enabled: true,
        running: false,
        workflowId: "current-workflow",
        currentJob: {
          id: "job-current",
          runId: "run-current",
          title: "Review current sources",
          stepIndex: 1,
          completionPending: true,
          leaseUntil: new Date(Date.now() + 60000).toISOString(),
        },
        lastReceipt: {
          jobId: "job-old",
          workflowId: "old-workflow",
          runId: "run-old",
          stepIndex: 0,
          model: "Local fixture",
          evidenceHash: "a".repeat(64),
          completedAt: "2026-10-29T00:00:00Z",
          followUpQueued: true,
        },
      },
    }),
  );
  await page.goto("/?research-activity");
  const review = page.getByRole("region", { name: "Review", exact: true });
  await expect(review.getByText("Review current sources")).toBeVisible();
  await expect(
    review.getByText("Local output saved; waiting for central confirmation."),
  ).toBeVisible();
  await expect(review.getByRole("link")).toHaveAttribute(
    "href",
    "https://workflow.bittrees.org/?workflow=current-workflow&run=run-current",
  );
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(
    done.getByRole("link", { name: "Open central run" }),
  ).toHaveAttribute(
    "href",
    "https://workflow.bittrees.org/?workflow=old-workflow&run=run-old",
  );
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByText("Review current sources")).toBeVisible();
});
