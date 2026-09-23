import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setupRecovery,
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
import { retainedMac } from "./support/retained-mac.js";
import { inspectPrivateInvitation } from "../../modules/remote/private-peer-contracts.js";
import type { PrivateEnvelope } from "../../modules/remote/private-envelope.js";
import { mkdir, readFile } from "node:fs/promises";
const checks = (p: Page) =>
  p.getByRole("region", { name: "Browser device checks", exact: true });
const peers = (p: Page) =>
  p.getByRole("region", { name: "Browser device identities", exact: true });
async function refresh(p: Page) {
  await checks(p)
    .getByRole("button", { name: "Refresh device checks", exact: true })
    .click();
  await expect(checks(p).getByRole("status")).toContainText(
    "Device check history loaded",
  );
}
async function confirm(p: Page, name: string) {
  const b = checks(p).getByRole("button", { name, exact: true });
  await expect(b).toBeDisabled();
  await expect(checks(p).getByRole("checkbox")).not.toBeChecked();
  await checks(p).getByRole("checkbox").check();
  await b.click();
}
async function output(p: Page): Promise<PrivateEnvelope> {
  await expect(checks(p).getByRole("status")).toContainText(
    "Encrypted check message ready",
  );
  return JSON.parse(
    await checks(p)
      .getByLabel("Encrypted check message to share", { exact: true })
      .inputValue(),
  );
}
async function incoming(
  p: Page,
  envelope: PrivateEnvelope,
  action: "answer" | "complete",
) {
  await checks(p)
    .getByLabel("Encrypted check message from your Mac", { exact: true })
    .fill(JSON.stringify(envelope));
  await checks(p)
    .getByRole("button", {
      name:
        action === "answer"
          ? "Review answering Mac check"
          : "Review saving Mac reply",
      exact: true,
    })
    .click();
  await expect(
    checks(p).getByRole("heading", {
      name:
        action === "answer" ? "Answer the Mac’s check" : "Save the Mac’s reply",
      exact: true,
    }),
  ).toBeFocused();
}
async function setup(p: Page) {
  const binding = await setupRecovery(p),
    mac = await retainedMac(binding, Date.now());
  try {
    await peers(p)
      .getByRole("button", { name: "Refresh saved devices", exact: true })
      .click();
    await expect(peers(p).getByRole("status")).toContainText(
      "Public device history loaded",
    );
    await peers(p)
      .getByLabel("Mac device ID", { exact: true })
      .fill(mac.binding.deviceId);
    await peers(p)
      .getByRole("button", { name: "Review invitation to Mac", exact: true })
      .click();
    await peers(p).getByRole("checkbox").check();
    await peers(p)
      .getByRole("button", { name: "Create public invitation", exact: true })
      .click();
    await expect(peers(p).getByRole("status")).toContainText(
      "Public invitation created",
    );
    const value = await inspectPrivateInvitation(
      JSON.parse(
        await peers(p)
          .getByLabel("Public invitation to share", { exact: true })
          .inputValue(),
      ),
      Date.now(),
    );
    const mr = await mac.peers.prepare(value.invitation);
    mac.peers.approve({
      reviewId: mr.reviewId,
      expectedRevision: mr.expectedRevision,
      comparedFingerprint: value.fingerprint,
      confirmed: true,
    });
    await peers(p)
      .getByRole("button", { name: "Hide public invitation", exact: true })
      .click();
    await peers(p)
      .getByRole("button", { name: "Refresh saved devices", exact: true })
      .click();
    await expect(peers(p).getByRole("status")).toContainText(
      "Public device history loaded",
    );
    const invitation = await mac.invitation();
    await peers(p)
      .getByLabel("Public invitation from your Mac", { exact: true })
      .fill(JSON.stringify(invitation.invitation));
    await peers(p)
      .getByRole("button", { name: "Review invitation from Mac", exact: true })
      .click();
    await peers(p)
      .getByLabel("Full fingerprint from your Mac’s display", { exact: true })
      .fill(invitation.fingerprint);
    await peers(p).getByRole("checkbox").check();
    await peers(p)
      .getByRole("button", { name: "Save reviewed Mac identity", exact: true })
      .click();
    await expect(peers(p).getByRole("status")).toContainText(
      "Mac identity saved",
    );
    await refresh(p);
    return {
      binding,
      mac,
      review: async () => {
        await checks(p)
          .getByLabel("Reviewed Mac", { exact: true })
          .selectOption(mac.binding.deviceId);
        await checks(p)
          .getByRole("button", { name: "Review new Mac check", exact: true })
          .click();
      },
      macBegin: () =>
        mac.checks.begin({
          peerId: binding.deviceId,
          expectedKeyRevision: mac.keys.list().revision,
          expectedPeerRevision: mac.peers.list().revision,
          confirmed: true,
        }),
    };
  } catch (e) {
    mac.close();
    throw e;
  }
}
async function rows(p: Page) {
  // Read-only inspection returns metadata, never key handles or decrypted preparations.
  return p.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 4);
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
    await preview(page, info.project.name, "review");
    await confirm(page, "Create Mac check");
    const wire = await output(page);
    await expect(
      checks(page).getByRole("heading", {
        name: "Encrypted message for your Mac",
        exact: true,
      }),
    ).toBeFocused();
    await preview(page, info.project.name, "message");
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
    expect(f.mac.checks.list().find((c) => c.id === own.id)?.state).toBe(
      "verified",
    );
    await refresh(page);
    await preview(page, info.project.name, "history");
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
    const f = await setup(page);
    try {
      if (action === "deadline" || action === "rollback")
        await page.clock.install();
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
