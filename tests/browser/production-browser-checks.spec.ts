import {
  checks,
  peers,
  refresh,
  confirm,
  output,
  incoming,
  setup,
} from "./support/browser-mac-ui.js";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
import { mkdir, readFile } from "node:fs/promises";
async function rows(p: Page) {
  // Read-only inspection returns metadata, never key handles or decrypted preparations.
  return p.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<
        {
          kind: string;
          id: string;
          state?: string;
          role?: string;
          locked?: boolean;
        }[]
      >((resolve, reject) => {
        const r = db
          .transaction("peer_checks")
          .objectStore("peer_checks")
          .getAll();
        r.onsuccess = () =>
          resolve(
            r.result.map(({ kind, id, state, role, locked }) => ({
              kind,
              id,
              state,
              role,
              locked,
            })),
          );
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  });
}
async function preview(p: Page, engine: string, state: string) {
  await mkdir("test-results", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await checks(p).screenshot({
      path: `test-results/browser-check-controls-${engine}-${name}-${state}.png`,
    });
  }
}
test("built device controls complete both directions with retained Mac keys, exact message reload and metadata-only export", async ({
  page,
}, info) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates.*directive/i.test(m.text()))
      violations.push(m.text());
  });
  const f = await setup(page);
  try {
    await f.review();
    await confirm(page, "Create Mac check");
    const wire = await output(page);
    await expect(
      checks(page).getByRole("heading", {
        name: "Waiting for Mac reply",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      checks(page).getByText(
        "No saved checks. Choose a reviewed Mac to start one.",
        { exact: true },
      ),
    ).toBeHidden();
    await expect(
      checks(page).getByRole("heading", {
        name: "Encrypted message for your Mac",
        exact: true,
      }),
    ).toBeFocused();
    await checks(page)
      .getByRole("button", {
        name: "Select check message to copy",
        exact: true,
      })
      .click();
    const selected = await page.evaluate(() => {
      const t = document.activeElement as HTMLTextAreaElement;
      return t.value.substring(t.selectionStart, t.selectionEnd);
    });
    expect(JSON.parse(selected)).toEqual(wire);
    const file = page.waitForEvent("download");
    await checks(page)
      .getByRole("button", {
        name: "Download encrypted check message",
        exact: true,
      })
      .click();
    expect(
      JSON.parse(await readFile((await (await file).path())!, "utf8")),
    ).toEqual(wire);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    await checks(page)
      .getByRole("button", { name: "Review saved check message", exact: true })
      .click();
    await confirm(page, "Open saved check message");
    expect(await output(page)).toEqual(wire);
    const answer = await f.mac.checks.respond({
      envelope: wire,
      confirmed: true,
    });
    const reply = await f.mac.checks.delivery({
      id: answer.id,
      confirmed: true,
    });
    await refresh(page);
    await incoming(page, reply, "complete");
    await confirm(page, "Verify and save Mac reply");
    await expect(checks(page).getByRole("status")).toContainText(
      "Mac reply verified and saved on this browser",
    );
    expect(
      (await rows(page)).filter((r) => r.state === "verified"),
    ).toHaveLength(1);
    const own = await f.macBegin(),
      challenge = await f.mac.checks.delivery({ id: own.id, confirmed: true });
    await refresh(page);
    await incoming(page, challenge, "answer");
    await confirm(page, "Answer Mac check");
    const browserAnswer = await output(page);
    expect(
      (await rows(page)).filter((r) => r.state === "verified"),
    ).toHaveLength(1);
    await f.mac.checks.complete({ envelope: browserAnswer, confirmed: true });
    expect(f.mac.checks.list().find((c) => c.id === own.id)?.value.state).toBe(
      "verified",
    );
    await refresh(page);
    const exportFile = page.waitForEvent("download");
    await checks(page)
      .getByRole("button", { name: "Export device check history", exact: true })
      .click();
    const exported = JSON.parse(
      await readFile((await (await exportFile).path())!, "utf8"),
    );
    expect(exported.history.checks).toHaveLength(2);
    expect(exported.history.checks[0]).not.toHaveProperty("envelope");
    expect(JSON.stringify(exported)).not.toMatch(
      /preparation|ciphertext|privateKey|nonce/,
    );
    expect(violations).toEqual([]);
    // WebKit screenshot preparation injects a tool stylesheet. Capture only
    // after actual application/CSP acceptance; keep the production policy strict.
    await preview(page, info.project.name, "history");
  } finally {
    f.mac.close();
  }
});
for (const action of [
  "blur",
  "wallet",
  "keys",
  "peers",
  "escape",
  "deadline",
  "rollback",
] as const)
  test(`device review cancels for ${action} without creating a check`, async ({
    page,
  }) => {
    if (action === "deadline" || action === "rollback")
      await page.clock.install();
    const f = await setup(page);
    try {
      await f.review();
      await checks(page).getByRole("checkbox").check();
      if (action === "blur")
        await page.evaluate(() => window.remoteAuthWalletTest.blur());
      if (action === "wallet")
        await page.evaluate(() => window.remoteAuthWalletTest.change());
      if (action === "keys") {
        await keyControls(page)
          .getByRole("button", { name: "Refresh keys", exact: true })
          .click();
        await expect(keyControls(page).getByRole("status")).toContainText(
          "Key history loaded",
        );
      }
      if (action === "peers")
        await peers(page)
          .getByRole("button", { name: "Refresh saved devices", exact: true })
          .click();
      if (action === "escape") await page.keyboard.press("Escape");
      if (action === "deadline") await page.clock.fastForward(120001);
      if (action === "rollback") {
        await page.clock.setSystemTime(new Date(Date.now() - 60000));
        await page.clock.runFor(501);
      }
      await expect(
        checks(page).getByRole("button", {
          name: "Create Mac check",
          exact: true,
        }),
      ).toBeHidden();
      expect((await rows(page)).filter((r) => r.kind === "check")).toHaveLength(
        0,
      );
    } finally {
      f.mac.close();
    }
  });
