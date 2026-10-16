import { test, expect } from "@playwright/test";
test("project work uses explicit project/model choices and confirms automatic task saves", async ({
  page,
}) => {
  let submitted: any = null;
  const jobs: any[] = [];
  await page.route("**/v1/crm-projects**", async (route) => {
    if (route.request().url().endsWith("/start")) {
      submitted = route.request().postDataJSON();
      jobs.push({
        id: "test",
        state: "complete",
        input: submitted,
        completed: 2,
        receipts: [],
      });
    }
    await route.fulfill({
      json: {
        available: true,
        projects: [
          { id: "project", name: "Connected project", tasks: true },
          { id: "read-only", name: "No task permission", tasks: false },
        ],
        jobs,
      },
    });
  });
  await page.goto("/?project-work");
  await expect(
    page.getByRole("button", { name: "Create tasks with local AI" }),
  ).toBeDisabled();
  await page.getByLabel("Project", { exact: true }).selectOption("project");
  await expect(
    page.getByRole("option", { name: "No task permission" }),
  ).toHaveCount(0);
  await page.getByLabel("Local model profile").selectOption("local-test");
  await page
    .getByLabel("What tasks should")
    .fill("Draft investor qualification questions.");
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "Create tasks with local AI" })
    .click();
  expect(submitted).toBeNull();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Create tasks with local AI" })
    .click();
  await expect(
    page.getByText("complete · 2 confirmed CRM saves"),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    projectId: "project",
    profileId: "local-test",
    mode: "plan",
    confirmed: true,
  });
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
