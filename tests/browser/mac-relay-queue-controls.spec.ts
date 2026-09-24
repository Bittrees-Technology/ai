import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready, send, payload } from "./support/relay-endpoints.js";
import { corrupt, stored } from "./support/relay-queue.js";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Private task delivery", exact: true });
const review = (p: Page) =>
  p.getByRole("region", { name: "Review private task delivery", exact: true });
const queue = (p: Page) =>
  p.getByRole("region", { name: "Queued message recovery", exact: true });
async function confirm(p: Page) {
  await expect(review(p).getByRole("checkbox")).not.toBeChecked();
  const button = review(p).getByRole("button", { name: /^Confirm / });
  await expect(button).toBeDisabled();
  await review(p).getByRole("checkbox").check();
  await button.click();
}
async function open(p: Page, id: string) {
  await p
    .getByRole("button", { name: "Open private task delivery", exact: true })
    .click();
  await panel(p).getByLabel("Connection for private delivery").selectOption(id);
}
async function inspect(p: Page) {
  await queue(p)
    .getByRole("button", { name: "Review inspecting the queue" })
    .click();
  await confirm(p);
  await expect(panel(p).getByRole("status")).toContainText(
    "Queued message inspected",
  );
}
async function preview(p: Page, info: TestInfo, state: string) {
  await p.screenshot({
    path: `test-results/mac-queue-${info.project.name}-${state}.png`,
    fullPage: true,
  });
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}

test("Mac queue controls review the exact message, look past a rejected first task and return without discarding it", async ({
  page,
  context,
  identityServer,
}, info) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi(),
    mac = await context.newPage();
  try {
    const first = await send(page, f);
    await corrupt(identityServer.pool, first.receipt.messageId);
    const prepared = await page.evaluate(
      (p) => window.browserPeersTest.relayPrepare(p),
      {
        ...f.route,
        payload: { ...payload, prompt: "SYNTHETIC_QUEUE_UI_VALID_TASK" },
      },
    );
    const entry = await page.evaluate(
      (reviewId) =>
        window.browserPeersTest.composeConfirm({
          reviewId,
          confirmed: true,
          acknowledged: true,
        }),
      prepared.reviewId,
    );
    await send(page, { ...f, entry });
    await mac.exposeFunction(
      "nativeTaskApi",
      (path: string, method?: string, body?: unknown) =>
        api.call(path, method, body),
    );
    await mac.goto("https://ai.bittrees.org/?mac-task-delivery-native");
    await open(mac, f.native.record().id);
    await queue(mac)
      .getByRole("button", { name: "Review inspecting the queue" })
      .click();
    expect(
      api.calls.filter((c) => c.path.endsWith("/inspect-task")),
    ).toHaveLength(0);
    await confirm(mac);
    await expect(queue(mac)).toContainText(first.receipt.messageId);
    expect(f.native.tasks()).toHaveLength(0);
    await preview(mac, info, "inspected");
    await queue(mac)
      .getByRole("button", { name: "Review checking this message" })
      .click();
    await expect(review(mac)).toContainText(first.receipt.messageId);
    await preview(mac, info, "selected-review");
    await confirm(mac);
    await expect(panel(mac).getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    expect(f.native.tasks()).toHaveLength(0);
    await panel(mac)
      .getByRole("button", { name: "Refresh private task history" })
      .click();
    await expect(queue(mac)).toContainText(first.receipt.messageId);
    await queue(mac)
      .getByRole("button", { name: "Review looking past this message" })
      .click();
    await expect(review(mac)).toContainText(
      "does not delete it or mark it accepted",
    );
    await mac.setViewportSize({ width: 390, height: 844 });
    await preview(mac, info, "look-past-phone");
    await confirm(mac);
    await expect(queue(mac)).toContainText(entry.header.messageId);
    await preview(mac, info, "later-phone");
    expect(f.native.tasks()).toHaveLength(0);
    await queue(mac)
      .getByRole("button", { name: "Review checking this message" })
      .click();
    await confirm(mac);
    await expect(panel(mac).getByRole("status")).toContainText(
      "accepted locally",
    );
    expect(f.native.tasks()).toHaveLength(1);
    const accepted = f.native.controls.taskStatus().acceptedTasks[0]!;
    expect(accepted.operationId).toBe(entry.id);
    expect(f.native.task(accepted.taskId).input.prompt).toBe(
      "SYNTHETIC_QUEUE_UI_VALID_TASK",
    );
    await expect(
      queue(mac).getByRole("button", { name: "Review checking this message" }),
    ).toBeDisabled();
    await mac.setViewportSize({ width: 1280, height: 900 });
    await preview(mac, info, "accepted");
    await queue(mac)
      .getByRole("button", { name: "Review looking past this message" })
      .click();
    await confirm(mac);
    await expect(queue(mac)).toContainText("No queued message was found");
    await preview(mac, info, "empty");
    const polls = api.calls.filter((c) =>
      c.path.endsWith("/inspect-task"),
    ).length;
    await queue(mac)
      .getByRole("button", { name: "Return to queue start" })
      .click();
    expect(
      api.calls.filter((c) => c.path.endsWith("/inspect-task")),
    ).toHaveLength(polls);
    await inspect(mac);
    await expect(queue(mac)).toContainText(first.receipt.messageId);
    expect(await stored(identityServer.pool, first.receipt.messageId)).toEqual({
      state: "stored",
      received_at: null,
      deleted_at: null,
    });
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(1);
  } finally {
    await mac.close();
    await api.close();
    f.mac.close();
  }
});

