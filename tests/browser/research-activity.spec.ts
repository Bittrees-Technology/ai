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
  await page.goto("/?research-activity");
  await expect(
    page.getByText("1 of 5 people saved as research", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Local model extracting source evidence", { exact: false }),
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
