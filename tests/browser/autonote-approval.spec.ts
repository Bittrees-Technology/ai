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

test("exact resulting notes require fresh acknowledgement and show the saved receipt", async ({
  page,
}, info) => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let saved = false,
    saves = 0,
    cancels = 0,
    memorySaves = 0,
    suggestionRequests = 0;
  await page.route("**/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/v1/requests/synthetic-task/export")
      return route.fulfill({
        json: {
          task: {
            id: "synthetic-task",
            revision: 7,
            input: { prompt: "Summarize the reviewed meeting." },
            status: "completed",
            result: {
              text: "Review the draft plan with the team. [s1: 2–8 seconds]",
            },
          },
        },
      });
    if (path === "/v1/requests/synthetic-task/memory-suggestions") {
      expect(req.postDataJSON()).toMatchObject({
        expectedRevision: 7,
        modelProfileId: "local-model",
        confirmed: true,
      });
      suggestionRequests++;
      return route.fulfill({ json: { id: "suggestion-task" } });
    }
    if (path === "/v1/requests/synthetic-task/memories") {
      expect(req.postDataJSON()).toEqual({
        text: "Review the draft plan",
        type: "decision",
        expectedRevision: 7,
      });
      memorySaves++;
      return route.fulfill({ json: { id } });
    }
    if (path === "/v1/requests/synthetic-task/autonote-reviews")
      return route.fulfill({
        json: {
          items: [
            {
              id,
              state: saved ? "saved" : "prepared",
              approvalAvailable: true,
              review: {
                expiresAt: new Date(Date.now() + 600000).toISOString(),
                reviewUrl:
                  "https://autonote.bittrees.org/connect/ai?review=" + id,
              },
              receipt: saved
                ? { meetingId: id, version: 2, operationId: id }
                : null,
            },
          ],
        },
      });
    if (path.endsWith("/approval-review"))
      return route.fulfill({
        json: {
          reviewToken: token,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          approvalId: id,
          detail: {
            title: "Synthetic planning meeting",
            visibility: "workspace",
            notes: {
              summary: "Existing context. Review the draft plan with the team.",
              topics: [],
              decisions: [],
              actions: [
                {
                  id: "action",
                  text: "Prepare a draft plan",
                  evidence: ["s1: 2–8 seconds"],
                  owner: "Alex",
                  dueDate: null,
                  status: "proposed",
                },
              ],
              questions: [],
              recommendations: [],
            },
          },
        },
      });
    if (path.endsWith("/approval-cancel")) {
      cancels++;
      return route.fulfill({ json: { cancelled: true } });
    }
    if (path.endsWith("/approve")) {
      expect(req.postDataJSON()).toEqual({
        reviewToken: token,
        confirmed: true,
        acknowledged: true,
      });
      saved = true;
      saves++;
      return route.fulfill({ json: { state: "saved" } });
    }
    throw Error("Unexpected route " + path);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?autonote-exact-approval");
  const region = page.getByRole("region", { name: "Exact AutoNote approval" });
  await region
    .getByRole("button", { name: "Review exact notes to save", exact: true })
    .click();
  const save = region.getByRole("button", {
    name: "Save these exact notes in AutoNote",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await region
    .getByLabel("I reviewed these exact notes and the meeting audience.", {
      exact: true,
    })
    .check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(save).toHaveCount(0);
  await region
    .getByRole("button", { name: "Review exact notes to save", exact: true })
    .click();
  await expect(save).toBeDisabled();
  await expect(
    region.getByText("Existing context. Review the draft plan with the team.", {
      exact: true,
    }),
  ).toBeVisible();
  await mkdir("test-results/autonote-approval", { recursive: true });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-exact-phone.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-exact-desktop.png`,
  });
  await region
    .getByLabel("I reviewed these exact notes and the meeting audience.", {
      exact: true,
    })
    .check();
  await save.click();
  await expect(
    page.getByText("Submission: Saved in AutoNote", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved meeting version 2.", { exact: false }),
  ).toBeVisible();
  expect(saves).toBe(1);
  expect(cancels).toBeGreaterThanOrEqual(1);
  const memory = page.getByRole("region", { name: "Source memory capture" });
  await memory
    .getByRole("button", { name: "Review source for memory" })
    .click();
  await memory
    .getByRole("combobox", { name: "Memory type", exact: true })
    .selectOption("decision");
  await memory
    .getByLabel("What to remember", { exact: true })
    .fill("Review the draft plan");
  const capture = memory.getByRole("button", {
    name: "Save source memory candidate",
  });
  await expect(capture).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await memory.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-memory-phone.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await memory.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-memory-desktop.png`,
  });
  await memory.getByRole("checkbox").check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(capture).toHaveCount(0);
  expect(memorySaves).toBe(0);
  await memory
    .getByRole("button", { name: "Review source for memory" })
    .click();
  await memory
    .getByRole("combobox", { name: "Memory type", exact: true })
    .selectOption("decision");
  await memory
    .getByLabel("What to remember", { exact: true })
    .fill("Review the draft plan");
  await memory.getByRole("checkbox").check();
  await capture.click();
  await expect(memory.getByRole("status")).toContainText("Candidate saved");
  expect(memorySaves).toBe(1);
  const suggestions = page.getByRole("region", {
    name: "Memory suggestions",
    exact: true,
  });
  await suggestions
    .getByRole("button", { name: "Prepare suggestions" })
    .click();
  await expect(
    suggestions.getByText("Summarize the reviewed meeting.", { exact: true }),
  ).toBeVisible();
  const requestSuggestions = suggestions.getByRole("button", {
    name: "Request local suggestions",
  });
  await expect(requestSuggestions).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await suggestions.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-suggestions-phone.png`,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await suggestions.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-suggestions-desktop.png`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(requestSuggestions).toHaveCount(0);
  expect(suggestionRequests).toBe(0);
  await suggestions
    .getByRole("button", { name: "Prepare suggestions" })
    .click();
  await requestSuggestions.click();
  await expect(suggestions.getByRole("status")).toContainText(
    "suggestion-task",
  );
  expect(suggestionRequests).toBe(1);
});

