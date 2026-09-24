import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
import { randomUUID } from "node:crypto";

type Fixture = Awaited<ReturnType<typeof ready>>;
async function grant(page: Page, f: Fixture, questions = false) {
  const offer = await f.mac.conversationOffer(undefined, { questions });
  const saved = await page.evaluate(
    async ({ envelope, route, permissions, expiresAt }) => {
      const api = window.browserPeersTest,
        state = await api.conversationStatus();
      const review = await api.conversationPrepare({
        ...route,
        expectedRevision: state.revision,
        envelope,
        permissions,
        expiresAt,
      });
      return api.conversationApprove({
        reviewId: review.reviewId,
        expectedRevision: review.expectedRevision,
        confirmed: true,
        acknowledged: true,
      });
    },
    {
      envelope: offer.envelope,
      route: f.route,
      permissions: offer.data.permissions,
      expiresAt: Math.min(Date.now() + 240000, offer.data.expiresAt),
    },
  );
  return { offer, grant: saved };
}
const list = (page: Page, grantId: string) =>
  page.evaluate(
    (grantId) => window.browserPeersTest.contentList({ grantId }),
    grantId,
  );
const accept = (page: Page, grantId: string, envelope: unknown) =>
  page.evaluate((raw) => window.browserPeersTest.contentAccept(raw), {
    grantId,
    envelope,
    confirmed: true,
  });
const prepare = (
  page: Page,
  grantId: string,
  patch: Record<string, unknown> = {},
) =>
  page.evaluate((raw) => window.browserPeersTest.contentPrepare(raw), {
    grantId,
    id: randomUUID(),
    kind: "message",
    parentId: null,
    content: "SYNTHETIC_HOST_PRIVATE_REPLY",
    expiresAt: Date.now() + 60000,
    confirmed: true,
    ...patch,
  });
const read = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentRead(raw), {
    grantId: entry.grantId,
    id: entry.id,
  });
const wire = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentEnvelope(raw), {
    grantId: entry.grantId,
    id: entry.id,
    expectedRevision: entry.revision,
    confirmed: true,
  });
const snapshot = (page: Page) =>
  page.evaluate(() => window.browserPeersTest.contentInspect());

test("trusted browser host opens actual Mac content, keeps listing metadata-only and reuses encrypted replies after reload", async ({
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
    const selected = await grant(page, f),
      envelope = await selected.offer.message("SYNTHETIC_MAC_HOST_MESSAGE");
    const tasks = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    identityServer.events.length = 0;
    expect(await list(page, selected.grant.id)).toEqual([]);
    const accepted = await accept(page, selected.grant.id, envelope);
    const listing = await list(page, selected.grant.id);
    expect(listing).toEqual([accepted.entry]);
    expect(JSON.stringify(listing)).not.toContain("SYNTHETIC_MAC_HOST_MESSAGE");
    expect(JSON.stringify(listing)).not.toContain('"key"');
    expect((await read(page, accepted.entry)).content.content).toBe(
      "SYNTHETIC_MAC_HOST_MESSAGE",
    );
    const reply = await prepare(page, selected.grant.id, {
      parentId: accepted.entry.id,
    });
    const encrypted = await wire(page, reply);
    expect((await selected.offer.receive(encrypted)).duplicate).toBe(false);
    expect((await selected.offer.receive(encrypted)).duplicate).toBe(true);
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.items).toHaveLength(2);
    expect(archive.restoreAuthority).toBe(false);
    expect(
      identityServer.events.filter(
        (path) => path === "/browser/registration/identity",
      ).length,
    ).toBeGreaterThanOrEqual(7);
    expect(
      identityServer.events.filter((path) => path.includes("/relay/")),
    ).toEqual([]);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(tasks);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(await list(page, selected.grant.id)).toHaveLength(2);
    expect(await wire(page, { ...reply, revision: 2 })).toEqual(encrypted);
    expect((await read(page, accepted.entry)).content.content).toBe(
      "SYNTHETIC_MAC_HOST_MESSAGE",
    );
  } finally {
    f.mac.close();
  }
});

