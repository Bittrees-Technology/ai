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
  await page
    .getByText("Other sync and permission settings", { exact: true })
    .click();
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
  await page
    .getByText("Other sync and permission settings", { exact: true })
    .click();
  await expect(
    page.getByText("Workflow permissions could not be verified.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect this Mac in Roles" }),
  ).toBeDisabled();
});

test("a native review leads to one Roles request and confirmation", async ({
  page,
}) => {
  let reads = 0;
  const actions: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(window, "webkit", {
      value: {
        messageHandlers: {
          reviewWorkflowEnrollment: {
            postMessage: async (message: unknown) => message === null,
          },
        },
      },
    });
  });
  await page.route("**/v1/workflows/central/connection", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json:
          ++reads === 1
            ? { available: true, ready: false }
            : {
                available: true,
                ready: true,
                state: { status: "not-started" },
              },
      });
    const { action } = route.request().postDataJSON();
    actions.push(action);
    return route.fulfill({
      json: {
        available: true,
        ready: true,
        state:
          action === "start"
            ? {
                status: "pending",
                reviewUrl: "https://roles.bittrees.org/review/example",
              }
            : { status: "complete" },
      },
    });
  });
  await page.goto("/?workflow-readiness");
  const setup = page.getByRole("region", {
    name: "Connect this Mac to Workflows",
  });
  await setup.getByRole("button", { name: "Review this Mac" }).click();
  await expect(
    setup.getByRole("link", { name: "Open Roles review" }),
  ).toBeVisible();
  expect(actions).toEqual(["start"]);
  await setup
    .getByRole("button", { name: "Already approved? Confirm connection" })
    .click();
  await expect(
    setup.getByText("This Mac is registered.", { exact: false }),
  ).toBeVisible();
  expect(actions).toEqual(["start", "poll"]);
});

test("cancelling the native review does not send a Roles request", async ({
  page,
}) => {
  let posts = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, "webkit", {
      value: {
        messageHandlers: {
          reviewWorkflowEnrollment: { postMessage: async () => false },
        },
      },
    });
  });
  await page.route("**/v1/workflows/central/connection", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ json: { available: true, ready: false } });
  });
  await page.goto("/?workflow-readiness");
  const review = page.getByRole("button", { name: "Review this Mac" });
  await review.click();
  await expect(review).toBeEnabled();
  expect(posts).toBe(0);
});

test("an expired native review keeps the original request visible without another POST", async ({
  page,
}) => {
  const start = new Date("2026-11-09T15:26:00Z");
  await page.clock.install({ time: start });
  const requests: string[] = [];
  await page.route("**/v1/workflows/central/connection", (route) => {
    requests.push(route.request().method());
    return route.fulfill({
      json:
        requests.length === 1
          ? {
              available: true,
              ready: true,
              originalReviewExpiresAt: start.getTime() + 60_000,
              state: {
                status: "approved",
                reviewUrl: "https://roles.bittrees.org/review/example",
                expiresAt: new Date(start.getTime() + 90_000).toISOString(),
              },
            }
          : { available: true, ready: false },
    });
  });
  await page.goto("/?workflow-readiness");
  const setup = page.getByRole("region", {
    name: "Connect this Mac to Workflows",
  });
  const confirm = setup.getByRole("button", { name: "Confirm connection" });
  await expect(confirm).toBeVisible();
  await expect(setup.locator("time")).toHaveAttribute(
    "datetime",
    new Date(start.getTime() + 60_000).toISOString(),
  );
  await page.clock.fastForward(61_000);
  await expect(confirm).toHaveCount(0);
  const saved = setup.getByText("The original request is saved.", {
    exact: false,
  });
  await expect(saved).toBeVisible();
  await setup.getByRole("button", { name: "Check connection status" }).click();
  await expect(saved).toBeVisible();
  expect(requests).toEqual(["GET", "GET"]);
});

test("the expired setup reconciles and requests separate consent before replacement", async ({
  page,
}) => {
  const actions: unknown[] = [];
  const status = {
    available: true,
    ready: true,
    originalReviewExpired: true,
    state: {
      status: "expired",
      expiresAt: "2026-11-09T15:31:08.000Z",
      reviewUrl: "https://roles.bittrees.org/review/example",
    },
  };
  await page.addInitScript(() => {
    Object.defineProperty(window, "webkit", {
      value: {
        messageHandlers: {
          reviewWorkflowEnrollment: {
            postMessage: async (value: unknown) => value === null,
          },
        },
      },
    });
  });
  await page.route("**/v1/workflows/central/connection", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: actions.length
          ? {
              ...status,
              reconciliation: "not-committed",
              replacementReviewReady: true,
            }
          : status,
      });
    const command = route.request().postDataJSON();
    actions.push(command);
    if (command.action === "start")
      return route.fulfill({
        json: {
          available: true,
          ready: true,
          state: {
            status: "pending",
            reviewUrl: "https://roles.bittrees.org/review/replacement",
          },
        },
      });
    return route.fulfill({
      json: { ...status, reconciliation: "not-committed" },
    });
  });
  await page.goto("/?workflow-readiness");
  const setup = page.getByRole("region", {
    name: "Connect this Mac to Workflows",
  });
  await setup
    .getByRole("button", { name: "Check original enrollment outcome" })
    .click();
  await expect(setup.getByRole("status")).toContainText("saved the outcome");
  await expect(
    setup.getByRole("button", { name: "Confirm connection" }),
  ).toHaveCount(0);
  expect(actions).toEqual([{ action: "reconcile" }]);
  await setup
    .getByRole("button", { name: "Review this Mac for a new request" })
    .click();
  const replacement = setup.getByRole("button", {
    name: "Request a new review in Roles",
  });
  await expect(replacement).toBeVisible();
  expect(actions).toEqual([{ action: "reconcile" }]);
  await replacement.click();
  await expect(
    setup.getByRole("link", { name: "Open Roles review" }),
  ).toHaveAttribute("href", "https://roles.bittrees.org/review/replacement");
  expect(actions).toEqual([{ action: "reconcile" }, { action: "start" }]);
});
