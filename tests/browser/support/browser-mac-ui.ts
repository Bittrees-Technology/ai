import { expect, type Page } from "@playwright/test";
import { setupRecovery } from "./browser-recovery-ui.js";
import { retainedMac } from "./retained-mac.js";
import { inspectPrivateInvitation } from "../../../modules/remote/private-peer-contracts.js";
import type { PrivateEnvelope } from "../../../modules/remote/private-envelope.js";
export const checks = (p: Page) =>
  p.getByRole("region", { name: "Browser device checks", exact: true });
export const peers = (p: Page) =>
  p.getByRole("region", { name: "Browser device identities", exact: true });
export async function refresh(p: Page) {
  await checks(p)
    .getByRole("button", { name: "Refresh device checks", exact: true })
    .click();
  await expect(checks(p).getByRole("status")).toContainText(
    "Device check history loaded",
  );
}
export async function confirm(p: Page, name: string) {
  const b = checks(p).getByRole("button", { name, exact: true });
  await expect(b).toBeDisabled();
  await expect(checks(p).getByRole("checkbox")).not.toBeChecked();
  await checks(p).getByRole("checkbox").check();
  await b.click();
}
export async function output(p: Page): Promise<PrivateEnvelope> {
  await expect(checks(p).getByRole("status")).toContainText(
    "Encrypted check message ready",
  );
  return JSON.parse(
    await checks(p)
      .getByLabel("Encrypted check message to share", { exact: true })
      .inputValue(),
  );
}
export async function incoming(
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
export async function setup(p: Page, afterRegistration?: () => Promise<void>) {
  const binding = await setupRecovery(p, afterRegistration),
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
        await expect(
          checks(p).getByLabel("Reviewed Mac", { exact: true }),
        ).toBeEnabled();
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
export async function completeBrowserCheck(
  page: Page,
  f: Awaited<ReturnType<typeof setup>>,
) {
  await f.review();
  await confirm(page, "Create Mac check");
  const wire = await output(page),
    answer = await f.mac.checks.respond({ envelope: wire, confirmed: true });
  const reply = await f.mac.checks.delivery({ id: answer.id, confirmed: true });
  await refresh(page);
  await incoming(page, reply, "complete");
  await confirm(page, "Verify and save Mac reply");
  await expect(checks(page).getByRole("status")).toContainText(
    "Mac reply verified and saved on this browser",
  );
}