test("unavailable identity denies every content action while explicit owner deletion stays offline", async ({
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
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_OFFLINE_HISTORY");
    const accepted = await accept(page, selected.grant.id, incoming);
    const before = await snapshot(page),
      consent = await page.evaluate(() =>
        window.browserPeersTest.conversationStatus(),
      );
    const tasks = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    identityServer.offline(true);
    await expect(list(page, selected.grant.id)).rejects.toThrow();
    await expect(read(page, accepted.entry)).rejects.toThrow();
    await expect(prepare(page, selected.grant.id)).rejects.toThrow();
    await expect(wire(page, accepted.entry)).rejects.toThrow();
    await expect(accept(page, selected.grant.id, incoming)).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: true }),
      ),
    ).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.events.length = 0;
    const cleared = await page.evaluate(
      (revision) =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision: revision,
          confirmed: true,
        }),
      consent.revision,
    );
    expect(cleared.removed).toBe(1);
    expect(identityServer.events).toEqual([]);
    const after = await snapshot(page);
    expect(after.count).toBe(0);
    expect(after.ledger).toBe(before.ledger);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .needsFreshDevice,
    ).toBe(true);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(tasks);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("account scope loss during local encryption rolls back admission and permits explicit retry after fresh sign-in context", async ({
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
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_LOST_SCOPE");
    const before = await snapshot(page);
    await page.evaluate(() => window.browserPeersTest.contentHoldEncryption());
    const pending = accept(page, selected.grant.id, incoming).then(
      () => "unexpected",
      () => "denied",
    );
    await page.waitForFunction(() => window.browserPeersTest.held());
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toBe("denied");
    expect(await snapshot(page)).toEqual(before);
    await expect(list(page, selected.grant.id)).rejects.toThrow("DENIED");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect((await accept(page, selected.grant.id, incoming)).duplicate).toBe(
      false,
    );
    expect((await accept(page, selected.grant.id, incoming)).duplicate).toBe(
      true,
    );
  } finally {
    f.mac.close();
  }
});

test("content shares the host operation lock and cancellation cannot publish pending preparation", async ({
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
    const selected = await grant(page, f),
      before = await snapshot(page);
    await page.evaluate(() => window.browserPeersTest.contentHoldEncryption());
    const pending = prepare(page, selected.grant.id).then(
      () => "unexpected",
      () => "denied",
    );
    await page.waitForFunction(() => window.browserPeersTest.held());
    await expect(list(page, selected.grant.id)).rejects.toThrow("BUSY");
    await expect(
      page.evaluate(() => window.browserPeersTest.keyStatus()),
    ).rejects.toThrow("BUSY");
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toBe("denied");
    expect(await snapshot(page)).toEqual(before);
    expect(await list(page, selected.grant.id)).toEqual([]);
    await prepare(page, selected.grant.id);
    expect(await list(page, selected.grant.id)).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});

test("revoked device keys deny conversation access but explicit verified-owner archive export retains history", async ({
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
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_OWNER_ARCHIVE");
    const accepted = await accept(page, selected.grant.id, incoming);
    await page.evaluate(
      (proof) =>
        window.browserPeersTest.hostKeyRevoke({
          keyId: proof.keyId,
          expectedRevision: proof.revision,
          confirmed: true,
        }),
      selected.grant.local,
    );
    await expect(list(page, selected.grant.id)).rejects.toThrow();
    await expect(read(page, accepted.entry)).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: false }),
      ),
    ).rejects.toThrow();
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.items).toHaveLength(1);
    expect(archive.items[0]!.content.content).toBe("SYNTHETIC_OWNER_ARCHIVE");
    expect(JSON.stringify(archive)).not.toContain('"grant"');
    expect(JSON.stringify(archive)).not.toContain('"key"');
    await page.evaluate(() => window.browserPeersTest.logout());
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: true }),
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision: 1,
          confirmed: true,
        }),
      ),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

