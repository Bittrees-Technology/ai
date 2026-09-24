import { test, expect } from "@playwright/test";
import {
  ready as localReady,
  reopen,
  payload,
} from "./support/retained-browser-task.js";

// Storage compatibility uses the local fixture, without the relay-only HTTPS proxy.
test("actual previous browser providers upgrade from common6 without rewriting keys, permissions, ciphertext or task input", async ({
  page,
}) => {
  const f = await localReady(page, "delivery");
  try {
    const route = { peerId: f.pin.peerId, peerKeyEpoch: f.pin.keyEpoch };
    const review = await page.evaluate(
      (p) => window.browserPeersTest.composePrepare(p),
      { ...route, payload },
    );
    const entry = await page.evaluate(
      (reviewId) =>
        window.browserPeersTest.composeConfirm({
          reviewId,
          confirmed: true,
          acknowledged: true,
        }),
      review.reviewId,
    );
    const before = await page.evaluate(async () => {
      const history = await window.browserPeersTest.historyStatus();
      return {
        history,
        keys: await window.browserPeersTest.key(),
        consent: await window.browserPeersTest.consentStatus(),
        exported: await window.browserPeersTest.historyExport({
          expectedRevision: history.meta!.revision,
          confirmed: true,
        }),
      };
    });
    await reopen(page, f.f);
    await f.authorize();
    const after = await page.evaluate(async () => {
      const history = await window.browserPeersTest.historyStatus();
      return {
        history,
        keys: await window.browserPeersTest.key(),
        consent: await window.browserPeersTest.consentStatus(),
        exported: await window.browserPeersTest.historyExport({
          expectedRevision: history.meta!.revision,
          confirmed: true,
        }),
      };
    });
    expect(after.keys).toEqual(before.keys);
    expect(after.consent).toEqual(before.consent);
    expect(after.exported).toEqual(before.exported);
    expect(after.exported.entries[0]!.input).toEqual(payload);
    expect(after.history.entries[0]!.id).toBe(entry.id);
    expect(after.history.entries[0]!.relayDelivery).toBeNull();
    const owner = f.f.binding.ownerId;
    expect(
      await page.evaluate(async (owner) => {
        const url = "/legacy-delivery/index.js",
          previous = await import(/* @vite-ignore */ url);
        try {
          const h = await previous.BrowserTaskHistory.open(owner, () => owner);
          h.close();
          return "opened";
        } catch {
          return "denied";
        }
      }, owner),
    ).toBe("denied");
  } finally {
    f.mac.close();
  }
});
