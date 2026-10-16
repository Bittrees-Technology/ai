import { test, expect } from "@playwright/test";
test("qualification previews labels, scopes source research and preserves profile fields", async ({
  page,
}) => {
  const projectId = "a070ec84-953c-4c06-acaf-ecc33756bbd0",
    entryId = "b070ec84-953c-4c06-acaf-ecc33756bbd0";
  const ctx = {
    datasetId: projectId,
    datasetVersion: 1,
    projectName: "BBRF-PT",
    entries: [
      {
        entry: {
          id: entryId,
          kind: "people",
          name: "Jane Smith",
          category: "BBRF-PT | Priority research",
          website: "https://example.org/team",
        },
        record: { id: entryId, version: 1, category: "Original category" },
      },
    ],
  };
  let sync = 0,
    start: any;
  await page.route("**/v1/crm-projects", (r) =>
    r.fulfill({
      json: {
        projects: [
          { id: projectId, name: "BBRF-PT", qualification: true },
          { id: entryId, name: "Unconnected", qualification: false },
        ],
      },
    }),
  );
  await page.route("**/v1/research/qualification**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    let result: any = { available: true, jobs: [] };
    if (path.endsWith("/context")) result = ctx;
    if (path.endsWith("/sync")) {
      const a = r.request().postDataJSON();
      expect(a).toEqual({
        confirmed: true,
        projectId,
        datasetVersion: 1,
        entries: [{ entryId, recordVersion: 1 }],
      });
      sync++;
      ctx.entries[0]!.record.category = ctx.entries[0]!.entry.category;
      result = { receipts: [{ entryId, unchanged: false }] };
    }
    if (path.endsWith("/start")) {
      start = r.request().postDataJSON();
      result = { id: projectId };
    }
    await r.fulfill({ json: result });
  });
  await page.goto("/?qualification");
  await page.getByRole("button", { name: "Load connected projects" }).click();
  await page.getByLabel("Qualification project").selectOption(projectId);
  await expect(
    page.getByRole("option", { name: "Unconnected", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview people and labels" }).click();
  expect(sync).toBe(0);
  await page.getByText("Label sync preview", { exact: true }).click();
  await expect(
    page.getByText(
      "Jane Smith: Original category → BBRF-PT | Priority research",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sync previewed labels only" })
    .click();
  await expect(page.getByRole("status")).toContainText("1 labels reconciled");
  expect(sync).toBe(1);
  await page
    .getByLabel("Local model", { exact: true })
    .selectOption("local-model");
  await page
    .getByRole("button", { name: "Research 1 selected people and sync labels" })
    .click();
  await expect.poll(() => start?.entryIds).toEqual([entryId]);
  expect(start.urls).toEqual(["https://example.org/team"]);
  expect(start.projectId).toBe(projectId);
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
