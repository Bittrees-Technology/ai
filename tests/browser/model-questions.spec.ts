import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic:local",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0,
};
const id = "00000000-0000-4000-8000-000000000001";
async function screenshots(page: Page, source: string, browser: string) {
  await mkdir("test-results/model-question-ui", { recursive: true });
  await page.screenshot({
    path: `test-results/model-question-ui/${source}-${browser}-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `test-results/model-question-ui/${source}-${browser}-phone.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
test("local task opt-in is visible and a changed choice cannot reuse an uncertain original submission", async ({
  page,
}, info) => {
  const posts: { body: any; key: string }[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    if (path === "/v1/requests" && route.request().method() === "POST") {
      posts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"]!,
      });
      return route.fulfill({
        status: 503,
        json: { error: "LOCAL_UNAVAILABLE" },
      });
    }
    const json =
      path === "/v1/profiles"
        ? { items: [profile], defaultProfile: profile }
        : path === "/v1/models"
          ? { items: [{ name: profile.model }] }
          : { items: [] };
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await expect(
    page.getByRole("button", { name: "Lock workspace" }),
  ).toBeVisible();
  await page
    .getByLabel("What would you like to work on?")
    .fill("Prepare my travel checklist.");
  const choice = page.getByRole("checkbox", {
    name: "Ask me if details are missing",
    exact: true,
  });
  await expect(choice).not.toBeChecked();
  await choice.check();
  await expect(
    page.getByText(/Up to two questions, each waiting at most one day/),
  ).toBeVisible();
  await screenshots(page, "local", info.project.name);
  const start = page.getByRole("button", { name: "Start task", exact: true });
  await start.click();
  await expect.poll(() => posts.length).toBe(1);
  await start.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[0]!.body.allowQuestions).toBe(true);
  expect(posts[1]).toEqual(posts[0]);
  await choice.uncheck();
  await start.click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]!.body.allowQuestions).toBeUndefined();
  expect(posts[2]!.key).not.toBe(posts[0]!.key);
});
for (const source of ["crm", "autonote", "mail"] as const) {
  test(`${source} local draft explicitly forwards its question choice without changing source selection`, async ({
    page,
  }, info) => {
    const posts: any[] = [];
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await page.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/drafts")) {
        posts.push(route.request().postDataJSON());
        return route.fulfill({ json: { id } });
      }
      let json: unknown = { items: [] };
      if (path.endsWith("/records"))
        json = { items: [{ id, kind: "project", name: "Synthetic project" }] };
      if (path.endsWith("/meetings"))
        json = {
          items: [{ id, title: "Synthetic planning meeting", version: 1 }],
        };
      if (path === "/v1/connections/mail")
        json = {
          available: true,
          connection: { state: "stored", grantId: id, expiresAt },
        };
      if (path.endsWith("/selection"))
        json = {
          mailbox: "synthetic@example.test",
          folder: "INBOX",
          scopes: ["metadata"],
          expiresAt,
          message: {
            id,
            from: "sender@example.test",
            subject: "Synthetic planning",
            date: "",
            sourceVersion: 1,
            truncatedMetadata: [],
          },
        };
      await route.fulfill({ json });
    });
    await page.goto(`/?question-forms&source=${source}`);
    await page
      .getByRole("button", {
        name:
          source === "crm"
            ? "Load permitted records"
            : source === "autonote"
              ? "Load permitted meeting"
              : "Load selected message headers",
        exact: true,
      })
      .click();
    if (source === "crm")
      await page.getByRole("checkbox", { name: /Synthetic project/ }).check();
    const choice = page.getByRole("checkbox", {
      name: "Ask me if details are missing",
      exact: true,
    });
    await expect(choice).not.toBeChecked();
    await choice.check();
    await screenshots(page, source, info.project.name);
    await page
      .getByRole("button", { name: "Create local draft", exact: true })
      .click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].allowQuestions).toBe(true);
    expect(posts[0].modelProfileId).toBe("local");
    if (source === "crm") expect(posts[0].recordIds).toEqual([id]);
    if (source === "autonote") expect(posts[0].meetingId).toBe(id);
    if (source === "mail") expect(posts[0].content).toBe("metadata");
  });
}
