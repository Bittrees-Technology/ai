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