test("selected-grant listing excludes other conversations and refuses stale grants after revocation", async ({
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
    const first = await grant(page, f),
      one = await prepare(page, first.grant.id);
    const second = await grant(page, f),
      two = await prepare(page, second.grant.id);
    expect(await list(page, first.grant.id)).toEqual([one]);
    expect(await list(page, second.grant.id)).toEqual([two]);
    await expect(list(page, randomUUID())).rejects.toThrow("DENIED");
    const status = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRevoke(raw),
      {
        grantId: first.grant.id,
        expectedRevision: status.revision,
        confirmed: true,
      },
    );
    await expect(list(page, first.grant.id)).rejects.toThrow("DENIED");
    expect(await list(page, second.grant.id)).toEqual([two]);
    expect(
      (
        await page.evaluate(() =>
          window.browserPeersTest.contentExport({ confirmed: true }),
        )
      ).items,
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});

test("lost final identity responses retain committed preparation, original ciphertext and exactly-once acceptance for explicit reconciliation", async ({
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
    const selected = await grant(page, f),
      request = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    identityServer.reject("/browser/registration/identity", 1);
    await expect(prepare(page, selected.grant.id, request)).rejects.toThrow();
    const [pending] = await list(page, selected.grant.id);
    expect(pending).toMatchObject({
      id: request.id,
      state: "preparing",
      revision: 1,
    });
    const preparedSnapshot = await snapshot(page);
    expect(await prepare(page, selected.grant.id, request)).toEqual(pending);
    expect(await snapshot(page)).toEqual(preparedSnapshot);
    identityServer.reject("/browser/registration/identity", 1);
    await expect(wire(page, pending)).rejects.toThrow();
    const [sealed] = await list(page, selected.grant.id);
    expect(sealed).toMatchObject({
      id: request.id,
      state: "ready",
      revision: 2,
    });
    const envelope = await wire(page, sealed);
    expect(await wire(page, sealed)).toEqual(envelope);
    expect((await selected.offer.receive(envelope)).duplicate).toBe(false);
    const reply = await selected.offer.message(
      "SYNTHETIC_RECONCILED_REPLY",
      request.id,
    );
    identityServer.reject("/browser/registration/identity", 1);
    await expect(accept(page, selected.grant.id, reply)).rejects.toThrow();
    expect(await list(page, selected.grant.id)).toHaveLength(2);
    const admittedSnapshot = await snapshot(page);
    expect((await accept(page, selected.grant.id, reply)).duplicate).toBe(true);
    expect(await snapshot(page)).toEqual(admittedSnapshot);
  } finally {
    f.mac.close();
  }
});

test("authenticated receipt reconciliation denies offline identity and preserves uncertain committed outcomes for explicit retry", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id);
    const envelope = await wire(page, prepared),
      receipt = await selected.offer.receipt(envelope);
    const entry = (await list(page, selected.grant.id))[0]!;
    const reconcile = (entry: any) =>
      page.evaluate((raw) => window.browserPeersTest.contentReconcile(raw), {
        grantId: entry.grantId,
        id: entry.id,
        expectedRevision: entry.revision,
        envelope: receipt,
        confirmed: true,
      });
    const before = await snapshot(page);
    identityServer.offline(true);
    await expect(reconcile(entry)).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.offline(false);
    identityServer.events.length = 0;
    identityServer.reject("/browser/registration/identity", 1);
    await expect(reconcile(entry)).rejects.toThrow();
    const [stored] = await list(page, selected.grant.id);
    expect(stored).toMatchObject({
      id: entry.id,
      revision: 3,
      recipientAccepted: true,
    });
    const committed = await snapshot(page);
    expect((await reconcile(stored)).duplicate).toBe(true);
    expect(await snapshot(page)).toEqual(committed);
    expect(await wire(page, stored)).toEqual(envelope);
    expect(
      identityServer.events.filter((path) => path.includes("/relay/")),
    ).toEqual([]);
    await page.evaluate(() => window.browserPeersTest.logout());
    await expect(reconcile(stored)).rejects.toThrow("DENIED");
    expect(await snapshot(page)).toEqual(committed);
  } finally {
    f.mac.close();
  }
});

