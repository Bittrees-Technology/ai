import { test, expect } from "@playwright/test";
test("missing native transport prevents permission requests and blind owner enrollment", async ({
  page,
}) => {
  let hostedPermissionReads = 0,
    readinessReads = 0;
  await page.route("**/v1/workflows/readiness", (r) => {
    readinessReads++;
    return r.fulfill({
      json: {
        version: 1,
        nativeTransportAvailable: false,
        sourceStatusVerified: false,
      },
    });
  });
  await page.route("**/v1/workflows/task-sync", (r) =>
    r.fulfill({
      json: { configured: false, reviewReady: true, enrolled: false },
    }),
  );
  await page.route("**/v1/workflows", (r) => {
    hostedPermissionReads++;
    return r.fulfill({
      status: 503,
      json: { error: "Unexpected source request" },
    });
  });
  await page.goto("/?workflow-readiness");
  await expect(
    page.getByRole("region", { name: "Native workflow setup required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect this Mac in Roles" }),
  ).toBeDisabled();
  await expect(page.getByText("Loading permissions…")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => readinessReads).toBe(2);
  expect(hostedPermissionReads).toBe(0);
});
test("supplied capability with denied source status still cannot enable owner review", async ({
  page,
}) => {
  await page.route("**/v1/workflows/readiness", (r) =>
    r.fulfill({
      json: {
        version: 1,
        nativeTransportAvailable: true,
        sourceStatusVerified: false,
      },
    }),
  );
  await page.route("**/v1/workflows/task-sync", (r) =>
    r.fulfill({
      json: { configured: false, reviewReady: true, enrolled: false },
    }),
  );
  await page.route("**/v1/workflows", (r) =>
    r.fulfill({
      status: 403,
      json: { error: "Native consent or source denied" },
    }),
  );
  await page.goto("/?workflow-readiness");
  await expect(
    page.getByText("Workflow permissions could not be verified.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect this Mac in Roles" }),
  ).toBeDisabled();
});
