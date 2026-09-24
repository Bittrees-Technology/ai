import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setupRecovery,
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
import { retainedMac } from "./support/retained-mac.js";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import { inspectPrivateInvitation } from "../../modules/remote/private-peer-contracts.js";
const peers = (p: Page) =>
  p.getByRole("region", { name: "Browser device identities", exact: true });
async function refresh(p: Page) {
  await peers(p)
    .getByRole("button", { name: "Refresh saved devices", exact: true })
    .click();
  await expect(peers(p).getByRole("status")).toContainText(
    "Public device history loaded",
  );
}
async function prepare(p: Page, invitation: unknown) {
  await peers(p)
    .getByLabel("Public invitation from your Mac", { exact: true })
    .fill(JSON.stringify(invitation));
  await peers(p)
    .getByRole("button", { name: "Review invitation from Mac", exact: true })
    .click();
}
async function compare(p: Page, fingerprint: string) {
  await peers(p)
    .getByLabel("Full fingerprint from your Mac’s display", { exact: true })
    .fill(fingerprint);
  await peers(p).getByRole("checkbox").check();
}
async function approve(p: Page) {
  await peers(p)
    .getByRole("button", { name: "Save reviewed Mac identity", exact: true })
    .click();
}
async function saved(p: Page) {
  await expect(peers(p).getByRole("status")).toContainText(
    "Mac identity saved",
  );
  await refresh(p);
}
async function records(p: Page) {
  return p.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<
        {
          revision: number;
          locked: boolean;
          state: {
            peers: { peerId: string; revoked: boolean }[];
            retired: unknown[];
          } | null;
        }[]
      >((resolve, reject) => {
        const req = db.transaction("peers").objectStore("peers").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  });
}
async function preview(p: Page, browser: string, state: string) {
  await mkdir("test-results", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    await expect
      .poll(() =>
        p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const comparison = peers(p).getByLabel(
      "Full fingerprint from your Mac’s display",
      { exact: true },
    );
    if (state === "review") {
      expect(
        await comparison.evaluate((node) => ({
          tag: node.tagName,
          full:
            node.scrollWidth <= node.clientWidth &&
            node.scrollHeight <= node.clientHeight,
        })),
      ).toEqual({ tag: "TEXTAREA", full: true });
    }
    await peers(p).screenshot({
      path: `test-results/browser-peer-controls-${browser}-${name}-${state}.png`,
    });
  }
}
test("built signed-in controls exchange actual Mac invitations, retain reviewed identity and export public history under CSP", async ({
  page,
}, info) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates.*directive/i.test(m.text()))
      violations.push(m.text());
  });
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    await peers(page)
      .getByLabel("Mac device ID", { exact: true })
      .fill(mac.binding.deviceId);
    await peers(page)
      .getByRole("button", { name: "Review invitation to Mac", exact: true })
      .click();
    const create = peers(page).getByRole("button", {
      name: "Create public invitation",
      exact: true,
    });
    await expect(create).toBeDisabled();
    await peers(page).getByRole("checkbox").check();
    await create.click();
    await expect(
      peers(page).getByRole("heading", {
        name: "Public invitation for your Mac",
        exact: true,
      }),
    ).toBeFocused();
    const text = await peers(page)
      .getByLabel("Public invitation to share", { exact: true })
      .inputValue();
    const outgoing = await inspectPrivateInvitation(
      JSON.parse(text),
      Date.now(),
    );
    expect(outgoing.invitation.peerId).toBe(binding.deviceId);
    const mr = await mac.peers.prepare(outgoing.invitation);
    expect(mr.fingerprint).toBe(outgoing.fingerprint);
    await peers(page)
      .getByRole("button", { name: "Select invitation to copy", exact: true })
      .click();
    expect(
      await page.evaluate(() => {
        const t = document.activeElement as HTMLTextAreaElement;
        return t.value.substring(t.selectionStart, t.selectionEnd);
      }),
    ).toBe(text);
    const file = page.waitForEvent("download");
    await peers(page)
      .getByRole("button", { name: "Download public invitation", exact: true })
      .click();
    expect(
      JSON.parse(await readFile((await (await file).path())!, "utf8")),
    ).toEqual(outgoing.invitation);
    await peers(page)
      .getByRole("button", { name: "Hide public invitation", exact: true })
      .click();
    await refresh(page);
    const invitation = await mac.invitation();
    await prepare(page, invitation.invitation);
    await compare(page, invitation.fingerprint);
    await approve(page);
    await saved(page);
    expect((await records(page))[0]?.state?.peers[0]?.peerId).toBe(
      mac.binding.deviceId,
    );
    const historyFile = page.waitForEvent("download");
    await peers(page)
      .getByRole("button", {
        name: "Export public device history",
        exact: true,
      })
      .click();
    const historyText = await readFile(
        (await (await historyFile).path())!,
        "utf8",
      ),
      history = JSON.parse(historyText);
    expect(history.format).toBe("bittrees-browser-public-peers-v1");
    expect(history.history.state.peers[0].fingerprint).toBe(
      invitation.fingerprint,
    );
    expect(historyText).not.toMatch(
      /privateHandle|privateKey|recoveryCode|btre1_/,
    );
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    await expect(
      peers(page).getByText("Reviewed identity", { exact: true }),
    ).toBeVisible();
    await expect(peers(page)).toContainText(
      "does not yet complete a connection or allow private tasks",
    );
    expect(violations).toEqual([]);
    // WebKit screenshot preparation injects a tool stylesheet; capture only after CSP acceptance.
    await preview(page, info.project.name, "saved");
  } finally {
    mac.close();
  }
});
test("full independent fingerprint and unchecked acknowledgement remain required through unrelated status rendering", async ({
  page,
}, info) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    const field = peers(page).getByLabel(
      "Full fingerprint from your Mac’s display",
      { exact: true },
    );
    const save = peers(page).getByRole("button", {
      name: "Save reviewed Mac identity",
      exact: true,
    });
    await expect(field).toHaveValue("");
    await expect(peers(page).getByRole("checkbox")).not.toBeChecked();
    await expect(save).toBeDisabled();
    await compare(page, "0".repeat(64));
    await expect(save).toBeDisabled();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(
      peers(page).getByText(
        "These fingerprints do not match. Check the Mac’s invitation before continuing.",
        { exact: true },
      ),
    ).toBeVisible();
    await field.fill(i.fingerprint);
    await expect(field).toHaveAttribute("aria-invalid", "false");
    await peers(page).getByRole("checkbox").uncheck();
    await expect(save).toBeDisabled();
    await page
      .getByRole("button", { name: "Load devices", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Load devices", exact: true }),
    ).toBeEnabled();
    await expect(save).toBeDisabled();
    expect(await records(page)).toEqual([]);
    await field.focus();
    await page.keyboard.press("Tab");
    await expect(peers(page).getByRole("checkbox")).toBeFocused();
    await preview(page, info.project.name, "review");
  } finally {
    mac.close();
  }
});
test("wrong recipient, wrong owner, expired and malformed invitations never create a review or saved pin", async ({
  page,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    const { invitation: i } = await mac.invitation();
    for (const invalid of [
      { ...i, recipientId: randomUUID() },
      { ...i, ownerId: randomUUID() },
      { ...i, issuedAt: Date.now() - 400000, expiresAt: Date.now() - 1000 },
      { ...i, privateKey: "not-an-invitation" },
    ]) {
      await refresh(page);
      await prepare(page, invalid);
      await expect(peers(page).getByRole("alert")).toContainText(
        "Refresh saved devices",
      );
      await expect(
        peers(page).getByRole("button", {
          name: "Save reviewed Mac identity",
          exact: true,
        }),
      ).toBeHidden();
      expect(await records(page)).toEqual([]);
    }
  } finally {
    mac.close();
  }
});
test("blur during held verification discards the late review and requires fresh history", async ({
  page,
  identityServer,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    identityServer.hold();
    await prepare(page, (await mac.invitation()).invitation);
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.remoteAuthWalletTest.blur());
    identityServer.release();
    await expect(peers(page).getByRole("status")).toContainText(
      "after leaving this window",
    );
    await expect(
      peers(page).getByRole("button", {
        name: "Save reviewed Mac identity",
        exact: true,
      }),
    ).toBeHidden();
    expect(await records(page)).toEqual([]);
    await page.bringToFront();
    await refresh(page);
    await prepare(page, (await mac.invitation()).invitation);
    await expect(
      peers(page).getByRole("heading", {
        name: "Compare the Mac fingerprint",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    mac.close();
  }
});
test("key-control changes cancel a prepared peer review before confirmation", async ({
  page,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    await keyControls(page)
      .getByRole("button", { name: "Refresh keys", exact: true })
      .click();
    await expect(peers(page).getByRole("status")).toContainText(
      "controls changed",
    );
    await expect(keyControls(page).getByRole("status")).toContainText(
      "Key history loaded",
    );
    await expect(
      peers(page).getByRole("button", {
        name: "Save reviewed Mac identity",
        exact: true,
      }),
    ).toBeHidden();
    expect(await records(page)).toEqual([]);
  } finally {
    mac.close();
  }
});
test("review expiry clears independent comparison and cannot save the expired review", async ({
  page,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    await page.clock.setFixedTime(new Date(Date.now() + 121000));
    await expect(peers(page).getByRole("status")).toContainText("expired");
    await expect(
      peers(page).getByRole("button", {
        name: "Save reviewed Mac identity",
        exact: true,
      }),
    ).toBeHidden();
    expect(await records(page)).toEqual([]);
  } finally {
    mac.close();
  }
});
test("offline revocation and history deletion stay local, require distinct reviews and retain the new-registration fence", async ({
  page,
  identityServer,
}, info) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    await approve(page);
    await saved(page);
    identityServer.offline(true);
    await peers(page)
      .getByRole("button", {
        name: "Review local device revocation",
        exact: true,
      })
      .click();
    const revoke = peers(page).getByRole("button", {
      name: "Confirm local device revocation",
      exact: true,
    });
    await expect(revoke).toBeDisabled();
    await peers(page).getByRole("checkbox").check();
    await revoke.click();
    await expect(peers(page).getByRole("status")).toContainText(
      "Remote revocation was not confirmed",
    );
    await refresh(page);
    await expect(
      peers(page).getByText("Revoked on this browser", { exact: true }),
    ).toBeVisible();
    await peers(page)
      .getByRole("button", {
        name: "Review device history deletion",
        exact: true,
      })
      .click();
    const remove = peers(page).getByRole("button", {
      name: "Confirm device history deletion",
      exact: true,
    });
    await expect(remove).toBeDisabled();
    await peers(page).getByRole("checkbox").check();
    await remove.click();
    await expect(peers(page).getByRole("status")).toContainText(
      "history deleted",
    );
    await refresh(page);
    expect((await records(page))[0]).toMatchObject({
      revision: 3,
      locked: true,
      state: null,
    });
    identityServer.offline(false);
    await peers(page)
      .getByRole("button", { name: "Review device list reset", exact: true })
      .click();
    await peers(page).getByRole("checkbox").check();
    await peers(page)
      .getByRole("button", { name: "Confirm device list reset", exact: true })
      .click();
    await expect(peers(page).getByRole("alert")).toContainText(
      "eligible browser identity",
    );
    await refresh(page);
    await expect(peers(page)).toContainText(
      "Register a different browser identity",
    );
    await preview(page, info.project.name, "deleted");
  } finally {
    mac.close();
  }
});
test("explicit list reset retires old keys and refuses the same Mac key in a new invitation", async ({
  page,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    await approve(page);
    await saved(page);
    await peers(page)
      .getByRole("button", { name: "Review device list reset", exact: true })
      .click();
    const reset = peers(page).getByRole("button", {
      name: "Confirm device list reset",
      exact: true,
    });
    await expect(reset).toBeDisabled();
    await peers(page).getByRole("checkbox").check();
    await reset.click();
    await expect(peers(page).getByRole("status")).toContainText(
      "Retired public keys remain blocked",
    );
    await refresh(page);
    expect((await records(page))[0]?.state?.retired).toHaveLength(1);
    await prepare(page, (await mac.invitation()).invitation);
    await expect(peers(page).getByRole("alert")).toContainText(
      "Refresh saved devices",
    );
    expect((await records(page))[0]?.state?.peers).toEqual([]);
  } finally {
    mac.close();
  }
});
test("logout while approval is held destroys pairing controls without adopting a late response", async ({
  page,
  identityServer,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    identityServer.hold();
    await approve(page);
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(peers(page)).toHaveCount(0);
    identityServer.release();
    await expect(page.locator("#account")).toHaveText("Not signed in.");
    expect(await records(page)).toEqual([]);
  } finally {
    mac.close();
  }
});

