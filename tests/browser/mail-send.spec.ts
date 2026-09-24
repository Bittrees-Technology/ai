import { test, expect, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reviewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function fixture(
  page: Page,
  options: {
    connected?: boolean;
    restored?: boolean;
    uncertain?: boolean;
    expired?: boolean;
  } = {},
) {
  let connected = options.connected ?? true,
    record: any = {
      identity: {
        wallet: "0x" + "1".repeat(40),
        mailbox: "fixture@bittrees.org",
      },
      envelope: {
        contractVersion: "mail-ai-send-v1",
        operationId,
        from: "fixture@bittrees.org",
        to: ["one@example.org"],
        cc: ["two@example.org"],
        bcc: ["hidden@example.org"],
        subject: "Exact <img src=x onerror=alert(1)> subject",
        text: "Exact message body.\nSecond line with 🐦 and trailing spaces  ",
        attachments: [
          {
            filename: "evidence.bin",
            contentType: "application/octet-stream",
            content: "AAH/",
          },
          {
            filename: "empty.bin",
            contentType: "application/octet-stream",
            content: "",
          },
        ],
        reply: { folder: "INBOX", id: "c".repeat(64), version: "d".repeat(64) },
      },
      recordedAt: new Date().toISOString(),
      reconciliationOnly: options.restored ?? false,
      submittedAt: null,
      submittedGrantId: null,
      sourceSubmission: "unobserved",
      receipt: null,
      lastCheckedAt: null,
    };
  let held: Route | undefined,
    hold = "",
    expires = Date.now() + 120000;
  const calls: { path: string; body: any }[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const review = () => ({
    id: reviewId,
    operationId,
    identity: record.identity,
    envelope: record.envelope,
    digest: "e".repeat(64),
    expiresAt: new Date(expires).toISOString(),
  });
  const receipt = () => ({
    contractVersion: "mail-ai-send-v1",
    operationId,
    digest: "e".repeat(64),
    state: "partially_accepted",
    recordedAt: Date.now() - 1000,
    completedAt: Date.now(),
    recipientCount: 3,
    accepted: [0, 2],
    refused: [1],
    historical: true,
    delivery: "unverified",
    sentCopy: "saved",
  });
  await page.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    if (path === "/v1/private-relay")
      return route.fulfill({
        json: {
          available: false,
          canSetup: false,
          canCheckRemote: false,
          transportActive: false,
          state: { version: 1, restoreAuthority: false, items: [] },
        },
      });
    let json: any = {
      available: false,
      connection: null,
      items: [],
      checks: [],
      peers: [],
      grants: [],
      profiles: [],
      state: {
        slots: [],
        revision: 0,
        needsFreshPairing: false,
        pendingKeyDeletionCount: 0,
      },
    };
    if (path.startsWith("/v1/connections/mail-send")) {
      const body = req.postData() ? req.postDataJSON() : null;
      calls.push({ path, body });
      if (hold && path.endsWith("/" + hold)) {
        held = route;
        return;
      }
      if (path.endsWith("/prepare") || path.endsWith("/reconnect")) {
        if (path.endsWith("/prepare"))
          record = {
            ...record,
            identity: body.identity,
            envelope: {
              contractVersion: "mail-ai-send-v1",
              operationId,
              ...body.message,
            },
          };
        json = {
          operationId,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          reviewFile: {
            version: "bittrees-mail-review-v1",
            challenge: "f".repeat(43),
            envelope: record.envelope,
          },
        };
      } else if (path.endsWith("/finish")) {
        connected = true;
        json = { ok: true };
      } else if (path.endsWith("/history"))
        json = {
          items: record
            ? [{ ...record, operationId, subject: record.envelope.subject }]
            : [],
        };
      else if (path.includes("/history/")) json = record;
      else if (path.endsWith("/review")) json = review();
      else if (path.endsWith("/confirm")) {
        record = {
          ...record,
          submittedAt: new Date().toISOString(),
          sourceSubmission: "reserved",
          receipt: options.uncertain ? null : receipt(),
        };
        if (options.uncertain)
          return route.fulfill({
            status: 400,
            json: { error: "MAIL_SEND_UNCONFIRMED" },
          });
        json = record;
      } else if (path.endsWith("/reconcile")) {
        record = {
          ...record,
          sourceSubmission: "reserved",
          receipt: receipt(),
        };
        json = record;
      } else if (path.endsWith("/delete")) {
        record = null;
        connected = false;
        json = { removed: true, sourceCancelled: false };
      } else if (path.endsWith("/forget") || path.endsWith("/disconnect")) {
        connected = false;
        json = { removed: true };
      } else if (path.endsWith("/cancel")) json = { cancelled: true };
      else
        json = {
          available: true,
          connection: connected
            ? {
                ...record.identity,
                operationId,
                grantId: "b".repeat(64),
                digest: "e".repeat(64),
                audience: "https://ai.bittrees.org",
                recipientCount: 3,
                expiresAt: new Date(
                  Date.now() + (options.expired ? -1 : 900000),
                ).toISOString(),
                previouslySubmitted: false,
                state: options.expired ? "expired" : "stored",
              }
            : null,
        };
    }
    await route.fulfill({ json });
  });
  await page.goto("/?workspace");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("article", {
    name: "Reviewed Mail sending",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Sending permission has not loaded."),
  ).toHaveCount(0);
  return {
    panel,
    calls,
    errors,
    record: () => record,
    review,
    expiry: (n: number) => (expires = Date.now() + n),
    hold: (s: string) => (hold = s),
    pending: () => held,
  };
}
async function loaded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.panel
    .getByRole("button", { name: "Load permitted message", exact: true })
    .click();
  const saved = f.panel.getByRole("region", {
    name: "Saved exact Mail message",
    exact: true,
  });
  await expect(saved).toBeVisible();
  return saved;
}

