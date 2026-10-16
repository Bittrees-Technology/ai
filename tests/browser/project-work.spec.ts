import { test, expect } from "@playwright/test";
test("project work uses explicit project/model choices and confirms automatic task saves", async ({
  page,
}) => {
  let submitted: any = null;
  const jobs: any[] = [];
  await page.route("**/v1/crm-projects**", async (route) => {
    if (route.request().url().endsWith("/tasks")) {
      await route.fulfill({
        json: { tasks: [], checkedAt: new Date().toISOString() },
      });
      return;
    }
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

test("CRM task editor preserves drafts on conflict and writes current versions", async ({
  page,
}) => {
  let version = 1;
  let saved: any;
  let conflict = true;
  await page.route("**/v1/crm-projects**", async (route) => {
    if (route.request().url().endsWith("/tasks")) {
      if (route.request().method() === "POST") {
        saved = route.request().postDataJSON();
        if (conflict) {
          await route.fulfill({ status: 409, json: { error: "conflict" } });
          return;
        }
        version++;
        await route.fulfill({ json: { id: "task", version } });
        return;
      }
      await route.fulfill({
        json: {
          tasks: [
            {
              id: "task",
              version,
              name: "Review evidence",
              description: "Original",
              mode: "AI review",
              status: "Open",
              dueDate: "",
            },
          ],
          checkedAt: new Date().toISOString(),
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        available: true,
        projects: [{ id: "project", name: "Connected project", tasks: true }],
        jobs: [],
      },
    });
  });
  await page.goto("/?project-work");
  await page.getByLabel("Project", { exact: true }).selectOption("project");
  await page.getByRole("button", { name: "Edit Review evidence" }).click();
  await page.getByLabel("Task description").fill("Owner's revised brief");
  await page.getByRole("button", { name: "Save task to CRM" }).click();
  await expect(
    page.getByText("Save could not be confirmed", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Task description")).toHaveValue(
    "Owner's revised brief",
  );
  const first = saved;
  conflict = false;
  await page.getByRole("button", { name: "Save task to CRM" }).click();
  await expect(page.getByLabel("Task description")).toHaveCount(0);
  expect(saved).toEqual(first);
  expect(saved.version).toBe(1);
  expect(saved.projectId).toBe("project");
});

test("running job progress does not repeatedly discover remote CRM projects", async ({
  page,
}) => {
  let discoveries = 0,
    polls = 0;
  await page.clock.install();
  await page.route("**/v1/crm-projects**", async (route) => {
    const local = route.request().url().endsWith("/status");
    if (local) polls++;
    else discoveries++;
    await route.fulfill({
      json: {
        available: true,
        ...(local
          ? {}
          : {
              projects: [
                { id: "project", name: "Connected project", tasks: true },
              ],
            }),
        jobs: [
          {
            id: "run",
            state: "running",
            input: { mode: "work" },
            completed: polls,
            receipts: [],
          },
        ],
      },
    });
  });
  await page.goto("/?project-work");
  await expect(page.getByLabel("Project", { exact: true })).toContainText(
    "Connected project",
  );
  await page.clock.runFor(30000);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(discoveries).toBe(1);
  await expect(page.getByLabel("Project", { exact: true })).toContainText(
    "Connected project",
  );
});
