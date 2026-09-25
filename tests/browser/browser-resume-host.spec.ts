import { expect } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
import { randomUUID } from "node:crypto";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
async function resumeOffer(f: Awaited<ReturnType<typeof ready>>) {
  const browser = f.mac.peers
    .list()
    .peers.find((p) => p.peerId === f.registration.binding.deviceId)!;
  const sender = await f.mac.keys.resolve(),
    peer = await f.mac.peers.resolve(browser.peerId, browser.keyEpoch);
  const now = Date.now();
  const data = {
    version: 1,
    type: "task.resume.offer",
    taskId: randomUUID(),
    permissionId: randomUUID(),
    taskRevision: 1,
    modelDigest: "a".repeat(64),
    issuedAt: now,
    expiresAt: now + 240000,
  };
  const envelope = await sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.registration.binding.ownerId,
      senderId: f.mac.binding.deviceId,
      recipientId: browser.peerId,
      senderKeyEpoch: sender.proof.keyEpoch,
      recipientKeyEpoch: browser.keyEpoch,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 10000,
      issuedAt: now,
      expiresAt: now + 240000,
    },
    new TextEncoder().encode(JSON.stringify(data)),
    { senderKey: sender.pair, recipientPublicKey: peer.publicKey },
  );
  return { data, envelope };
}
test("verified browser host independently inspects and saves an authenticated Mac resume offer, retaining choices after reload", async ({
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
    const o = await resumeOffer(f);
    const request = { ...f.route, expectedRevision: 0, envelope: o.envelope };
    const taskBefore = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    const opened = await page.evaluate(
      (raw) => window.browserPeersTest.resumeInspect(raw),
      request,
    );
    expect(opened.offer).toEqual(o.data);
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants,
    ).toHaveLength(0);
    const reviewed = await page.evaluate(
      (raw) => window.browserPeersTest.resumePrepare(raw),
      {
        ...request,
        expiresAt: Math.min(Date.now() + 60000, o.data.expiresAt),
      },
    );
    expect(reviewed.choices.modelDigest).toBe(o.data.modelDigest);
    const grant = await page.evaluate(
      (r) =>
        window.browserPeersTest.resumeApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        }),
      reviewed,
    );
    expect(grant.choices.taskId).toBe(o.data.taskId);
    expect(grant.choices.modelDigest).toBe(o.data.modelDigest);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(taskBefore);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retained = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    expect(retained.grants).toEqual([grant]);
    let identityCalls = 0;
    await page.route("**/browser/registration/identity", (route) => {
      identityCalls++;
      return route.abort("failed");
    });
    await page.evaluate((raw) => window.browserPeersTest.resumeRevoke(raw), {
      grantId: grant.id,
      expectedRevision: retained.revision,
      confirmed: true,
    });
    expect(identityCalls).toBe(0);
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants[0]!.revoked,
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("browser host cancellation and account changes invalidate resume reviews without widening task access", async ({
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
    const o = await resumeOffer(f);
    const raw = {
      ...f.route,
      expectedRevision: 0,
      envelope: o.envelope,
      expiresAt: Math.min(Date.now() + 60000, o.data.expiresAt),
    };
    const review = await page.evaluate(
      (raw) => window.browserPeersTest.resumePrepare(raw),
      raw,
    );
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.resumeApprove({
            reviewId: r.reviewId,
            expectedRevision: r.expectedRevision,
            confirmed: true,
            acknowledged: true,
          }),
        review,
      ),
    ).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants,
    ).toHaveLength(0);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await expect(
      page.evaluate((raw) => window.browserPeersTest.resumePrepare(raw), raw),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});