test("complete Mail review shows all recipient groups/files, keyboard confirmation and historical partial receipt", async ({
  page,
}, info) => {
  const f = await fixture(page),
    saved = await loaded(f);
  await saved
    .getByRole("button", { name: "Review final send", exact: true })
    .click();
  await expect(
    saved.getByRole("heading", { name: "Final send review", exact: true }),
  ).toBeVisible();
  for (const text of [
    "one@example.org",
    "two@example.org",
    "hidden@example.org",
    "evidence.bin",
    "empty.bin",
    "Exact <img src=x onerror=alert(1)> subject",
  ])
    await expect(saved.getByText(text, { exact: true })).toBeVisible();
  await expect(saved.locator("pre")).toHaveText(f.record().envelope.text);
  await expect(saved.locator("img")).toHaveCount(0);
  const send = saved.getByRole("button", {
    name: "Send this exact message once",
    exact: true,
  });
  await expect(send).toBeDisabled();
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await saved.screenshot({
      path: `test-results/mail-send-review-${info.project.name}-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await saved
    .getByRole("checkbox", {
      name: "I reviewed this exact message and authorize one send request.",
    })
    .check();
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(
    saved.getByRole("region", { name: "Historical Mail receipt" }),
  ).toBeVisible();
  await expect(
    saved.getByText("two@example.org: refused by SMTP", { exact: true }),
  ).toBeVisible();
  await expect(saved.getByText(/Delivery is unverified/)).toBeVisible();
  expect(
    f.calls.filter((c) => c.path.endsWith("/confirm")).map((c) => c.body),
  ).toEqual([{ id: reviewId, confirmed: true }]);
  await saved
    .getByRole("button", {
      name: "Check status without resending",
      exact: true,
    })
    .click();
  expect(f.calls.filter((c) => c.path.endsWith("/confirm"))).toHaveLength(1);
  await saved.screenshot({
    path: `test-results/mail-send-receipt-${info.project.name}.png`,
  });
  expect(f.errors).toEqual([]);
});

test("compose and explicit review-file download preserve exact content; approval survives leaving the window", async ({
  page,
}, info) => {
  const f = await fixture(page, { connected: false });
  await f.panel
    .getByLabel("Mail sign-in wallet", { exact: true })
    .fill("0x" + "1".repeat(40));
  await f.panel
    .getByLabel("From mailbox", { exact: true })
    .fill("fixture@bittrees.org");
  for (const [label, value] of [
    ["To recipients", "one@example.org"],
    ["Cc recipients", "two@example.org"],
    ["Bcc recipients", "hidden@example.org"],
    ["Subject", "Review this exact message"],
    ["Message body", "A checked reply.\nExact second line."],
  ])
    await f.panel.getByLabel(label!, { exact: true }).fill(value!);
  await f.panel
    .getByLabel("Choose attachments", { exact: true })
    .setInputFiles([
      {
        name: "exact.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([0, 1, 255]),
      },
    ]);
  await expect(
    f.panel.getByRole("button", { name: "Remove file 1", exact: true }),
  ).toBeVisible();
  await f.panel
    .getByRole("button", {
      name: "Save message for Mail approval",
      exact: true,
    })
    .click();
  const approval = f.panel.getByRole("region", {
    name: "Approve exact message in Mail",
  });
  await expect(approval).toBeVisible();
  await approval.screenshot({
    path: `test-results/mail-send-approval-${info.project.name}.png`,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    approval
      .getByRole("button", { name: "Download Mail approval file", exact: true })
      .click(),
  ]);
  const payload = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(payload.version).toBe("bittrees-mail-review-v1");
  expect(payload.envelope).toEqual(f.record().envelope);
  expect(payload.envelope.attachments[0].content).toBe("AAH/");
  expect(payload.verifier).toBeUndefined();
  expect(f.calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    approval.getByRole("button", { name: "Download Mail approval file" }),
  ).toHaveCount(0);
  await approval
    .getByLabel("One-time sending approval code")
    .fill("c".repeat(64));
  await approval
    .getByRole("button", { name: "Save sending permission", exact: true })
    .click();
  await expect(
    f.panel.getByRole("button", {
      name: "Load permitted message",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    f.calls.filter((c) => c.path.endsWith("/finish")).map((c) => c.body),
  ).toEqual([{ operationId, code: "c".repeat(64) }]);
  expect(f.calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
  expect(f.errors).toEqual([]);
});

test("uncertain confirmation cannot replay and reconciliation recovers historical status", async ({
  page,
}, info) => {
  const f = await fixture(page, { uncertain: true }),
    saved = await loaded(f);
  await saved.getByRole("button", { name: "Review final send" }).click();
  await saved
    .getByRole("checkbox", {
      name: "I reviewed this exact message and authorize one send request.",
    })
    .check();
  await saved
    .getByRole("button", { name: "Send this exact message once" })
    .click();
  await expect(f.panel.getByRole("alert")).toContainText(
    "send outcome is unconfirmed",
  );
  await expect(
    saved.getByText("Local confirmation attempted; outcome unconfirmed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    saved.getByRole("button", { name: "Review final send" }),
  ).toHaveCount(0);
  await saved.screenshot({
    path: `test-results/mail-send-uncertain-${info.project.name}.png`,
  });
  await saved
    .getByRole("button", { name: "Check status without resending" })
    .click();
  await expect(
    saved.getByRole("region", { name: "Historical Mail receipt" }),
  ).toBeVisible();
  expect(f.calls.filter((c) => c.path.endsWith("/confirm"))).toHaveLength(1);
  expect(f.calls.filter((c) => c.path.endsWith("/reconcile"))).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("focus loss, late responses and expiry cannot restore a final confirmation", async ({
  page,
}) => {
  const f = await fixture(page),
    saved = await loaded(f);
  f.hold("review");
  await saved.getByRole("button", { name: "Review final send" }).click();
  await expect.poll(() => !!f.pending()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await f.pending()!.fulfill({ json: f.review() });
  await expect(saved).toHaveCount(0);
  await expect
    .poll(() =>
      f.calls.some((c) => c.path.endsWith("/cancel") && c.body.id === reviewId),
    )
    .toBe(true);
  expect(f.calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
  f.hold("");
  await f.panel.getByRole("button", { name: "Load permitted message" }).click();
  f.expiry(1500);
  await saved.getByRole("button", { name: "Review final send" }).click();
  await expect(
    saved.getByRole("button", { name: "Send this exact message once" }),
  ).toBeVisible();
  await expect(
    saved.getByRole("button", { name: "Send this exact message once" }),
  ).toHaveCount(0, { timeout: 5000 });
  expect(f.errors).toEqual([]);
});

test("restored history stays read-only and deletion is separately acknowledged even when disconnected", async ({
  page,
}, info) => {
  const f = await fixture(page, { connected: false, restored: true });
  await f.panel
    .getByRole("button", { name: "Load saved Mail history" })
    .click();
  const history = f.panel.getByRole("region", { name: "Saved Mail history" });
  await history.getByRole("button", { name: "Open saved message" }).click();
  const saved = f.panel.getByRole("region", {
    name: "Saved exact Mail message",
  });
  await expect(
    saved.getByText(/Restored history cannot authorize a send/),
  ).toBeVisible();
  await expect(
    saved.getByRole("button", { name: "Review final send" }),
  ).toHaveCount(0);
  await expect(
    saved.getByRole("button", { name: "Check status without resending" }),
  ).toBeDisabled();
  await saved.getByText("Delete local tracking", { exact: true }).click();
  const remove = saved.getByRole("button", {
    name: "Delete this local Mail record",
  });
  await expect(remove).toBeDisabled();
  await saved.screenshot({
    path: `test-results/mail-send-restored-${info.project.name}.png`,
  });
  await saved
    .getByRole("checkbox", {
      name: "I understand deleting tracking does not cancel or unsend this message.",
    })
    .check();
  await remove.click();
  await expect(saved).toHaveCount(0);
  expect(
    f.calls.filter((c) => c.path.endsWith("/delete")).map((c) => c.body),
  ).toEqual([{ operationId, confirmed: true, forgetSendTracking: true }]);
  expect(f.calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
  expect(f.errors).toEqual([]);
});
