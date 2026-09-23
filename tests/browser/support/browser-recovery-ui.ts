import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openRemotePanel, loginRemotePanel } from "./remote-panel.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
export const registration = (p: Page) =>
  p.getByRole("region", { name: "Browser registration", exact: true });
export const keyControls = (p: Page) =>
  p.getByRole("region", { name: "Browser keys and recovery", exact: true });
export async function openRecovery(p: Page) {
  await p.bringToFront();
  await p
    .getByRole("button", { name: "Open recovery controls", exact: true })
    .click();
  await expect(registration(p)).toBeVisible();
}
export async function refreshRegistration(p: Page) {
  await registration(p)
    .getByRole("button", { name: "Refresh registration", exact: true })
    .click();
  await expect(registration(p).getByRole("status")).toContainText(
    "Registration checked",
  );
}
/** Actual shipped controls, downloaded recovery files and activation. No production
 * host handle, synthetic trust grant or private-key extraction is used. */
export async function setupRecovery(p: Page) {
  await openRemotePanel(p);
  await loginRemotePanel(p);
  await openRecovery(p);
  await refreshRegistration(p);
  await registration(p)
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await registration(p).getByRole("checkbox").check();
  await registration(p)
    .getByRole("button", { name: "Confirm registration", exact: true })
    .click();
  await expect(registration(p).getByRole("status")).toContainText(
    "registered until",
  );
  const keys = keyControls(p);
  await keys.getByRole("button", { name: "Refresh keys", exact: true }).click();
  await expect(keys.getByRole("status")).toContainText("Key history loaded");
  await keys
    .getByRole("button", { name: "Review new key", exact: true })
    .click();
  await keys
    .getByRole("checkbox", { name: "I understand this exact change." })
    .check();
  await keys
    .getByRole("button", { name: "Confirm start key setup", exact: true })
    .click();
  const codeFile = p.waitForEvent("download");
  await keys
    .getByRole("button", { name: "Download recovery code", exact: true })
    .click();
  const code = (
    await readFile((await (await codeFile).path())!, "utf8")
  ).trim();
  await keys
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await keys
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  await keys
    .getByRole("button", { name: "Prepare encrypted backup", exact: true })
    .click();
  const backupFile = p.waitForEvent("download");
  await keys
    .getByRole("button", {
      name: "Download this encrypted backup",
      exact: true,
    })
    .click();
  const backup = await readFile((await (await backupFile).path())!, "utf8");
  await keys
    .getByLabel("Saved encrypted backup file", { exact: true })
    .setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
  await keys
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await keys
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await keys
    .getByRole("button", { name: "Check backup and activate key", exact: true })
    .click();
  await expect(keys.getByRole("status")).toContainText("Browser key ready");
  // Inspect only public lifecycle metadata written by the actual controls.
  return p.evaluate(async (): Promise<PrivateBinding> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(
        "org.bittrees.ai.browser-endpoint-keys",
        6,
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<PrivateBinding>((resolve, reject) => {
        const request = db
          .transaction("lifecycle", "readonly")
          .objectStore("lifecycle")
          .getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () =>
          resolve(
            request.result[0].slots.find(
              (slot: { state: string }) => slot.state === "active",
            ).binding,
          );
      });
    } finally {
      db.close();
    }
  });
}
