import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready, send, payload } from "./support/relay-endpoints.js";
test("verified browser host relays retained ciphertext and reopens without duplicating a locally admitted task", async ({
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
    const sent = await send(page, f);
    expect(sent.transportOnly).toBe(true);
    expect(sent.receipt.state).toBe("stored");
    expect(sent.duplicate).toBe(false);
    const received = await f.native.check();
    expect(received.received?.status).toBe("accepted-locally");
    expect(received.transport?.receipt.state).toBe("received");
    expect(f.native.task(received.received!.taskId).input.prompt).toBe(
      payload.prompt,
    );
    expect(f.native.tasks()).toHaveLength(1);
    // The retained receiver also reconciles this exact delivery during local work.
    const admitted = await f.mac.executeTask(f.entry.envelope);
    expect(admitted.receipt.taskId).toBe(received.received!.taskId);
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries[0]!.state,
    ).toBe("pending");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retry = await send(page, f);
    expect(retry.duplicate).toBe(true);
    expect(retry.receipt.messageId).toBe(sent.receipt.messageId);
    expect(retry.receipt.state).toBe("received");
    expect(await f.native.check()).toEqual({
      received: null,
      nextCursor: null,
    });
    expect((await f.mac.executeTask(f.entry.envelope)).receipt.taskId).toBe(
      admitted.receipt.taskId,
    );
    const rows = (
      await identityServer.pool.query(
        "SELECT envelope FROM remote_private_messages WHERE owner_id=$1",
        [f.registration.binding.ownerId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(payload.prompt);
  } finally {
    f.mac.close();
  }
});
test("lost browser relay submission reply retries the same durable task and envelope", async ({
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
    identityServer.loseResponse("/browser/relay/messages/submit");
    await expect(send(page, f)).rejects.toThrow();
    const retried = await send(page, f);
    expect(retried.duplicate).toBe(true);
    const received = await f.native.check();
    expect(received.received?.status).toBe("accepted-locally");
    expect(f.native.task(received.received!.taskId).input.prompt).toBe(
      payload.prompt,
    );
    expect(f.native.tasks()).toHaveLength(1);
    const history = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.attempts).toBe(2);
    expect(history.entries[0]!.id).toBe(f.entry.id);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});
test("scope loss during recipient readiness prevents delivery of the saved browser task", async ({
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
    identityServer.hold("/browser/relay/messages/recipient");
    const outcome = send(page, f).then(
      () => "accepted",
      () => "denied",
    );
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    identityServer.release();
    expect(await outcome).toBe("denied");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toHaveLength(0);
    expect(await f.native.check()).toEqual({
      received: null,
      nextCursor: null,
    });
    expect(f.native.tasks()).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});

test("native Mac receiver preserves one local task when the real relay saves acknowledgement but loses its reply", async ({
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
    const sent = await send(page, f);
    identityServer.drop("/device/relay/messages/acknowledge");
    await expect(f.native.check()).rejects.toThrow();
    expect(f.native.tasks()).toHaveLength(1);
    const taskId = f.native.tasks()[0]!.id;
    expect(f.native.task(taskId).input.prompt).toBe(payload.prompt);
    expect(await f.native.check()).toEqual({
      received: null,
      nextCursor: null,
    });
    const retry = await send(page, f);
    expect(retry.duplicate).toBe(true);
    expect(retry.receipt.messageId).toBe(sent.receipt.messageId);
    expect(retry.receipt.state).toBe("received");
    expect(f.native.tasks()).toHaveLength(1);
    expect(f.native.tasks()[0]!.id).toBe(taskId);
    expect(f.native.controls.taskStatus().responses).toHaveLength(0);
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries[0]!.state,
    ).toBe("pending");
    expect(
      identityServer.events.filter(
        (p) => p === "/device/relay/messages/acknowledge",
      ),
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});

test("a native stop during a held real relay delivery admits and acknowledges nothing", async ({
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
    const outcome = f.native.check().then(
      () => "accepted",
      () => "denied",
    );
    await expect.poll(() => identityServer.held()).toBe(true);
    f.native.relay.invalidate();
    identityServer.release();
    expect(await outcome).toBe("denied");
    expect(f.native.tasks()).toHaveLength(0);
    expect(
      identityServer.events.filter(
        (p) => p === "/device/relay/messages/acknowledge",
      ),
    ).toHaveLength(0);
    const record = f.native.record();
    const review = await f.native.relay.prepare({
      action: "stop",
      id: record.id,
      expectedRevision: record.revision,
    });
    await f.native.relay.confirm({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    const before = identityServer.events.length;
    await expect(f.native.check()).rejects.toThrow();
    expect(
      identityServer.events
        .slice(before)
        .filter((p) => p.includes("/relay/messages/")),
    ).toHaveLength(0);
    expect(f.native.record().phase).toBe("stopped");
  } finally {
    identityServer.release();
    f.mac.close();
  }
});

async function checkBrowser(page: Page) {
  return page.evaluate(() =>
    window.browserPeersTest.relayCheck({ after: null, confirmed: true }),
  );
}
async function currentBrowserEntry(page: Page) {
  return (await page.evaluate(() => window.browserPeersTest.historyStatus()))
    .entries[0]!;
}
async function readBrowserResult(
  page: Page,
  f: Awaited<ReturnType<typeof ready>>,
) {
  const entry = await currentBrowserEntry(page);
  return page.evaluate((p) => window.browserPeersTest.composeReadResult(p), {
    ...f.route,
    id: entry.id,
    expectedRevision: entry.revision,
    confirmed: true,
  });
}
async function sendResponse(
  f: Awaited<ReturnType<typeof ready>>,
  kind: "accepted" | "result",
) {
  const prepared = await f.native.prepareResponse(f.entry.id, kind);
  return f.native.sendResponse(prepared.id);
}
test("real native relay acceptance and result are authenticated, retained and explicitly read by the browser", async ({
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
    const accepted = await sendResponse(f, "accepted");
    expect(accepted.transportOnly).toBe(true);
    expect((await currentBrowserEntry(page)).state).toBe("pending");
    const received = await checkBrowser(page);
    expect(received.received?.kind).toBe("receipt");
    expect(received.received?.operationId).toBe(f.entry.id);
    expect(received.transport?.receipt.state).toBe("received");
    expect(received.transport?.transportOnly).toBe(true);
    expect((await currentBrowserEntry(page)).state).toBe("accepted");
    await expect(readBrowserResult(page, f)).rejects.toThrow();
    await f.mac.work();
    await sendResponse(f, "result");
    const result = await checkBrowser(page);
    expect(result.received?.kind).toBe("result");
    expect(result.received?.operationId).toBe(f.entry.id);
    expect(JSON.stringify(result)).not.toMatch(
      /ciphertext|Synthetic result|publicKey|credential"/,
    );
    expect((await readBrowserResult(page, f)).task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect((await readBrowserResult(page, f)).task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    expect(await checkBrowser(page)).toEqual({
      received: null,
      nextCursor: null,
    });
    const rows = (
      await identityServer.pool.query(
        "SELECT envelope, state FROM remote_private_messages WHERE owner_id=$1",
        [f.registration.binding.ownerId],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === "received")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(payload.prompt);
    expect(JSON.stringify(rows)).not.toContain("Synthetic result");
  } finally {
    f.mac.close();
  }
});
test("browser authenticates a result before its separate acceptance receipt without trusting an external response kind", async ({
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
    await f.mac.work();
    await sendResponse(f, "result");
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.relayCheck({
          after: null,
          confirmed: true,
          kind: "receipt",
        }),
      ),
    ).rejects.toThrow();
    expect((await checkBrowser(page)).received?.kind).toBe("result");
    const result = await readBrowserResult(page, f);
    await sendResponse(f, "accepted");
    expect((await checkBrowser(page)).received?.kind).toBe("receipt");
    expect(await readBrowserResult(page, f)).toEqual(result);
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries,
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("browser retains an authenticated result when the relay commits acknowledgement but loses its reply", async ({
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
    await f.mac.work();
    await sendResponse(f, "result");
    identityServer.loseResponse("/browser/relay/messages/acknowledge");
    await expect(checkBrowser(page)).rejects.toThrow();
    const saved = await currentBrowserEntry(page);
    expect(saved.state).toBe("accepted");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(await checkBrowser(page)).toEqual({
      received: null,
      nextCursor: null,
    });
    expect((await currentBrowserEntry(page)).revision).toBe(saved.revision);
    expect((await readBrowserResult(page, f)).task.output).toContain(
      "Synthetic result",
    );
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("browser scope loss during a held relay poll saves and acknowledges no result", async ({
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
    await f.mac.work();
    await sendResponse(f, "result");
    const before = await currentBrowserEntry(page);
    identityServer.hold("/browser/relay/messages/poll");
    const outcome = checkBrowser(page).then(
      () => "accepted",
      () => "denied",
    );
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    identityServer.release();
    expect(await outcome).toBe("denied");
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(0);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect((await currentBrowserEntry(page)).revision).toBe(before.revision);
    expect((await currentBrowserEntry(page)).state).toBe("pending");
    expect((await checkBrowser(page)).received?.kind).toBe("result");
  } finally {
    f.mac.close();
  }
});
test("browser result dispatch requires separate result consent even when task sending and receipt delivery are allowed", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
    false,
  );
  try {
    await send(page, f);
    await f.native.check();
    await sendResponse(f, "accepted");
    expect((await checkBrowser(page)).received?.kind).toBe("receipt");
    const before = await currentBrowserEntry(page);
    await f.mac.work();
    await sendResponse(f, "result");
    await expect(checkBrowser(page)).rejects.toThrow();
    expect((await currentBrowserEntry(page)).revision).toBe(before.revision);
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(1);
    await expect(readBrowserResult(page, f)).rejects.toThrow();
  } finally {
    f.mac.close();
  }
});

test("browser reconciles a redelivered result after an acknowledgement rejected before server commit", async ({
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
    await f.mac.work();
    const sent = await sendResponse(f, "result");
    identityServer.reject("/browser/relay/messages/acknowledge");
    await expect(checkBrowser(page)).rejects.toThrow();
    const saved = await currentBrowserEntry(page);
    expect(saved.state).toBe("accepted");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retry = await checkBrowser(page);
    expect(retry.received?.kind).toBe("result");
    expect(retry.received?.messageId).toBe(sent.receipt.messageId);
    expect(retry.transport?.receipt.state).toBe("received");
    expect((await currentBrowserEntry(page)).revision).toBe(saved.revision);
    expect((await readBrowserResult(page, f)).task.output).toContain(
      "Synthetic result",
    );
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/acknowledge",
      ),
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});
