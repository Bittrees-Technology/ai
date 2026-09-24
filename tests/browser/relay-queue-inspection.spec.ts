import { expect } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready, send, payload } from "./support/relay-endpoints.js";
import { corrupt, stored } from "./support/relay-queue.js";

test("Mac bounded queue inspection reaches a later authorized task without acknowledging or deleting the bad first message", async ({
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
    await corrupt(identityServer.pool, first.receipt.messageId);
    const review = await page.evaluate(
      (p) => window.browserPeersTest.relayPrepare(p),
      {
        ...f.route,
        payload: { ...payload, prompt: "SYNTHETIC_LATER_VALID_TASK" },
      },
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
    await send(page, { ...f, entry });
    const api = await f.native.openLocalApi();
    try {
      const r = f.native.record();
      const inspect = (after: any = null) =>
        api.call("/v1/private-relay/inspect-task", "POST", {
          id: r.id,
          expectedRevision: r.revision,
          after,
          confirmed: true,
        });
      const firstItem = await inspect();
      expect(firstItem.item!.selection.messageId).toBe(first.receipt.messageId);
      expect(JSON.stringify(firstItem)).not.toMatch(
        /ciphertext|credential|SYNTHETIC|senderId/,
      );
      await expect(
        f.native.check(null, firstItem.item!.selection),
      ).rejects.toThrow();
      expect(f.native.tasks()).toHaveLength(0);
      const later = await inspect(firstItem.item!.cursor);
      expect(later.item!.selection.messageId).toBe(entry.header.messageId);
      // The selected later item must not accidentally accept the unchanged first item.
      await expect(f.native.check(null, later.item!.selection)).rejects.toThrow(
        "CONFLICT",
      );
      const accepted = await f.native.check(
        firstItem.item!.cursor,
        later.item!.selection,
      );
      expect(accepted.received!.operationId).toBe(entry.id);
      expect(f.native.tasks()).toHaveLength(1);
      expect(f.native.task(accepted.received!.taskId).input.prompt).toBe(
        "SYNTHETIC_LATER_VALID_TASK",
      );
      expect(
        await stored(identityServer.pool, first.receipt.messageId),
      ).toEqual({ state: "stored", received_at: null, deleted_at: null });
      expect((await inspect()).item!.selection.messageId).toBe(
        first.receipt.messageId,
      );
    } finally {
      await api.close();
    }
  } finally {
    f.mac.close();
  }
});

test("Browser bounded queue inspection reaches an authenticated result behind a bad receipt without trusting queue metadata", async ({
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
    await send(page, f);
    await f.native.check();
    const acceptance = await f.native.prepareResponse(f.entry.id, "accepted");
    const first = await f.native.sendResponse(acceptance.id);
    await corrupt(identityServer.pool, first.receipt.messageId);
    await f.mac.work();
    const result = await f.native.prepareResponse(f.entry.id, "result");
    const sent = await f.native.sendResponse(result.id);
    const inspect = (after: any = null) =>
      page.evaluate(
        (after) =>
          window.browserPeersTest.relayInspect({ after, confirmed: true }),
        after,
      );
    const firstItem = await inspect();
    expect(firstItem.transportOnly).toBe(true);
    expect(firstItem.item!.selection.messageId).toBe(first.receipt.messageId);
    expect(JSON.stringify(firstItem)).not.toMatch(
      /ciphertext|credential|Synthetic result|senderId/,
    );
    await expect(
      page.evaluate(
        (selection) =>
          window.browserPeersTest.relayCheck({
            after: null,
            selection,
            confirmed: true,
          }),
        firstItem.item!.selection,
      ),
    ).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries[0]!.state,
    ).toBe("pending");
    const later = await inspect(firstItem.item!.cursor);
    expect(later.item!.selection.messageId).toBe(sent.receipt.messageId);
    await expect(
      page.evaluate(
        (selection) =>
          window.browserPeersTest.relayCheck({
            after: null,
            selection,
            confirmed: true,
          }),
        later.item!.selection,
      ),
    ).rejects.toThrow("CONFLICT");
    const accepted = await page.evaluate(
      (p) => window.browserPeersTest.relayCheck({ ...p, confirmed: true }),
      { after: firstItem.item!.cursor, selection: later.item!.selection },
    );
    expect(accepted.received!.kind).toBe("result");
    const current = (
      await page.evaluate(() => window.browserPeersTest.historyStatus())
    ).entries[0]!;
    const output = await page.evaluate(
      (p) => window.browserPeersTest.composeReadResult(p),
      {
        ...f.route,
        id: current.id,
        expectedRevision: current.revision,
        confirmed: true,
      },
    );
    expect(output.task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    expect(await stored(identityServer.pool, first.receipt.messageId)).toEqual({
      state: "stored",
      received_at: null,
      deleted_at: null,
    });
    expect((await inspect()).item!.selection.messageId).toBe(
      first.receipt.messageId,
    );
  } finally {
    f.mac.close();
  }
});

test("Browser queue inspection rejects caller limits and scope loss without acknowledgement", async ({
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
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.relayInspect({
          after: null,
          confirmed: true,
          limit: 20,
        }),
      ),
    ).rejects.toThrow();
    identityServer.hold("/browser/relay/messages/poll");
    const outcome = page
      .evaluate(() =>
        window.browserPeersTest.relayInspect({ after: null, confirmed: true }),
      )
      .then(
        () => "accepted",
        () => "denied",
      );
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    identityServer.release();
    expect(await outcome).toBe("denied");
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
  } finally {
    identityServer.release();
    f.mac.close();
  }
});

test("Mac queue inspection stops when native relay scope changes during real HTTPS polling", async ({
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
    await send(page, f);
    identityServer.hold("/device/relay/messages/poll");
    const outcome = f.native.inspect().then(
      () => "accepted",
      () => "denied",
    );
    await expect.poll(() => identityServer.held()).toBe(true);
    f.native.relay.invalidate();
    identityServer.release();
    expect(await outcome).toBe("denied");
    expect(f.native.tasks()).toHaveLength(0);
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
  } finally {
    identityServer.release();
    f.mac.close();
  }
});
