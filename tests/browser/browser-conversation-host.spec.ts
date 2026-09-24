import { expect } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
const selected = {
  messagesToMac: true,
  messagesToBrowser: false,
  questionsToBrowser: false,
  answersToMac: false,
};
test("verified browser host independently inspects, narrows and saves an actual Mac offer, retaining choices after reload", async ({
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
    const o = await f.mac.conversationOffer();
    const request = { ...f.route, expectedRevision: 0, envelope: o.envelope };
    const taskBefore = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    const opened = await page.evaluate(
      (raw) => window.browserPeersTest.conversationOpenOffer(raw),
      request,
    );
    expect(opened.offer).toEqual(o.data);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toHaveLength(0);
    const reviewed = await page.evaluate(
      (raw) => window.browserPeersTest.conversationPrepare(raw),
      {
        ...request,
        permissions: selected,
        expiresAt: Math.min(Date.now() + 60000, o.data.expiresAt),
      },
    );
    expect(reviewed.choices.permissions).toEqual(selected);
    const grant = await page.evaluate(
      (r) =>
        window.browserPeersTest.conversationApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        }),
      reviewed,
    );
    expect(grant.choices.scope).toEqual(o.data.scope);
    expect(grant.choices.permissions).toEqual(selected);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(taskBefore);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retained = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(retained.grants).toEqual([grant]);
    let identityCalls = 0;
    await page.route("**/browser/registration/identity", (route) => {
      identityCalls++;
      return route.abort("failed");
    });
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRevoke(raw),
      {
        grantId: grant.id,
        expectedRevision: retained.revision,
        confirmed: true,
      },
    );
    expect(identityCalls).toBe(0);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants[0]!.revoked,
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("browser host cancellation and account changes invalidate conversation reviews without widening task access", async ({
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
    const o = await f.mac.conversationOffer();
    const raw = {
      ...f.route,
      expectedRevision: 0,
      envelope: o.envelope,
      permissions: selected,
      expiresAt: Math.min(Date.now() + 60000, o.data.expiresAt),
    };
    const review = await page.evaluate(
      (raw) => window.browserPeersTest.conversationPrepare(raw),
      raw,
    );
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.conversationApprove({
            reviewId: r.reviewId,
            expectedRevision: r.expectedRevision,
            confirmed: true,
            acknowledged: true,
          }),
        review,
      ),
    ).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toHaveLength(0);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.conversationPrepare(raw),
        raw,
      ),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

async function relayOffer(f: Awaited<ReturnType<typeof ready>>) {
  const record = f.native.record(),
    o = await f.mac.conversationOffer(record.permission!.expiresAt);
  await f.native.relay.withTransport(
    { id: record.id, expectedRevision: record.revision },
    (client) => client.submit({ version: 1, envelope: o.envelope }),
  );
  return o;
}
const inspectRelayOffer = (
  page: import("@playwright/test").Page,
  after: any = null,
) =>
  page.evaluate(
    (raw) => window.browserPeersTest.relayConversationInspect(raw),
    { after, confirmed: true },
  );
async function approveRelayedOffer(
  page: import("@playwright/test").Page,
  f: Awaited<ReturnType<typeof ready>>,
  selection: any,
  after: any = null,
) {
  const status = await page.evaluate(() =>
    window.browserPeersTest.conversationStatus(),
  );
  const opened = await page.evaluate(
    (raw) => window.browserPeersTest.relayConversationOpen(raw),
    {
      ...f.route,
      expectedRevision: status.revision,
      after,
      selection,
      confirmed: true,
    },
  );
  const review = await page.evaluate(
    (raw) => window.browserPeersTest.conversationPrepare(raw),
    {
      ...f.route,
      expectedRevision: status.revision,
      envelope: opened.envelope,
      permissions: selected,
      expiresAt: Math.min(Date.now() + 60000, opened.opened.offer.expiresAt),
    },
  );
  return page.evaluate(
    (r) =>
      window.browserPeersTest.conversationApprove({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        confirmed: true,
        acknowledged: true,
      }),
    review,
  );
}
const acknowledgeOffer = (
  page: import("@playwright/test").Page,
  grant: any,
  selected?: any,
) =>
  page.evaluate(
    (raw) => window.browserPeersTest.relayConversationAcknowledge(raw),
    {
      grantId: grant.id,
      expectedRevision: grant.revision,
      confirmed: true,
      ...(selected ? { selected } : {}),
    },
  );
