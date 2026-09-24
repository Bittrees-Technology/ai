import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./support/browser-identity-server.js";
import { ready, send } from "./support/relay-endpoints.js";
const status = (page: Page) =>
  page.evaluate(() => window.browserPeersTest.historyStatus());
async function inspect(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 7);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(["entries", "channels", "task_preparations"]),
          result: any = {};
        for (const name of ["entries", "channels", "task_preparations"]) {
          const r = tx.objectStore(name).getAll();
          r.onsuccess = () => {
            result[name] =
              name === "task_preparations"
                ? r.result.map(({ key, ...rest }) => ({
                    ...rest,
                    extractable: key.extractable,
                  }))
                : r.result;
          };
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
test("browser relay confirmation survives reload and export while deletion retains sequence counters", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    expect((await status(page)).entries[0]!.relayDelivery).toBeNull();
    const sent = await send(page, f),
      known = (await status(page)).entries[0]!.relayDelivery!;
    expect(known.state).toBe("stored");
    expect(known.attempt).toBe(1);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const history = await status(page);
    expect(history.entries[0]!.relayDelivery).toEqual(known);
    expect(history.entries[0]!.state).toBe("pending");
    const exported = await page.evaluate(
      (expectedRevision) =>
        window.browserPeersTest.historyExport({
          expectedRevision,
          confirmed: true,
        }),
      history.meta!.revision,
    );
    expect(exported.entries[0]!.relayDelivery!.receipt).toEqual(sent.receipt);
    expect(exported.restoreAuthority).toBe(false);
    const before = await inspect(page);
    await page.evaluate(
      (expectedRevision) =>
        window.browserPeersTest.historyClear({
          expectedRevision,
          confirmed: true,
        }),
      history.meta!.revision,
    );
    const after = await inspect(page);
    expect(after.entries).toEqual([]);
    expect(after.task_preparations).toEqual([]);
    expect(after.channels).toEqual(before.channels);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("a newer lost browser submission preserves the previous confirmation until explicit reconciliation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const first = await send(page, f),
      known = (await status(page)).entries[0]!.relayDelivery!;
    identityServer.loseResponse("/browser/relay/messages/submit");
    await expect(send(page, f)).rejects.toThrow();
    const uncertain = (await status(page)).entries[0]!;
    expect(uncertain.attempts).toBe(2);
    expect(uncertain.relayDelivery).toEqual(known);
    await f.native.check();
    const reconciled = await send(page, f),
      saved = (await status(page)).entries[0]!;
    expect(reconciled.receipt.messageId).toBe(first.receipt.messageId);
    expect(saved.relayDelivery!.state).toBe("received");
    expect(saved.relayDelivery!.attempt).toBe(3);
    expect(saved.state).toBe("pending");
  } finally {
    f.mac.close();
  }
});
test("a failed browser acknowledgement write exposes uncertainty and retains the original ciphertext for retry", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as any).restoreDeliveryWrite = () => {
        IDBObjectStore.prototype.put = original;
      };
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof original>
      ) {
        if (this.name === "entries" && args[0]?.relayDelivery)
          throw new DOMException("synthetic", "QuotaExceededError");
        return original.apply(this, args);
      };
    });
    await expect(send(page, f)).rejects.toThrow();
    expect((await status(page)).entries[0]!.relayDelivery).toBeNull();
    expect((await status(page)).entries[0]!.attempts).toBe(1);
    await page.evaluate(() => (window as any).restoreDeliveryWrite());
    const retried = await send(page, f);
    expect(retried.duplicate).toBe(true);
    expect((await status(page)).entries[0]!.relayDelivery!.attempt).toBe(2);
    expect((await inspect(page)).entries[0].envelope).toEqual(f.entry.envelope);
  } finally {
    await page.evaluate(() => (window as any).restoreDeliveryWrite?.());
    f.mac.close();
  }
});
test("retained browser transport history rejects foreign, stale, regressing and invalidated receipt writes", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const first = await send(page, f);
    await f.native.check();
    const received = await send(page, f);
    expect(received.receipt.state).toBe("received");
    const before = await status(page),
      input = {
        id: f.entry.id,
        expectedRevision: before.entries[0]!.revision,
        envelope: f.entry.envelope,
        receipt: received.receipt,
      };
    for (const p of [
      { ...input, receipt: first.receipt },
      { ...input, expectedRevision: input.expectedRevision - 1 },
      { ...input, receipt: { ...received.receipt, messageId: randomUUID() } },
      {
        ...input,
        receipt: { ...received.receipt, envelopeHash: "f".repeat(64) },
      },
    ])
      await expect(
        page.evaluate((p) => window.browserPeersTest.recordRelayHistory(p), p),
      ).rejects.toThrow();
    await expect(
      page.evaluate(
        (p) => window.browserPeersTest.recordRelayHistory(p, false),
        input,
      ),
    ).rejects.toThrow();
    await expect(
      page.evaluate(
        (p) =>
          window.browserPeersTest.recordRelayHistory(p.input, true, p.owner),
        { input, owner: randomUUID() },
      ),
    ).rejects.toThrow();
    expect(await status(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});