const relayTarget = (entry: any) => ({
  grantId: entry.grantId,
  id: entry.id,
  expectedRevision: entry.revision,
  confirmed: true,
});
const relaySendContent = (page: Page, entry: any) =>
  page.evaluate(
    (raw) => window.browserPeersTest.contentRelaySend(raw),
    relayTarget(entry),
  );
async function receiveThroughMacApi(
  f: Fixture,
  api: Awaited<ReturnType<Fixture["native"]["openLocalApi"]>>,
  target: any,
) {
  const record = f.native.record(),
    query = {
      connection: { id: record.id, expectedRevision: record.revision },
      after: null,
      confirmed: true,
    };
  const inspected = await api.call(
    "/v1/private-relay/inspect-conversation",
    "POST",
    query,
  );
  expect(inspected.item).not.toBeNull();
  return api.call("/v1/private-relay/check-conversation", "POST", {
    ...query,
    selection: inspected.item.selection,
    target,
  });
}

test("host relay message upload survives a lost server reply and reload before actual Mac HTTP admission", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi();
  try {
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id),
      original = await wire(page, prepared);
    const entry = await read(page, prepared);
    identityServer.loseResponse("/browser/relay/messages/submit");
    await expect(relaySendContent(page, entry)).rejects.toThrow();
    const uncertain = await read(page, entry);
    expect(uncertain.relayAttempts).toBe(1);
    expect(uncertain.relayObservation).toBeNull();
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retry = await relaySendContent(page, await read(page, entry));
    expect(retry.entry.relayAttempts).toBe(2);
    expect(retry.entry.recipientAccepted).toBe(false);
    expect(retry.transport.transportOnly).toBe(true);
    expect(retry.transport.duplicate).toBe(true);
    expect(await wire(page, retry.entry)).toEqual(original);
    const received = await receiveThroughMacApi(f, api, {
      action: "receive",
      permissionId: selected.offer.data.scope.permissionId,
    });
    expect(received.received.status).toBe("accepted-locally");
    expect(received.received.duplicate).toBe(false);
    expect(JSON.stringify(received)).not.toContain(
      "SYNTHETIC_HOST_PRIVATE_REPLY",
    );
    expect((await selected.offer.receive(original)).duplicate).toBe(true);
    const receipt = await selected.offer.receipt(original);
    const reconciled = await page.evaluate(
      (raw) => window.browserPeersTest.contentReconcile(raw),
      { ...relayTarget(retry.entry), envelope: receipt },
    );
    expect(reconciled.entry.recipientAccepted).toBe(true);
    expect(await wire(page, reconciled.entry)).toEqual(original);
  } finally {
    await api.close();
    f.mac.close();
  }
});

test("host relay sends only an incoming message storage receipt and Mac HTTP reconciles the exact outgoing original", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi();
  try {
    const selected = await grant(page, f),
      original = await selected.offer.message("SYNTHETIC_RECEIPT_ONLY");
    const accepted = await accept(page, selected.grant.id, original);
    await expect(relaySendContent(page, accepted.entry)).rejects.toThrow(
      "DENIED",
    );
    const receipt = await wire(page, accepted.entry),
      saved = await read(page, accepted.entry);
    expect(receipt).not.toEqual(original);
    const sent = await relaySendContent(page, saved);
    expect(sent.entry.direction).toBe("incoming");
    expect(sent.entry.recipientAccepted).toBe(false);
    const outgoing = f.native.controls
      .conversationContentStatus()
      .items.find((e) => e.id === original.header.operationId)!;
    const received = await receiveThroughMacApi(f, api, {
      action: "reconcile",
      permissionId: selected.offer.data.scope.permissionId,
      id: outgoing.id,
      expectedRevision: outgoing.revision,
    });
    expect(received.received.status).toBe("recipient-storage-confirmed");
    expect(received.received.entry.recipientAccepted).toBe(true);
    expect(await wire(page, sent.entry)).toEqual(receipt);
    expect((await read(page, sent.entry)).content.content).toBe(
      "SYNTHETIC_RECEIPT_ONLY",
    );
  } finally {
    await api.close();
    f.mac.close();
  }
});