test("browser relay offer is independently reviewed before receipt acknowledgement and lost replies recover after reload", async ({
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
    const o = await relayOffer(f),
      queue = await inspectRelayOffer(page);
    expect(queue.item!.selection.messageId).toBe(o.envelope.header.messageId);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toHaveLength(0);
    const grant = await approveRelayedOffer(page, f, queue.item!.selection);
    expect(grant.choices.permissions).toEqual(selected);
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
    identityServer.loseResponse("/browser/relay/messages/acknowledge");
    await expect(
      acknowledgeOffer(page, grant, {
        after: null,
        selection: queue.item!.selection,
      }),
    ).rejects.toThrow();
    const uncertain = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(uncertain.grants[0]!.relayAcknowledgement!.attempts).toBe(1);
    expect(uncertain.grants[0]!.relayAcknowledgement!.observation).toBeNull();
    expect((await inspectRelayOffer(page)).item).toBeNull();
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const saved = await acknowledgeOffer(page, uncertain.grants[0]);
    expect(saved.transport.duplicate).toBe(true);
    expect(saved.transport.receipt.state).toBe("received");
    expect(saved.grant.approvedAt).toBe(grant.approvedAt);
    expect(saved.grant.choices).toEqual(grant.choices);
    expect(saved.grant.relayAcknowledgement!.observation!.attempt).toBe(2);
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});
test("browser relay offer selection changes and unauthenticated queue entries never acknowledge or grant access", async ({
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
    expect((await inspectRelayOffer(page)).item).toBeNull();
    const record = f.native.record(),
      bad = await f.mac.conversationOffer(record.permission!.expiresAt);
    bad.envelope.ciphertext =
      (bad.envelope.ciphertext[0] === "A" ? "B" : "A") +
      bad.envelope.ciphertext.slice(1);
    await f.native.relay.withTransport(
      { id: record.id, expectedRevision: record.revision },
      (client) => client.submit({ version: 1, envelope: bad.envelope }),
    );
    const rejected = await inspectRelayOffer(page),
      o = await relayOffer(f);
    await expect(
      approveRelayedOffer(page, f, rejected.item!.selection),
    ).rejects.toThrow("DENIED");
    const next = await inspectRelayOffer(page, rejected.item!.cursor);
    expect(next.item!.selection.messageId).toBe(o.envelope.header.messageId);
    await expect(
      approveRelayedOffer(page, f, next.item!.selection),
    ).rejects.toThrow("CONFLICT");
    const grant = await approveRelayedOffer(
      page,
      f,
      next.item!.selection,
      rejected.item!.cursor,
    );
    await acknowledgeOffer(page, grant, {
      after: rejected.item!.cursor,
      selection: next.item!.selection,
    });
    expect((await inspectRelayOffer(page)).item!.selection).toEqual(
      rejected.item!.selection,
    );
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});
test("revoked browser conversation consent cannot acknowledge a queued offer", async ({
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
    await relayOffer(f);
    const queue = await inspectRelayOffer(page),
      grant = await approveRelayedOffer(page, f, queue.item!.selection);
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRevoke(raw),
      { grantId: grant.id, expectedRevision: grant.revision, confirmed: true },
    );
    await expect(
      acknowledgeOffer(
        page,
        { ...grant, revision: grant.revision + 1 },
        { after: null, selection: queue.item!.selection },
      ),
    ).rejects.toThrow("DENIED");
    expect((await inspectRelayOffer(page)).item!.selection).toEqual(
      queue.item!.selection,
    );
    expect(
      identityServer.events.filter((p) => p.endsWith("messages/acknowledge")),
    ).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});
