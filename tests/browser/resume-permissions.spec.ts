import { mkdir } from "node:fs/promises";
import { test, expect, type Page, type Route } from "@playwright/test";
const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const initialTasks = [first, second].map((id, index) => ({
  id,
  revision: 1,
  status: "paused",
  input: {
    prompt: index ? "Second synthetic task" : "First synthetic task",
    modelProfileId: "test",
  },
  result: { text: "Synthetic result" },
}));
const run = (model: string) => ({
  items: [{ id: model, outcome: "completed", model: { profile: { model } } }],
});
async function deliver(page: Page, route: Route, body: unknown, status = 200) {
  const response = page.waitForResponse(
    (response) => response.url() === route.request().url(),
  );
  await route.fulfill({ status, json: body });
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function fixture(
  page: Page,
  intercept?: (route: Route, path: string) => Promise<boolean>,
) {
  const tasks = structuredClone(initialTasks);
  const calls: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("Workspace browser error:", error.message);
  });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!(path.startsWith("/v1/") || path === "/pair" || path === "/logout"))
      return route.continue();
    calls.push(path);
    if (await intercept?.(route, path)) return;
    let body: unknown = {};
    if (path === "/v1/requests") body = { items: tasks };
    else if (path === "/v1/profiles")
      body = { items: [{ id: "test", model: "synthetic:local" }] };
    else if (path === "/v1/imports" || path === "/v1/inboxes")
      body = { items: [] };
    else if (path === "/v1/memories") body = { items: [] };
    else if (path === "/v1/device")
      body = {
        sampledAt: new Date().toISOString(),
        platform: "darwin",
        architecture: "arm64",
        logicalProcessors: 12,
        memory: {
          totalBytes: 24 * 1024 ** 3,
          freeBytes: 8 * 1024 ** 3,
          companionBytes: 100 * 1024 ** 2,
        },
        diskFreeBytes: 100 * 1024 ** 3,
        limits: {
          importFileBytes: 8 * 1024 ** 3,
          importTotalBytes: 12 * 1024 ** 3,
          importMemoryBytes: 12 * 1024 ** 3,
          parallelGenerations: 1,
        },
      };
    else if (path === "/v1/recovery-copies")
      body = { items: [], nextCursor: null };
    else if (path === "/v1/models")
      body = { items: [{ name: "synthetic:local" }] };
    else if (path.endsWith("/runs"))
      body = run(path.includes(first) ? "First model" : "Second model");
    await route.fulfill({ json: body });
  });
  await page.goto("/?workspace");
  try {
    await expect(
      page.getByRole("button", { name: "Lock workspace" }),
    ).toBeVisible();
    await expect(
      page
        .locator(".queue")
        .getByRole("button", { name: /First synthetic task/ }),
    ).toBeVisible();
  } catch (error) {
    console.log(
      "Workspace startup diagnostics:",
      JSON.stringify({
        calls,
        errors,
        visible: await page.locator("body").innerText(),
      }),
    );
    throw error;
  }
  return { calls, tasks };
}
async function select(page: Page, name: "First" | "Second") {
  await page
    .locator(".queue")
    .getByRole("button", { name: new RegExp(name + " synthetic task") })
    .click();
}

