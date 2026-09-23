import { test, expect, type Page } from "@playwright/test";
const peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function choose(page: Page) {
  await page.getByLabel("Device to check", { exact: true }).selectOption(peer);
}
async function confirm(page: Page, name: string) {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name, exact: true }).click();
}
async function start(page: Page) {
  await choose(page);
  await page.getByRole("button", { name: "Review starting a check" }).click();
  await confirm(page, "Start device check");
}
async function paste(page: Page) {
  await choose(page);
  const code = await page.evaluate(() =>
    (window as any).checkFixture.incoming(),
  );
  await page
    .getByLabel("Encrypted code from this device", { exact: true })
    .fill(code);
}
test("Mac check UI reviews each action, shows original code, and records verification without permissions", async ({
  page,
}) => {
  await page.goto("/?checks");
  await choose(page);
  await page.getByRole("button", { name: "Review starting a check" }).click();
  await expect(
    page.getByRole("button", { name: "Start device check", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Review device check" }),
  ).toContainText("0123456789abcdef".repeat(4));
  await confirm(page, "Start device check");
  await expect(
    page.getByLabel("Encrypted code to transfer", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Show code for/ }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await confirm(page, "Show encrypted code");
  const first = await page
    .getByLabel("Encrypted code to transfer", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Hide encrypted code" }).click();
  await page.getByRole("button", { name: /^Show code for/ }).click();
  await confirm(page, "Show encrypted code");
  await expect(
    page.getByLabel("Encrypted code to transfer", { exact: true }),
  ).toHaveValue(first);
  await page.getByRole("button", { name: "Hide encrypted code" }).click();
  await paste(page);
  await page
    .getByRole("button", { name: "Review verifying its reply" })
    .click();
  await confirm(page, "Verify check reply");
  await expect(
    page.getByText("Reply verified previously", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("not a live connection");
  expect(
    await page.evaluate(() =>
      (window as any).checkFixture.calls.some((c: any) =>
        /permissions|tasks/.test(c.path),
      ),
    ),
  ).toBe(false);
});
test("Mac check UI answers separately and supports explicit resume and offline stop", async ({
  page,
}) => {
  await page.goto("/?checks");
  await paste(page);
  await page
    .getByRole("button", { name: "Review answering its check" })
    .click();
  await expect(
    page.getByRole("region", { name: "Review device check" }),
  ).toContainText("does not verify it on this Mac");
  await confirm(page, "Create check reply");
  await expect(page.getByText("Reply prepared", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Reply verified previously", { exact: true }),
  ).toHaveCount(0);
  const id = await page.evaluate(() =>
    (window as any).checkFixture.seed("preparing"),
  );
  await page.getByRole("button", { name: "Refresh saved checks" }).click();
  await page.getByRole("button", { name: `Review resume for ${id}` }).click();
  await confirm(page, "Resume saved preparation");
  await expect(
    page.getByRole("button", { name: `Show code for ${id}` }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).checkFixture.disable());
  await page.getByRole("button", { name: "Refresh saved checks" }).click();
  await expect(
    page.getByRole("button", { name: /^Show code for/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: `Review stop for ${id}` }).click();
  await confirm(page, "Stop saved exchange");
  await expect(
    page.getByText("Stopped locally", { exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).checkFixture.calls);
  expect(calls.find((c: any) => c.path.endsWith("/resume")).body.id).toBe(id);
  expect(
    calls.find((c: any) => c.path.endsWith("/stop")).body.expectedRevision,
  ).toBe(2);
});
test("Mac check UI clears input and late output on focus loss and makes no uncertain automatic retry", async ({
  page,
}) => {
  await page.goto("/?checks");
  await start(page);
  await page.evaluate(() => {
    (window as any).checkFixture.hold = "envelope";
  });
  await page.getByRole("button", { name: /^Show code for/ }).click();
  await confirm(page, "Show encrypted code");
  await expect
    .poll(() => page.evaluate(() => (window as any).checkFixture.holding))
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    (window as any).checkFixture.release();
  });
  await expect(
    page.getByRole("button", { name: "Refresh saved checks" }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Encrypted code to transfer", { exact: true }),
  ).toHaveCount(0);
  await paste(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    page.getByLabel("Encrypted code from this device", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByLabel("Device to check", { exact: true })).toHaveValue(
    "",
  );
  await page.evaluate(() => {
    (window as any).checkFixture.fail = "begin";
  });
  await start(page);
  await expect(page.getByRole("alert")).toContainText("may already be saved");
  expect(
    await page.evaluate(
      () =>
        (window as any).checkFixture.calls.filter((c: any) =>
          c.path.endsWith("/begin"),
        ).length,
    ),
  ).toBe(2);
  await page.getByRole("button", { name: "Refresh saved checks" }).click();
  await expect(
    page.getByText("Check awaiting reply", { exact: true }),
  ).toHaveCount(2);
});
test("Mac check UI rejects unrelated code, clears acknowledgement on cancel, and expires visible reviews", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/?checks");
  await choose(page);
  await page
    .getByLabel("Encrypted code from this device", { exact: true })
    .fill('{"unexpected":"<script>"}');
  await page
    .getByRole("button", { name: "Review answering its check" })
    .click();
  await expect(page.getByRole("alert")).toContainText("does not match");
  expect(
    await page.evaluate(
      () =>
        (window as any).checkFixture.calls.filter((c: any) => c.body).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Review starting a check" }).click();
  await page.getByRole("checkbox").check();
  await page.keyboard.press("Escape");
  await choose(page);
  await page.getByRole("button", { name: "Review starting a check" }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.clock.fastForward(300001);
  await expect(
    page.getByRole("region", { name: "Review device check" }),
  ).toHaveCount(0);
});
test("Mac check UI supports keyboard review and readable desktop and narrow encrypted-code layouts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?checks");
  await choose(page);
  await page.getByRole("button", { name: "Review starting a check" }).click();
  await page.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Start device check", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: `test-results/private-checks-desktop-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Show code for/ }).click();
  await confirm(page, "Show encrypted code");
  await expect(
    page.getByLabel("Encrypted code to transfer", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/private-checks-mobile-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await page
      .getByRole("button", { name: "Hide encrypted code" })
      .boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
});