test("Mac queue UI cancels a held inspection on hide and does not restore its late selection", async ({
  page,
  context,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi(),
    mac = await context.newPage();
  try {
    await send(page, f);
    await mac.exposeFunction(
      "nativeTaskApi",
      (path: string, method?: string, body?: unknown) =>
        api.call(path, method, body),
    );
    await mac.goto("https://ai.bittrees.org/?mac-task-delivery-native");
    await open(mac, f.native.record().id);
    identityServer.hold("/device/relay/messages/poll");
    await queue(mac)
      .getByRole("button", { name: "Review inspecting the queue" })
      .click();
    await confirm(mac);
    await expect.poll(() => identityServer.held()).toBe(true);
    await mac.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(() =>
        api.calls.some(
          (c) => c.path.endsWith("cancel-review") && c.status === 204,
        ),
      )
      .toBe(true);
    identityServer.release();
    await expect(
      panel(mac).getByRole("button", { name: "Refresh private task history" }),
    ).toBeEnabled();
    await expect(queue(mac)).toHaveCount(0);
    await panel(mac)
      .getByRole("button", { name: "Refresh private task history" })
      .click();
    await panel(mac)
      .getByLabel("Connection for private delivery")
      .selectOption(f.native.record().id);
    await expect(queue(mac)).not.toContainText(f.entry.header.messageId);
    expect(f.native.tasks()).toHaveLength(0);
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
  } finally {
    identityServer.release();
    await mac.close();
    await api.close();
    f.mac.close();
  }
});

test("Mac queue UI clears its position on close and stops offering old selections after native connection stop", async ({
  page,
  context,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi(),
    mac = await context.newPage();
  try {
    await send(page, f);
    await mac.exposeFunction(
      "nativeTaskApi",
      (path: string, method?: string, body?: unknown) =>
        api.call(path, method, body),
    );
    await mac.goto("https://ai.bittrees.org/?mac-task-delivery-native");
    await open(mac, f.native.record().id);
    await inspect(mac);
    await panel(mac)
      .getByLabel("Connection for private delivery")
      .selectOption("");
    await expect(queue(mac)).not.toContainText(f.entry.header.messageId);
    await panel(mac)
      .getByLabel("Connection for private delivery")
      .selectOption(f.native.record().id);
    await expect(queue(mac)).not.toContainText(f.entry.header.messageId);
    await inspect(mac);
    await panel(mac)
      .getByRole("button", { name: "Close task delivery" })
      .click();
    await open(mac, f.native.record().id);
    await expect(queue(mac)).not.toContainText(f.entry.header.messageId);
    await inspect(mac);
    const r = f.native.record();
    const review = await f.native.relay.prepare({
      action: "stop",
      id: r.id,
      expectedRevision: r.revision,
    });
    await f.native.relay.confirm({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    await panel(mac)
      .getByRole("button", { name: "Refresh private task history" })
      .click();
    await expect(queue(mac)).not.toContainText(f.entry.header.messageId);
    await expect(
      queue(mac).getByRole("button", { name: "Review inspecting the queue" }),
    ).toBeDisabled();
    expect(f.native.tasks()).toHaveLength(0);
  } finally {
    await mac.close();
    await api.close();
    f.mac.close();
  }
});
