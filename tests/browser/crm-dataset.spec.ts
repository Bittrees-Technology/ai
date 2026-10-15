import { test, expect } from "@playwright/test";
test("dataset save needs preview, keeps CRM separate and clears approval on edits", async ({
  page,
}) => {
  const id = "a070ec84-953c-4c06-acaf-ecc33756bbd0";
  let saves = 0;
  const snapshot = {
    id,
    name: "Project inventory",
    version: 1,
    entries: [{ id, kind: "projects", name: "Project A" }],
    crm: [{ id, data: { name: "Published source" } }],
    links: [],
    submissions: [],
  };
  await page.route("**/v1/connections/dataset**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result: any = {
      available: true,
      connection: { datasetId: id, name: "Project inventory" },
    };
    if (path.endsWith("/read")) result = snapshot;
    if (path.endsWith("/save")) {
      saves++;
      const body = route.request().postDataJSON();
      snapshot.entries = body.entries;
      snapshot.version++;
      result = { id, version: snapshot.version };
    }
    await route.fulfill({ json: result });
  });
  await page.goto("/?crm-dataset");
  await page
    .getByRole("button", { name: "Read dataset and linked CRM records" })
    .click();
  await expect(
    page.getByRole("button", { name: "Save reviewed private dataset" }),
  ).toHaveCount(0);
  const edit = page.getByLabel("Research dataset JSON");
  const payload = JSON.parse(await edit.inputValue());
  payload.entries[0].name = "Changed project";
  await edit.fill(JSON.stringify(payload));
  await page.getByRole("button", { name: "Preview dataset save" }).click();
  expect(saves).toBe(0);
  await edit.fill(JSON.stringify({ ...payload, name: "Renamed dataset" }));
  await expect(
    page.getByRole("button", { name: "Save reviewed private dataset" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview dataset save" }).click();
  await page
    .getByRole("button", { name: "Save reviewed private dataset" })
    .click();
  await expect(page.getByRole("status")).toContainText("Private dataset saved");
  expect(saves).toBe(1);
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
