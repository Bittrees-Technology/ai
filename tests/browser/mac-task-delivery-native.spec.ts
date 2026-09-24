import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready, send, payload } from "./support/relay-endpoints.js";
const panel = (page: Page) =>
  page.getByRole("region", { name: "Private task delivery", exact: true });
async function confirm(page: Page) {
  const review = page.getByRole("region", {
    name: "Review private task delivery",
    exact: true,
  });
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  const button = review.getByRole("button", { name: /^Confirm / });
  await expect(button).toBeDisabled();
  await review.getByRole("checkbox").check();
  await button.click();
}
test("Mac delivery buttons use the authenticated local API and real relay for task admission and browser result return", async ({
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
  const api = await f.native.openLocalApi();
  const macPage = await context.newPage();
  const errors: string[] = [];
  macPage.on("pageerror", (e) => errors.push(e.message));
  try {
    const denied = await api.deniedStatus();
    expect(denied.status).toBe(401);
    expect(JSON.stringify(denied.body)).not.toContain(f.entry.id);
    await macPage.exposeFunction(
      "nativeTaskApi",
      (path: string, method?: string, body?: unknown) =>
        api.call(path, method, body),
    );
    await macPage.goto("https://ai.bittrees.org/?mac-task-delivery-native");
    await expect(macPage).toHaveURL(
      "https://ai.bittrees.org/?mac-task-delivery-native",
    );
    await expect.poll(() => errors).toEqual([]);
    await expect(
      macPage.getByRole("button", { name: "Open private task delivery" }),
    ).toBeVisible();
    expect(
      api.calls.filter((c) => c.path === "/v1/private-tasks"),
    ).toHaveLength(0);
    await send(page, f);
    await macPage
      .getByRole("button", { name: "Open private task delivery" })
      .click();
    await panel(macPage)
      .getByLabel("Connection for private delivery")
      .selectOption(f.native.record().id);
    await panel(macPage)
      .getByRole("button", { name: "Review checking for a task" })
      .click();
    expect(
      api.calls.filter((c) => c.path.endsWith("/check-task")),
    ).toHaveLength(0);
    await confirm(macPage);
    await expect(panel(macPage).getByRole("status")).toContainText(
      "accepted locally",
    );
    const accepted = f.native.controls.taskStatus().acceptedTasks[0]!;
    expect(accepted.operationId).toBe(f.entry.id);
    expect(f.native.task(accepted.taskId).input.prompt).toBe(payload.prompt);
    expect(f.native.task(accepted.taskId).status).toBe("queued");
    await panel(macPage)
      .getByRole("button", { name: "Review acceptance reply" })
      .click();
    await confirm(macPage);
    await expect(panel(macPage).getByRole("status")).toContainText(
      "nothing was sent automatically",
    );
    expect(
      identityServer.events.filter(
        (p) => p === "/device/relay/messages/submit",
      ),
    ).toHaveLength(0);
    await panel(macPage)
      .getByRole("button", { name: "Review sending this reply" })
      .click();
    await confirm(macPage);
    await expect(panel(macPage).getByRole("status")).toContainText(
      "Browser authentication or reading is not confirmed",
    );
    await panel(macPage)
      .getByRole("button", { name: "Refresh private task history" })
      .click();
    await expect(
      panel(macPage).getByText(/Last relay confirmation: stored for delivery/),
    ).toBeVisible();
    expect(f.native.controls.taskStatus().responses[0]!.delivery?.state).toBe(
      "stored",
    );
    const receipt = await page.evaluate(() =>
      window.browserPeersTest.relayCheck({ after: null, confirmed: true }),
    );
    expect(receipt.received?.kind).toBe("receipt");
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries[0]!.state,
    ).toBe("accepted");
    // The worker is invoked independently; receiving/preparing/sending never runs it.
    await f.mac.work();
    await panel(macPage)
      .getByRole("button", { name: "Review result preparation" })
      .click();
    await confirm(macPage);
    await expect(panel(macPage).getByRole("status")).toContainText(
      "nothing was sent automatically",
    );
    const row = panel(macPage)
      .getByRole("list", { name: "Saved private replies" })
      .getByRole("listitem")
      .filter({ hasText: "Result" });
    await row
      .getByRole("button", { name: "Review sending this reply" })
      .click();
    await confirm(macPage);
    await expect(panel(macPage).getByRole("status")).toContainText(
      "stored for delivery",
    );
    const result = await page.evaluate(() =>
      window.browserPeersTest.relayCheck({ after: null, confirmed: true }),
    );
    expect(result.received?.kind).toBe("result");
    const entry = (
      await page.evaluate(() => window.browserPeersTest.historyStatus())
    ).entries[0]!;
    const opened = await page.evaluate(
      (p) => window.browserPeersTest.composeReadResult(p),
      {
        ...f.route,
        id: entry.id,
        expectedRevision: entry.revision,
        confirmed: true,
      },
    );
    expect(opened.task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    expect(await panel(macPage).innerText()).not.toContain(opened.task.output);
    expect(
      api.calls.filter((c) => c.path.endsWith("/check-task")),
    ).toHaveLength(1);
    expect(
      api.calls.filter((c) => c.path.endsWith("/responses/prepare")),
    ).toHaveLength(2);
    expect(
      api.calls.filter((c) => c.path.endsWith("/responses/send")),
    ).toHaveLength(2);
    await api.call("/v1/private-relay/cancel-review", "POST", {
      confirmed: true,
    });
    expect(
      api.calls.every(
        (c) => c.status === (c.path.endsWith("/cancel-review") ? 204 : 200),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await macPage.close();
    await api.close();
    f.mac.close();
  }
});