test("browser approval delivery reviews remaining parts and cancels on focus loss", async ({
  page,
}, info) => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    peerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    connection = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let sends = 0,
    cancels = 0,
    action = "",
    decisionState = "",
    resultPrepared = false,
    resultSent = false;
  const expiry = Date.now() + 300000;
  const state = () => ({
    available: true,
    canSetup: true,
    revision: sends + 1,
    decisions: decisionState
      ? [
          {
            decisionId: id,
            offerId: id,
            decision: "approve",
            state: decisionState,
            resultDeliveries: resultPrepared
              ? [
                  {
                    messageId: id,
                    status: "saved",
                    encrypted: true,
                    attempts: resultSent ? 1 : 0,
                    transport: resultSent ? { state: "stored" } : null,
                  },
                ]
              : [],
            result:
              decisionState === "saved"
                ? { status: "saved", receipt: { version: 2 } }
                : null,
          },
        ]
      : [],
    permissions: [
      {
        id,
        peerId,
        fingerprint: "ab".repeat(32),
        expiresAt: expiry,
        revoked: false,
      },
    ],
    offers: [
      {
        id,
        state: "ready",
        expiresAt: expiry,
        packets: [0, 1, 2].map((index) => ({
          index,
          attempts: index === 0 || sends ? 1 : 0,
          receipt: sends ? { state: "stored" } : null,
        })),
      },
    ],
  });
  await page.route("**/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/v1/private-peers")
      return route.fulfill({
        json: {
          peers: [
            {
              peerId,
              keyEpoch: 1,
              fingerprint: "ab".repeat(32),
              revoked: false,
            },
          ],
        },
      });
    if (path === "/v1/private-relay")
      return route.fulfill({
        json: {
          state: {
            items: [
              {
                id: connection,
                revision: 1,
                phase: "active",
                locked: false,
                permission: { state: "active", expiresAt: expiry },
              },
            ],
          },
        },
      });
    if (path.endsWith("/cancel")) {
      cancels++;
      return route.fulfill({ json: { cancelled: true } });
    }
    if (path.endsWith("/prepare")) {
      const body = request.postDataJSON();
      action = body.action;
      expect(body.operationId).toBe(id);
      expect(body).not.toHaveProperty("index");
      return route.fulfill({
        json: {
          id,
          action,
          expiresAt: Date.now() + 60000,
          summary: {
            grant: {
              peer: { fingerprint: "ab".repeat(32) },
              detailHash: "cd".repeat(32),
            },
            result: { status: "saved", receipt: { version: 2 } },
            messageIds: [id, peerId, connection],
            item: {
              selection: { messageId: id },
              cursor: { storedAt: Date.now(), messageId: id },
            },
          },
        },
      });
    }
    if (path.endsWith("/confirm")) {
      expect([
        "send",
        "receive",
        "execute",
        "reconcile",
        "prepare-result",
        "send-result",
      ]).toContain(action);
      expect(request.postDataJSON()).toEqual({
        reviewId: id,
        confirmed: true,
        acknowledged: true,
      });
      if (action === "send") sends++;
      else if (action === "prepare-result") resultPrepared = true;
      else if (action === "send-result") resultSent = true;
      else
        decisionState =
          action === "receive"
            ? "accepted"
            : action === "execute"
              ? "uncertain"
              : "saved";
      return route.fulfill({ json: state() });
    }
    if (path === "/v1/private-autonote-approvals/" + id)
      return route.fulfill({ json: state() });
    throw Error("Unexpected request: " + path);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?autonote-browser-approval");
  const region = page.getByRole("region", {
    name: "Browser approval delivery",
  });
  await region
    .getByRole("button", { name: "Refresh browser approval progress" })
    .click();
  await region
    .getByLabel("Encrypted relay connection", { exact: true })
    .selectOption(connection);
  await region
    .getByRole("button", { name: "Review sending remaining parts" })
    .click();
  const confirm = region.getByRole("button", {
    name: "Confirm reviewed action",
  });
  await expect(confirm).toBeDisabled();
  await region
    .getByLabel("I understand and want to perform this action.")
    .check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(confirm).toHaveCount(0);
  await region
    .getByRole("button", { name: "Review sending remaining parts" })
    .click();
  await expect(confirm).toBeDisabled();
  await expect(
    region.getByText(
      "Send 3 remaining encrypted parts through the selected connection.",
      { exact: false },
    ),
  ).toBeVisible();
  await mkdir("test-results/autonote-approval", { recursive: true });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-delivery-phone.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await region.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-delivery-desktop.png`,
  });
  await region
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(
    region.getByText("3 of 3 parts stored at the relay.", { exact: false }),
  ).toBeVisible();
  for (const label of [
    "Review receiving a browser decision",
    "Review saving browser-approved notes",
    "Review checking save receipt",
    "Review preparing browser result",
    "Review sending browser result",
  ]) {
    await region.getByRole("button", { name: label, exact: true }).click();
    await expect(confirm).toBeDisabled();
    if (
      label === "Review saving browser-approved notes" ||
      label === "Review sending browser result"
    ) {
      await page.setViewportSize({ width: 390, height: 844 });
      await region.screenshot({
        path: `test-results/autonote-approval/${info.project.name}-${label === "Review sending browser result" ? "result" : "decision"}-phone.png`,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        ),
      ).toBe(false);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await region.screenshot({
        path: `test-results/autonote-approval/${info.project.name}-${label === "Review sending browser result" ? "result" : "decision"}-desktop.png`,
      });
    }
    await region
      .getByLabel("I understand and want to perform this action.")
      .check();
    await confirm.click();
  }
  await expect(
    region.getByText("Saved meeting version 2.", { exact: false }),
  ).toBeVisible();
  expect(sends).toBe(1);
  expect(cancels).toBeGreaterThanOrEqual(1);
});
