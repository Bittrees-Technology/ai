import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
test("companion approval setup shows source consent, stores a code once and removes locally", async ({
  page,
}, info) => {
  const base = "/v1/connections/autonote-approval",
    id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let stored = false,
    exchanges = 0,
    cancels = 0;
  await page.route("**/v1/connections/autonote-approval**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === base)
      return route.fulfill({
        json: {
          available: true,
          connection: stored
            ? {
                meetingId: id,
                state: "stored",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              }
            : null,
        },
      });
    if (path === base + "/begin")
      return route.fulfill({
        json: {
          id,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          consentUrl:
            "https://autonote.bittrees.org/connect/ai?approval_grant=" +
            id +
            "&approval_challenge=" +
            "a".repeat(43),
        },
      });
    if (path === base + "/cancel") {
      cancels++;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === base + "/finish") {
      expect(request.postDataJSON()).toEqual({ id, code: "b".repeat(64) });
      exchanges++;
      stored = true;
      return route.fulfill({ json: { state: "stored" } });
    }
    if (path === base + "/local") {
      expect(request.headers()["x-confirm-delete"]).toBe(
        "local-autonote-approval-credential",
      );
      stored = false;
      return route.fulfill({ status: 204 });
    }
    throw Error("Unexpected request");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?autonote-approval");
  const region = page.getByRole("article", { name: "AutoNote approval setup" });
  await region
    .getByRole("button", { name: "Set up approval permission", exact: true })
    .click();
  await expect(
    region.getByRole("link", {
      name: "Review this permission in AutoNote",
      exact: true,
    }),
  ).toHaveAttribute("href", /approval_grant=/);
  await expect(
    region.getByRole("button", {
      name: "Save approval permission on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  await region
    .getByRole("button", { name: "Cancel approval setup", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Set up approval permission", exact: true })
    .click();
  await expect(
    region.getByLabel("AutoNote approval code", { exact: true }),
  ).toHaveValue("");
  await mkdir("test-results/autonote-approval", { recursive: true });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-phone.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-desktop.png`,
  });
  await region
    .getByLabel("AutoNote approval code", { exact: true })
    .fill("b".repeat(64));
  await region
    .getByRole("button", {
      name: "Save approval permission on this Mac",
      exact: true,
    })
    .click();
  await expect(
    region.getByText("Approval permission: stored.", { exact: false }),
  ).toBeVisible();
  await expect(
    region.getByLabel("AutoNote approval code", { exact: true }),
  ).toHaveCount(0);
  await region
    .getByRole("button", { name: "Remove approval from this Mac", exact: true })
    .click();
  await expect(
    region.getByRole("button", {
      name: "Set up approval permission",
      exact: true,
    }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
  expect(cancels).toBe(1);
});