test("a failed post-commit verification reports uncertainty and refresh reveals the saved version without replay", async ({
  page,
  identityServer,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    // Approval verifies twice: the second response follows the IndexedDB commit.
    identityServer.reject("/browser/registration/identity", 1);
    await approve(page);
    await expect(peers(page).getByRole("alert")).toContainText(
      "A failed response can follow a saved change",
    );
    await expect(
      peers(page).getByRole("button", {
        name: "Save reviewed Mac identity",
        exact: true,
      }),
    ).toBeHidden();
    expect((await records(page))[0]).toMatchObject({
      revision: 1,
      state: { peers: [{ peerId: mac.binding.deviceId, revoked: false }] },
    });
    await refresh(page);
    await expect(peers(page).getByRole("status")).toContainText(
      "Saved list version 1",
    );
    await expect(
      peers(page).getByText("Reviewed identity", { exact: true }),
    ).toBeVisible();
    await prepare(page, i.invitation);
    await expect(peers(page).getByRole("alert")).toContainText(
      "Refresh saved devices",
    );
    expect((await records(page))[0]?.revision).toBe(1);
  } finally {
    mac.close();
  }
});

test("another signed-in owner sees none of the previous owner's public identities", async ({
  page,
  context,
}) => {
  const binding = await setupRecovery(page),
    mac = await retainedMac(binding, Date.now());
  try {
    await refresh(page);
    const i = await mac.invitation();
    await prepare(page, i.invitation);
    await compare(page, i.fingerprint);
    await approve(page);
    await saved(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#account")).toHaveText("Not signed in.");
    const other = await context.newPage();
    await openRemotePanel(other);
    await loginRemotePanel(other);
    await openRecovery(other);
    await refresh(other);
    await expect(peers(other)).toContainText("No saved devices in this list");
    await expect(peers(other)).not.toContainText(mac.binding.deviceId);
    await expect(peers(other)).not.toContainText(i.fingerprint);
    await expect(
      peers(other).getByRole("button", {
        name: "Review invitation from Mac",
        exact: true,
      }),
    ).toBeDisabled();
    // Prior owner's retained data is not deleted or adopted by the new session.
    expect((await records(other))[0]?.state?.peers[0]?.peerId).toBe(
      mac.binding.deviceId,
    );
  } finally {
    mac.close();
  }
});