test("host relay denies failed identity or recipient access without an attempt and local stop still works offline", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id);
    await wire(page, prepared);
    const entry = await read(page, prepared),
      before = await snapshot(page);
    identityServer.reject("/browser/relay/messages/recipient");
    await expect(relaySendContent(page, entry)).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.offline(true);
    await expect(relaySendContent(page, entry)).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.events.length = 0;
    const stopped = await page.evaluate(
      (raw) => window.browserPeersTest.contentRelayStop(raw),
      relayTarget(entry),
    );
    expect(stopped.relayStopped).toBe(true);
    expect(identityServer.events).toEqual([]);
    identityServer.offline(false);
    await expect(relaySendContent(page, stopped)).rejects.toThrow("DENIED");
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("host relay excludes concurrent work and rejects a response after identity cancellation while retaining the uncertain attempt", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id);
    await wire(page, prepared);
    const entry = await read(page, prepared);
    identityServer.hold("/browser/relay/messages/submit");
    const pending = relaySendContent(page, entry),
      rejected = expect(pending).rejects.toThrow();
    await expect.poll(identityServer.held).toBe(true);
    await expect(relaySendContent(page, entry)).rejects.toThrow("BUSY");
    await page.evaluate(() => window.browserPeersTest.contentCancel());
    identityServer.release();
    await rejected;
    const saved = await read(page, entry);
    expect(saved.relayAttempts).toBe(1);
    expect(saved.relayObservation).toBeNull();
    expect(saved.recipientAccepted).toBe(false);
  } finally {
    identityServer.release();
    f.mac.close();
  }
});

test("host relay rechecks the durable original after asynchronous hashing and prevents a deleted copy from reaching the network", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id);
    await wire(page, prepared);
    const entry = await read(page, prepared);
    identityServer.events.length = 0;
    await page.evaluate(() => window.browserPeersTest.holdRelayDigest());
    const pending = relaySendContent(page, entry),
      rejected = expect(pending).rejects.toThrow("CONFLICT");
    await page.waitForFunction(() => window.browserPeersTest.held());
    await page.evaluate(() => window.browserPeersTest.contentInspect("remove"));
    await page.evaluate(() => window.browserPeersTest.release());
    await rejected;
    expect(
      identityServer.events.filter(
        (p) => p === "/browser/relay/messages/submit",
      ),
    ).toEqual([]);
    expect((await snapshot(page)).count).toBe(0);
  } finally {
    await page.evaluate(() => window.browserPeersTest.release());
    f.mac.close();
  }
});

test("host relay carries an exact browser answer through Mac HTTP into one real worker continuation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi();
  try {
    const selected = await grant(page, f, true),
      question = await selected.offer.question();
    expect(question.task().status).toBe("awaiting_input");
    const accepted = await accept(page, selected.grant.id, question.envelope);
    const answer = await prepare(page, selected.grant.id, {
      kind: "answer",
      parentId: accepted.entry.id,
      content: "Lisbon",
    });
    await wire(page, answer);
    const sent = await relaySendContent(page, await read(page, answer));
    expect(sent.entry.recipientAccepted).toBe(false);
    expect(question.task().status).toBe("awaiting_input");
    await receiveThroughMacApi(f, api, {
      action: "receive",
      permissionId: selected.offer.data.scope.permissionId,
    });
    expect(question.task().status).toBe("queued");
    expect(question.calls()).toBe(1);
    await question.run();
    expect(question.task().status).toBe("completed");
    expect(question.calls()).toBe(3);
    await question.run();
    expect(question.calls()).toBe(3);
  } finally {
    await api.close();
    f.mac.close();
  }
});