test("a delayed verified identity cannot publish after the device review loses focus", async ({
  page,
  identityServer,
}) => {
  const f = await setup(page);
  try {
    await f.review();
    identityServer.hold();
    await confirm(page, "Create Mac check");
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.remoteAuthWalletTest.blur());
    identityServer.release();
    await refresh(page);
    expect((await rows(page)).filter((r) => r.kind === "check")).toHaveLength(
      0,
    );
  } finally {
    identityServer.release();
    f.mac.close();
  }
});
test("a lost final verification after completion requires refresh and reveals saved history without replay", async ({
  page,
  identityServer,
}) => {
  const f = await setup(page);
  try {
    await f.review();
    await confirm(page, "Create Mac check");
    const wire = await output(page);
    const answer = await f.mac.checks.respond({
        envelope: wire,
        confirmed: true,
      }),
      reply = await f.mac.checks.delivery({ id: answer.id, confirmed: true });
    await refresh(page);
    await incoming(page, reply, "complete");
    identityServer.reject("/browser/registration/identity", 1);
    await confirm(page, "Verify and save Mac reply");
    await expect(checks(page).getByRole("alert")).toContainText(
      "A failed response can follow a saved change",
    );
    expect(
      (await rows(page)).filter((r) => r.state === "verified"),
    ).toHaveLength(1);
    await expect(
      checks(page).getByRole("button", {
        name: "Review saving Mac reply",
        exact: true,
      }),
    ).toBeDisabled();
    await refresh(page);
    await expect(
      checks(page).getByRole("heading", {
        name: "Mac reply verified here",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    f.mac.close();
  }
});
test("offline stop and history deletion require separate reviews and same-device reset cannot remove the fence", async ({
  page,
  identityServer,
}) => {
  const f = await setup(page);
  try {
    await f.review();
    await confirm(page, "Create Mac check");
    await output(page);
    await refresh(page);
    identityServer.offline(true);
    await checks(page)
      .getByRole("button", { name: "Review stopping this check", exact: true })
      .click();
    await confirm(page, "Stop device check");
    await expect(checks(page).getByRole("status")).toContainText(
      "Check stopped on this browser only",
    );
    await refresh(page);
    await checks(page)
      .getByRole("button", {
        name: "Review check history deletion",
        exact: true,
      })
      .click();
    await confirm(page, "Delete device check history");
    await expect(checks(page).getByRole("status")).toContainText(
      "Device check history deleted",
    );
    await refresh(page);
    expect(await rows(page)).toEqual([
      expect.objectContaining({ kind: "meta", locked: true }),
    ]);
    await expect(
      checks(page).getByRole("button", {
        name: "Review new Mac check",
        exact: true,
      }),
    ).toBeDisabled();
    identityServer.offline(false);
    await checks(page)
      .getByRole("button", { name: "Review check history reset", exact: true })
      .click();
    await confirm(page, "Reset device check history");
    await expect(checks(page).getByRole("alert")).toContainText(
      "different browser registration",
    );
    expect(await rows(page)).toEqual([
      expect.objectContaining({ kind: "meta", locked: true }),
    ]);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});
test("wrong route and wrong message intent do not create completed browser proof", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const own = await f.macBegin(),
      challenge = await f.mac.checks.delivery({ id: own.id, confirmed: true });
    await checks(page)
      .getByLabel("Encrypted check message from your Mac", { exact: true })
      .fill(
        JSON.stringify({
          ...challenge,
          header: { ...challenge.header, recipientId: f.mac.binding.deviceId },
        }),
      );
    await checks(page)
      .getByRole("button", { name: "Review answering Mac check", exact: true })
      .click();
    await expect(checks(page).getByRole("alert")).toContainText(
      "addressed to this browser",
    );
    await incoming(page, challenge, "complete");
    await confirm(page, "Verify and save Mac reply");
    await expect(checks(page).getByRole("alert")).toContainText(
      "could not be verified",
    );
    expect(
      (await rows(page)).filter((r) => r.state === "verified"),
    ).toHaveLength(0);
    await refresh(page);
    await incoming(page, challenge, "answer");
    await confirm(page, "Answer Mac check");
    await output(page);
    expect(
      (await rows(page)).filter((r) => r.state === "verified"),
    ).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});

test("device check review and original encrypted message remain readable on desktop and phone", async ({
  page,
}, info) => {
  const f = await setup(page);
  try {
    await f.review();
    await preview(page, info.project.name, "review");
    await confirm(page, "Create Mac check");
    await output(page);
    await preview(page, info.project.name, "message");
  } finally {
    f.mac.close();
  }
});