async function resumeFixture(page: Page) {
  const peerId = "paired-browser";
  const choices = {
    taskId: first,
    taskRevision: 1,
    peerId,
    peerKeyEpoch: 1,
    modelDigest: "a".repeat(64),
    expiresAt: Date.now() + 900000,
  };
  const status = {
    available: true,
    canSetup: true,
    revision: 1,
    keyRevision: 1,
    peerRevision: 1,
    needsFreshPairing: false,
    hasSelectedKey: true,
    peers: [{ peerId, keyEpoch: 1, fingerprint: "b".repeat(64) }],
    grants: [] as any[],
  };
  let review: any,
    pending: Route | undefined,
    hold = false,
    lose = false;
  const confirmations: any[] = [],
    prepares: any[] = [];
  const workspace = await fixture(page, async (route, path) => {
    if (!path.startsWith("/v1/private-resume")) return false;
    let json: unknown = status;
    if (path.endsWith("/prepare")) {
      const body = route.request().postDataJSON();
      prepares.push(body);
      review = {
        id: "review",
        action: body.action,
        permissionId: body.action === "grant" ? null : "permission",
        peerId,
        choices:
          body.action === "grant"
            ? {
                ...choices,
                taskId: body.taskId,
                taskRevision: body.taskRevision,
              }
            : status.grants[0].choices,
        expiresAt: Date.now() + 300000,
        fingerprint: "b".repeat(64),
        binding: { ownerId: "owner", deviceId: "mac" },
      };
      if (hold) {
        hold = false;
        pending = route;
        return true;
      }
      json = review;
    }
    if (path.endsWith("/confirm")) {
      confirmations.push(route.request().postDataJSON());
      status.grants = [
        {
          id: "permission",
          choices: review.choices,
          state: review.action === "grant" ? "saved" : "revoked",
        },
      ];
      status.revision++;
      if (lose) {
        lose = false;
        await route.abort("failed");
        return true;
      }
    }
    await route.fulfill({ json });
    return true;
  });
  await select(page, "First");
  const panel = page.getByRole("region", {
    name: "Browser resume permission",
    exact: true,
  });
  return {
    ...workspace,
    panel,
    status,
    confirmations,
    prepares,
    hold: () => {
      hold = true;
    },
    held: () => !!pending,
    release: async () => {
      const route = pending!;
      pending = undefined;
      await route.fulfill({ json: review });
    },
    lose: () => {
      lose = true;
    },
  };
}
async function prepare(page: Page) {
  const panel = page.getByRole("region", {
    name: "Browser resume permission",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Refresh resume choices", exact: true })
    .click();
  await panel
    .getByLabel("Paired browser", { exact: true })
    .selectOption("paired-browser");
  await panel
    .getByRole("button", { name: "Review resume permission", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Save resume permission", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  return panel;
}
test("Mac task detail reviews one resume and revokes the saved permission after the task changes", async ({
  page,
}, info) => {
  const f = await resumeFixture(page);
  await prepare(page);
  expect(f.prepares[0]).toEqual({
    action: "grant",
    expectedRevision: 1,
    expectedKeyRevision: 1,
    expectedPeerRevision: 1,
    peerId: "paired-browser",
    peerKeyEpoch: 1,
    taskId: first,
    taskRevision: 1,
    minutes: 15,
  });
  await expect(
    f.panel.getByText("a".repeat(64), { exact: true }),
  ).toBeVisible();
  await mkdir("test-results/resume-permission-ui", { recursive: true });
  await f.panel.screenshot({
    path: `test-results/resume-permission-ui/${info.project.name}-review.png`,
  });
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await f.panel.screenshot({
    path: `test-results/resume-permission-ui/${info.project.name}-narrow-review.png`,
  });
  await page.setViewportSize(desktopViewport);
  await f.panel.getByRole("checkbox").check();
  await f.panel
    .getByRole("button", { name: "Save resume permission", exact: true })
    .click();
  await expect(f.panel.getByRole("status")).toContainText("nothing was sent");
  expect(f.confirmations).toHaveLength(1);
  f.tasks[0]!.revision = 2;
  f.tasks[0]!.status = "completed";
  await expect(page.locator(".detail > .status")).toHaveText("completed");
  await f.panel.getByRole("button", { name: "Refresh resume choices" }).click();
  await expect(
    f.panel.getByText("Pause this task before", { exact: false }),
  ).toBeVisible();
  await f.panel
    .getByRole("button", { name: "Review revocation", exact: true })
    .click();
  await expect(
    f.panel.getByRole("button", {
      name: "Revoke resume permission",
      exact: true,
    }),
  ).toBeDisabled();
  await f.panel.getByRole("checkbox").check();
  await f.panel
    .getByRole("button", { name: "Revoke resume permission", exact: true })
    .click();
  await expect(f.panel.getByRole("status")).toContainText("revoked");
  expect(f.confirmations).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await f.panel.screenshot({
    path: `test-results/resume-permission-ui/${info.project.name}-narrow.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("Mac resume review closes on Escape, blur and selection change and discards a late review", async ({
  page,
}) => {
  const f = await resumeFixture(page);
  await prepare(page);
  await page.keyboard.press("Escape");
  await expect(
    f.panel.getByRole("button", { name: "Save resume permission" }),
  ).toHaveCount(0);
  await prepare(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    f.panel.getByRole("button", { name: "Save resume permission" }),
  ).toHaveCount(0);
  await prepare(page);
  await select(page, "Second");
  await expect(
    f.panel.getByRole("button", { name: "Save resume permission" }),
  ).toHaveCount(0);
  await select(page, "First");
  await f.panel.getByRole("button", { name: "Refresh resume choices" }).click();
  await f.panel
    .getByLabel("Paired browser", { exact: true })
    .selectOption("paired-browser");
  f.hold();
  await f.panel
    .getByRole("button", { name: "Review resume permission", exact: true })
    .click();
  await expect.poll(f.held).toBe(true);
  await select(page, "Second");
  await f.release();
  await expect(
    f.panel.getByRole("button", { name: "Save resume permission" }),
  ).toHaveCount(0);
  expect(f.confirmations).toHaveLength(0);
});
test("Mac resume confirmation lost response requires refresh and does not retry", async ({
  page,
}) => {
  const f = await resumeFixture(page);
  await prepare(page);
  f.lose();
  await f.panel.getByRole("checkbox").check();
  await f.panel
    .getByRole("button", { name: "Save resume permission", exact: true })
    .click();
  await expect(f.panel.getByRole("alert")).toContainText("No automatic retry");
  await expect(
    f.panel.getByRole("button", { name: "Save resume permission" }),
  ).toHaveCount(0);
  expect(f.confirmations).toHaveLength(1);
  await f.panel.getByRole("button", { name: "Refresh resume choices" }).click();
  await expect(
    f.panel.getByRole("article", { name: "Saved resume permission" }),
  ).toBeVisible();
  expect(f.confirmations).toHaveLength(1);
});

async function offerFixture(page: Page) {
  const peerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    offerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    permissionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const choices = {
    taskId: first,
    taskRevision: 1,
    peerId,
    peerKeyEpoch: 1,
    modelDigest: "a".repeat(64),
    expiresAt: Date.now() + 900000,
  };
  const permissions = {
    available: true,
    canSetup: true,
    revision: 1,
    keyRevision: 1,
    peerRevision: 1,
    needsFreshPairing: false,
    hasSelectedKey: true,
    peers: [],
    grants: [{ id: permissionId, choices, state: "saved" }],
  };
  const entry = {
    id: offerId,
    revision: 1,
    permissionId,
    choices,
    fingerprint: "b".repeat(64),
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    state: "ready",
  };
  const offers = { available: true, canSetup: true, offers: [] as any[] };
  const binding = { ownerId: first, deviceId: second };
  const wire = {
    header: {
      version: 1,
      suite: "HPKE-Auth-P256-SHA256-AES256GCM",
      ownerId: first,
      senderId: second,
      recipientId: peerId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: permissionId,
      operationId: offerId,
      sequence: 1,
      issuedAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    },
    enc: "synthetic",
    ciphertext: "synthetic",
  };
  let review: any,
    held: Route | undefined,
    hold = false,
    lose = false;
  const confirmations: any[] = [];
  const workspace = await fixture(page, async (route, path) => {
    if (path === "/v1/private-resume") {
      await route.fulfill({ json: permissions });
      return true;
    }
    if (!path.startsWith("/v1/private-resume/offers")) return false;
    let json: unknown = offers;
    if (path.endsWith("/prepare")) {
      const body = route.request().postDataJSON();
      review = {
        id: permissionId,
        action: body.action,
        expiresAt: Date.now() + 120000,
        offerId: body.action === "create" ? null : offerId,
        offerExpiresAt: entry.expiresAt,
        permissionId,
        choices,
        fingerprint: entry.fingerprint,
        binding,
      };
      json = review;
    } else if (path.endsWith("/confirm")) {
      confirmations.push(route.request().postDataJSON());
      if (review.action === "stop") entry.state = "stopped";
      offers.offers = [entry];
      json = { offer: entry, envelope: review.action === "stop" ? null : wire };
      if (hold) {
        hold = false;
        held = route;
        return true;
      }
      if (lose) {
        lose = false;
        await route.abort("failed");
        return true;
      }
    }
    await route.fulfill({ json });
    return true;
  });
  await select(page, "First");
  await page.getByRole("button", { name: "Refresh resume choices" }).click();
  const panel = page.getByRole("region", {
    name: "Encrypted resume offers",
    exact: true,
  });
  const refresh = async () => {
    await panel
      .getByRole("button", { name: "Refresh resume offers", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "Review new resume offer",
        exact: true,
      }),
    ).toBeVisible();
  };
  await refresh();
  return {
    ...workspace,
    panel,
    wire,
    offerId,
    offers,
    confirmations,
    refresh,
    hold: () => {
      hold = true;
    },
    lose: () => {
      lose = true;
    },
    held: () => !!held,
    release: async () => {
      const route = held!;
      held = undefined;
      await deliver(page, route, { offer: entry, envelope: wire });
    },
  };
}

test("Mac resume offer downloads the exact reviewed envelope and stops further downloads", async ({
  page,
}, info) => {
  const f = await offerFixture(page);
  await f.panel
    .getByRole("button", { name: "Review new resume offer", exact: true })
    .click();
  const downloadButton = f.panel.getByRole("button", {
    name: "Download reviewed resume offer",
    exact: true,
  });
  await expect(downloadButton).toBeDisabled();
  await expect(f.panel.getByRole("checkbox")).not.toBeChecked();
  await expect(
    f.panel.getByText("a".repeat(64), { exact: true }),
  ).toBeVisible();
  await mkdir("test-results/resume-offer-ui", { recursive: true });
  await f.panel.screenshot({
    path: `test-results/resume-offer-ui/${info.project.name}-review.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await f.panel.screenshot({
    path: `test-results/resume-offer-ui/${info.project.name}-narrow-review.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await f.panel.getByRole("checkbox").check();
  const pendingDownload = page.waitForEvent("download");
  await downloadButton.click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe(
    `bittrees-resume-offer-${f.offerId}.json`,
  );
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(f.wire);
  expect(f.confirmations).toHaveLength(1);
  await f.panel
    .getByRole("button", {
      name: "Review stopping offer downloads",
      exact: true,
    })
    .click();
  const stop = f.panel.getByRole("button", {
    name: "Stop reviewed offer downloads",
    exact: true,
  });
  await expect(stop).toBeDisabled();
  await f.panel.getByRole("checkbox").check();
  await stop.click();
  await expect(f.panel.getByRole("status")).toContainText(
    "revoke resume permission",
  );
  await expect(
    f.panel.getByRole("button", {
      name: "Review resume offer download",
      exact: true,
    }),
  ).toHaveCount(0);
  await f.panel.screenshot({
    path: `test-results/resume-offer-ui/${info.project.name}-stopped.png`,
  });
  expect(f.confirmations).toHaveLength(2);
});

test("Mac resume offer clears reviews on Escape and blur and drops a confirmed download after task selection changes", async ({
  page,
}) => {
  const f = await offerFixture(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  for (const action of ["escape", "blur"]) {
    await f.panel
      .getByRole("button", { name: "Review new resume offer", exact: true })
      .click();
    await expect(f.panel.getByRole("checkbox")).toBeVisible();
    if (action === "escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(f.panel.getByRole("checkbox")).toHaveCount(0);
    await f.refresh();
  }
  await f.panel
    .getByRole("button", { name: "Review new resume offer", exact: true })
    .click();
  await f.panel.getByRole("checkbox").check();
  f.hold();
  await f.panel
    .getByRole("button", {
      name: "Download reviewed resume offer",
      exact: true,
    })
    .click();
  await expect.poll(f.held).toBe(true);
  await select(page, "Second");
  await f.release();
  expect(downloads).toBe(0);
  expect(f.confirmations).toHaveLength(1);
});

test("Mac resume offer lost confirmation requires refresh without automatic retry or download", async ({
  page,
}) => {
  const f = await offerFixture(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await f.panel
    .getByRole("button", { name: "Review new resume offer", exact: true })
    .click();
  await f.panel.getByRole("checkbox").check();
  f.lose();
  await f.panel
    .getByRole("button", {
      name: "Download reviewed resume offer",
      exact: true,
    })
    .click();
  await expect(f.panel.getByRole("alert")).toContainText("No automatic retry");
  await f.refresh();
  await expect(
    f.panel.getByRole("button", {
      name: "Review resume offer download",
      exact: true,
    }),
  ).toBeVisible();
  expect(f.confirmations).toHaveLength(1);
  expect(downloads).toBe(0);
});