async function uploadToBrowser(f: Fixture, envelope: unknown) {
  const record = f.native.record();
  return f.native.relay.withTransport(
    { id: record.id, expectedRevision: record.revision },
    (client) => client.submit({ version: 1, envelope }),
  );
}
const inspectContentRelay = (page: Page, after: any = null) =>
  page.evaluate((raw) => window.browserPeersTest.contentRelayInspect(raw), {
    after,
    confirmed: true,
  });
const receiveContentRelay = (
  page: Page,
  selection: any,
  target: any,
  after: any = null,
) =>
  page.evaluate((raw) => window.browserPeersTest.contentRelayReceive(raw), {
    after,
    selection,
    target,
    confirmed: true,
  });
const receiveTarget = (grantId: string) => ({ action: "receive", grantId });
const ackPath = "/browser/relay/messages/acknowledge";

for (const loss of ["before", "after"] as const)
  test(`incoming conversation relay retains accepted content across acknowledgement loss ${loss} server persistence and browser reload`, async ({
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
      const selected = await grant(page, f),
        envelope = await selected.offer.message("SYNTHETIC_RELAY_RECEIVED");
      await uploadToBrowser(f, envelope);
      const before = await snapshot(page),
        queue = await inspectContentRelay(page);
      expect(await snapshot(page)).toEqual(before);
      expect(JSON.stringify(queue)).not.toContain("SYNTHETIC_RELAY_RECEIVED");
      expect(JSON.stringify(queue)).not.toContain("ciphertext");
      if (loss === "before") identityServer.reject(ackPath);
      else identityServer.loseResponse(ackPath);
      await expect(
        receiveContentRelay(
          page,
          queue.item!.selection,
          receiveTarget(selected.grant.id),
        ),
      ).rejects.toThrow();
      const entries = await list(page, selected.grant.id);
      expect(entries).toHaveLength(1);
      expect((await read(page, entries[0])).content.content).toBe(
        "SYNTHETIC_RELAY_RECEIVED",
      );
      const committed = await snapshot(page);
      await page.reload();
      await page.waitForFunction(() => !!window.browserPeersTest);
      await page.evaluate(() => window.browserPeersTest.resume());
      const remaining = await inspectContentRelay(page);
      if (loss === "before") {
        const retry = await receiveContentRelay(
          page,
          remaining.item!.selection,
          receiveTarget(selected.grant.id),
        );
        expect(retry.received.duplicate).toBe(true);
        expect(retry.transport.transportOnly).toBe(true);
        expect(JSON.stringify(retry)).not.toContain("SYNTHETIC_RELAY_RECEIVED");
      } else expect(remaining.item).toBeNull();
      expect(await snapshot(page)).toEqual(committed);
      expect((await inspectContentRelay(page)).item).toBeNull();
      // Receipt preparation/upload is a separate action, never an admission side effect.
      expect(
        identityServer.events.filter(
          (p) => p === "/browser/relay/messages/submit",
        ),
      ).toEqual([]);
    } finally {
      f.mac.close();
    }
  });

test("incoming conversation relay reconciles only the selected outgoing copy and recovers a committed receipt after acknowledgement failure", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id),
      original = await wire(page, prepared),
      saved = await read(page, prepared),
      receipt = await selected.offer.receipt(original);
    await uploadToBrowser(f, receipt);
    const queue = await inspectContentRelay(page),
      before = await snapshot(page);
    const target = { action: "reconcile", ...relayTarget(saved) };
    delete (target as any).confirmed;
    await expect(
      receiveContentRelay(page, queue.item!.selection, {
        ...target,
        id: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.reject(ackPath);
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow();
    const accepted = await read(page, saved);
    expect(accepted.recipientAccepted).toBe(true);
    expect(accepted.revision).toBe(saved.revision + 1);
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow("CONFLICT");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retry = await receiveContentRelay(page, queue.item!.selection, {
      ...target,
      expectedRevision: accepted.revision,
    });
    expect(retry.received.duplicate).toBe(true);
    expect(retry.received.entry.recipientAccepted).toBe(true);
    expect(await wire(page, accepted)).toEqual(original);
    expect(await list(page, selected.grant.id)).toHaveLength(1);
    expect((await inspectContentRelay(page)).item).toBeNull();
  } finally {
    f.mac.close();
  }
});

