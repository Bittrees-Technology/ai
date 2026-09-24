import { test, expect, type Page, type TestInfo } from "@playwright/test";
async function preview(page: Page, info: TestInfo, state: string) {
  await page.screenshot({
    path: `test-results/mac-relay-${info.project.name}-${state}.png`,
    fullPage: true,
  });
}
async function reviewSetup(page: Page) {
  await page
    .getByLabel("Approval ID from ai.bittrees.org")
    .fill("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await page
    .getByRole("button", { name: "Review connection approval", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Review connection change" }),
  ).toBeVisible();
}
async function save(page: Page) {
  await reviewSetup(page);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirm save connection", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Connection saved on this Mac",
  );
}
test("Mac relay panel reviews independent setup and distinguishes local stop, remote revoke and removal", async ({
  page,
}, info) => {
  await page.goto("/?mac-private-relay");
  await expect(
    page.getByText("No private message connection is saved on this Mac."),
  ).toBeVisible();
  await preview(page, info, "empty");
  await reviewSetup(page);
  const confirm = page.getByRole("button", {
    name: "Confirm save connection",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Review connection change" }),
  ).toContainText("does not enable automatic message delivery");
  await preview(page, info, "review");
  await page.getByRole("checkbox").check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText(
    "Automatic message delivery is not enabled",
  );
  await page
    .getByRole("button", { name: "Stop on this Mac", exact: true })
    .click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm stop on this Mac" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Remote revocation is not confirmed",
  );
  await preview(page, info, "stopped");
  await page
    .getByRole("button", { name: "Revoke remote permission", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirm revoke remote permission" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Remote revocation confirmed",
  );
  await page
    .getByRole("button", { name: "Remove saved credential", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Review connection change" }),
  ).toContainText("encrypted message history and other devices are unchanged");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirm remove saved credential" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Credential removed locally" }),
  ).toBeVisible();
  await preview(page, info, "removed");
  const calls = await page.evaluate(
    () => (window as any).relayControlFixture.calls,
  );
  expect(calls.filter((c: any) => c.path.endsWith("/confirm"))).toHaveLength(4);
  expect(calls.some((c: any) => c.path.includes("messages"))).toBe(false);
});
test("Mac relay panel discards held reviews and reports uncertain remote revocation without retry", async ({
  page,
}, info) => {
  await page.goto("/?mac-private-relay");
  await page
    .getByLabel("Approval ID from ai.bittrees.org")
    .fill("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await page.evaluate(() => {
    (window as any).relayControlFixture.holdReview = true;
  });
  await page
    .getByRole("button", { name: "Review connection approval" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).relayControlFixture.calls.some((c: any) =>
          c.path.endsWith("/review"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    (window as any).relayControlFixture.release();
  });
  await expect(
    page.getByRole("region", { name: "Review connection change" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review connection approval" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).relayControlFixture.holdReview = false;
  });
  await save(page);
  await page.evaluate(() => {
    (window as any).relayControlFixture.failConfirm = true;
  });
  await page
    .getByRole("button", { name: "Revoke remote permission", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirm revoke remote permission" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "remote revocation is not confirmed",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
  await preview(page, info, "uncertain");
  await page.getByRole("button", { name: "Refresh saved connections" }).click();
  await expect(
    page.getByRole("heading", { name: "Stopped on this Mac" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).relayControlFixture.calls.filter((c: any) =>
          c.path.endsWith("/confirm"),
        ).length,
    ),
  ).toBe(2);
});
test("Mac relay review fits a narrow window and cancels with Escape", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mac-private-relay");
  await reviewSetup(page);
  await page.getByRole("checkbox").check();
  await expect(
    page.getByRole("button", { name: "Confirm save connection" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await preview(page, info, "narrow-review");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Review connection change" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).relayControlFixture.calls.filter((c: any) =>
          c.path.endsWith("/confirm"),
        ).length,
    ),
  ).toBe(0);
});
