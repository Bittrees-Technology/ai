import { test, expect } from "@playwright/test";
const fingerprint = "0123456789abcdef".repeat(4);
async function incoming(page: import("@playwright/test").Page) {
  await page
    .getByLabel("Invitation from the other device", { exact: true })
    .fill('{"synthetic":true}');
  await page
    .getByRole("button", { name: "Review incoming invitation" })
    .click();
}
test("Mac peer review requires independent comparison, fresh acknowledgement and separate local revocation", async ({
  page,
}) => {
  await page.goto("/?peers");
  await incoming(page);
  const compared = page.getByLabel(
      "Fingerprint from the other trusted device",
      { exact: true },
    ),
    confirm = page.getByRole("button", { name: "Save reviewed device key" });
  await expect(compared).toHaveValue("");
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(confirm).toBeDisabled();
  await compared.fill(fingerprint);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText(
    "other device must separately review this Mac",
  );
  await page.getByRole("button", { name: /Review revocation for/ }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(
    page.getByRole("region", { name: "Review device trust" }),
  ).toContainText("does not revoke remote permissions");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Revoke trust locally" }).click();
  await expect(
    page.getByText("Revoked locally · key 1", { exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).peerFixture.calls.filter((c: any) =>
      c.path.endsWith("/confirm"),
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0].body.comparedFingerprint).toBe(fingerprint);
  expect(calls[1].body.comparedFingerprint).toBeUndefined();
});
test("Mac peer panel conceals invitations on focus loss and rejects delayed review or uncertain retry", async ({
  page,
}) => {
  await page.goto("/?peers");
  await page
    .getByLabel("Other device ID", { exact: true })
    .fill("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  await page
    .getByRole("button", { name: "Create invitation for this device" })
    .click();
  await expect(
    page.getByRole("region", { name: "This Mac’s invitation" }),
  ).toContainText(fingerprint);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    page.getByRole("region", { name: "This Mac’s invitation" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).peerFixture.holdReview = true;
  });
  await incoming(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).peerFixture.calls.some((c: any) =>
          c.path.endsWith("/review"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    (window as any).peerFixture.release();
  });
  await expect(
    page.getByRole("region", { name: "Review device trust" }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Invitation from the other device", { exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).peerFixture.holdReview = false;
    (window as any).peerFixture.failConfirm = true;
  });
  await incoming(page);
  await page
    .getByLabel("Fingerprint from the other trusted device", { exact: true })
    .fill(fingerprint);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save reviewed device key" }).click();
  await expect(page.getByRole("alert")).toContainText("no automatic retry");
  expect(
    await page.evaluate(
      () =>
        (window as any).peerFixture.calls.filter((c: any) =>
          c.path.endsWith("/confirm"),
        ).length,
    ),
  ).toBe(1);
});
test("Mac peer review wraps full fingerprints and supports keyboard comparison on desktop and mobile", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?peers");
  await incoming(page);
  const compared = page.getByLabel(
    "Fingerprint from the other trusted device",
    { exact: true },
  );
  await compared.focus();
  await page.keyboard.type(fingerprint);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Save reviewed device key" }),
  ).toBeEnabled();
  await page.screenshot({
    path: `test-results/private-peers-desktop-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Review device trust" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await incoming(page);
  await expect(compared).toHaveValue("");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await page
      .getByRole("button", { name: "Save reviewed device key" })
      .boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: `test-results/private-peers-mobile-${info.project.name}.png`,
    fullPage: true,
  });
});