test("incoming conversation relay leaves replies pending until their exact parent is navigated to and rejects changed selections", async ({
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
    const selected = await grant(page, f),
      parent = await selected.offer.message("SYNTHETIC_PARENT"),
      reply = await selected.offer.message(
        "SYNTHETIC_REPLY",
        parent.header.operationId,
      );
    await uploadToBrowser(f, reply);
    await uploadToBrowser(f, parent);
    const queue = await inspectContentRelay(page),
      before = await snapshot(page),
      target = receiveTarget(selected.grant.id);
    expect(queue.item!.selection.messageId).toBe(reply.header.messageId);
    await expect(
      receiveContentRelay(
        page,
        {
          ...queue.item!.selection,
          revision: queue.item!.selection.revision + 1,
        },
        target,
      ),
    ).rejects.toThrow("CONFLICT");
    await expect(
      receiveContentRelay(page, undefined, target),
    ).rejects.toThrow();
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow("PARENT_PENDING");
    expect(await snapshot(page)).toEqual(before);
    expect(identityServer.events.filter((p) => p === ackPath)).toEqual([]);
    const later = await inspectContentRelay(page, queue.item!.cursor);
    expect(later.item!.selection.messageId).toBe(parent.header.messageId);
    await receiveContentRelay(
      page,
      later.item!.selection,
      target,
      queue.item!.cursor,
    );
    const accepted = await receiveContentRelay(
      page,
      queue.item!.selection,
      target,
    );
    expect(accepted.received.duplicate).toBe(false);
    expect((await read(page, accepted.received.entry)).content).toMatchObject({
      type: "conversation.message",
      parentId: parent.header.operationId,
    });
    expect(await list(page, selected.grant.id)).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});

test("incoming conversation relay rolls back a failed content write and revoked consent leaves the queue unacknowledged", async ({
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
    const selected = await grant(page, f),
      envelope = await selected.offer.message("SYNTHETIC_DENIED_RECEIVE");
    await uploadToBrowser(f, envelope);
    const queue = await inspectContentRelay(page),
      before = await snapshot(page),
      target = receiveTarget(selected.grant.id);
    await page.evaluate(() => window.browserPeersTest.contentFailWrite());
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow("CAPACITY");
    expect(await snapshot(page)).toEqual(before);
    await page.evaluate(async (grantId) => {
      const api = window.browserPeersTest,
        status = await api.conversationStatus();
      await api.conversationRevoke({
        grantId,
        expectedRevision: status.revision,
        confirmed: true,
      });
    }, selected.grant.id);
    const revoked = await snapshot(page);
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow("DENIED");
    expect(await snapshot(page)).toEqual(revoked);
    expect((await inspectContentRelay(page)).item!.selection).toEqual(
      queue.item!.selection,
    );
    expect(identityServer.events.filter((p) => p === ackPath)).toEqual([]);
  } finally {
    f.mac.close();
  }
});

test("incoming conversation relay cancellation during encryption prevents admission and acknowledgement", async ({
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
    const selected = await grant(page, f),
      envelope = await selected.offer.message("SYNTHETIC_HELD_RECEIVE");
    await uploadToBrowser(f, envelope);
    const queue = await inspectContentRelay(page),
      before = await snapshot(page),
      target = receiveTarget(selected.grant.id);
    await page.evaluate(() => window.browserPeersTest.contentHoldEncryption());
    const pending = receiveContentRelay(page, queue.item!.selection, target),
      rejected = expect(pending).rejects.toThrow("DENIED");
    await page.waitForFunction(() => window.browserPeersTest.held());
    await expect(
      receiveContentRelay(page, queue.item!.selection, target),
    ).rejects.toThrow("BUSY");
    await page.evaluate(() => window.browserPeersTest.contentCancel());
    await page.evaluate(() => window.browserPeersTest.release());
    await rejected;
    expect(await snapshot(page)).toEqual(before);
    expect(identityServer.events.filter((p) => p === ackPath)).toEqual([]);
    expect((await inspectContentRelay(page)).item!.selection).toEqual(
      queue.item!.selection,
    );
  } finally {
    await page.evaluate(() => window.browserPeersTest.release());
    f.mac.close();
  }
});

test("incoming conversation relay rejects another protocol family without changing content or acknowledging its queue item", async ({
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
    const selected = await grant(page, f);
    const otherOffer = await f.mac.conversationOffer(
      f.native.record().permission!.expiresAt,
    );
    await uploadToBrowser(f, otherOffer.envelope);
    const queue = await inspectContentRelay(page),
      before = await snapshot(page);
    await expect(
      receiveContentRelay(
        page,
        queue.item!.selection,
        receiveTarget(selected.grant.id),
      ),
    ).rejects.toThrow("DENIED");
    expect(await snapshot(page)).toEqual(before);
    expect((await inspectContentRelay(page)).item!.selection).toEqual(
      queue.item!.selection,
    );
    expect(identityServer.events.filter((p) => p === ackPath)).toEqual([]);
  } finally {
    f.mac.close();
  }
});

test("incoming conversation relay carries a real worker question to the browser and the exact answer back through Mac HTTP once", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  const api = await f.native.openLocalApi();
  try {
    const selected = await grant(page, f, true),
      question = await selected.offer.question();
    await uploadToBrowser(f, question.envelope);
    const queue = await inspectContentRelay(page),
      accepted = await receiveContentRelay(
        page,
        queue.item!.selection,
        receiveTarget(selected.grant.id),
      );
    expect(accepted.received.entry.kind).toBe("conversation.question");
    expect(question.task().status).toBe("awaiting_input");
    const answer = await prepare(page, selected.grant.id, {
      kind: "answer",
      parentId: accepted.received.entry.id,
      content: "Lisbon",
    });
    await wire(page, answer);
    await relaySendContent(page, await read(page, answer));
    await receiveThroughMacApi(f, api, {
      action: "receive",
      permissionId: selected.offer.data.scope.permissionId,
    });
    expect(question.task().status).toBe("queued");
    await question.run();
    expect(question.task().status).toBe("completed");
    expect(question.calls()).toBe(3);
    await question.run();
    expect(question.calls()).toBe(3);
  } finally {
    await api.close();
    f.mac.close();
  }
});

test("owner-local conversation delivery metadata survives offline reopen without plaintext, envelopes, identity calls or cross-account authority", async ({
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
    const selected = await grant(page, f),
      prepared = await prepare(page, selected.grant.id);
    await wire(page, prepared);
    const saved = await read(page, prepared);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    identityServer.offline(true);
    identityServer.events.length = 0;
    const history = await page.evaluate(() =>
      window.browserPeersTest.contentDeliveryHistory(),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: saved.id,
      grantId: saved.grantId,
      deliveryPrepared: true,
      relayAttempts: 0,
    });
    expect(JSON.stringify(history)).not.toContain(
      "SYNTHETIC_HOST_PRIVATE_REPLY",
    );
    expect(JSON.stringify(history)).not.toContain('"envelope"');
    expect(JSON.stringify(history)).not.toContain('"key"');
    const stopped = await page.evaluate(
      (raw) => window.browserPeersTest.contentRelayStop(raw),
      relayTarget(history[0]),
    );
    expect(stopped.relayStopped).toBe(true);
    expect(identityServer.events).toEqual([]);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await expect(
      page.evaluate(() => window.browserPeersTest.contentDeliveryHistory()),
    ).rejects.toThrow("DENIED");
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});
