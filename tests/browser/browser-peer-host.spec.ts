import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { retainedMac } from "./support/retained-mac.js";
import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
async function open(page: Page) {
  await page.goto("https://ai.bittrees.org/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
}
async function active(page: Page) {
  await open(page);
  const wallet = Wallet.createRandom();
  const challenge = await page.evaluate(
    (address) => window.browserPeersTest.challenge(address),
    wallet.address,
  );
  await page.evaluate(
    ({ message, signature }) =>
      window.browserPeersTest.login(message, signature),
    {
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
    },
  );
  const registration = await page.evaluate(
    (operationId) =>
      window.browserPeersTest.register({
        operationId,
        expected: null,
        confirmed: true,
      }),
    randomUUID(),
  );
  const proof = await page.evaluate(() =>
    window.browserPeersTest.hostActivate(),
  );
  const mac = await retainedMac(registration.binding, Date.now());
  return { registration, proof, mac };
}
async function review(page: Page, invitation: unknown) {
  return page.evaluate((i) => window.browserPeersTest.prepare(i), invitation);
}
async function approve(
  page: Page,
  r: { reviewId: string; expectedRevision: number; fingerprint: string },
) {
  return page.evaluate(
    (r) =>
      window.browserPeersTest.approve({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        comparedFingerprint: r.fingerprint,
        confirmed: true,
      }),
    r,
  );
}
test("Actual verified BrowserKeyHost exchanges retained Mac invitations and preserves reviewed pins across session reload", async ({
  page,
}) => {
  const { registration, proof, mac } = await active(page);
  try {
    const r = await review(page, (await mac.invitation()).invitation);
    const saved = await approve(page, r);
    const invitation = await page.evaluate(
      (id) =>
        window.browserPeersTest.invitation({
          recipientId: id,
          confirmed: true,
        }),
      mac.binding.deviceId,
    );
    expect(invitation.invitation.publicKey).toBe(proof.publicKey);
    expect(invitation.invitation.peerId).toBe(registration.binding.deviceId);
    const mr = await mac.peers.prepare(invitation.invitation);
    expect(mr.fingerprint).toBe(invitation.fingerprint);
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    const status = await page.evaluate(() => window.browserPeersTest.status());
    expect(status.revision).toBe(saved.revision);
    expect(status.state!.peers[0]!.fingerprint).toBe(r.fingerprint);
    expect(JSON.stringify(status)).not.toContain("privateHandle");
    expect(JSON.stringify(invitation)).not.toContain("privateKey");
  } finally {
    mac.close();
  }
});
test("Server revocation from another host denies a previously reviewed browser peer approval", async ({
  page,
  context,
}) => {
  const { registration, mac } = await active(page);
  try {
    const r = await review(page, (await mac.invitation()).invitation);
    const other = await context.newPage();
    await open(other);
    await other.evaluate(() => window.browserPeersTest.resume());
    await other.evaluate(
      (b) =>
        window.browserPeersTest.registerRevoke({
          deviceId: b.deviceId,
          credentialEpoch: b.credentialEpoch,
          confirmed: true,
        }),
      registration.binding,
    );
    await expect(approve(page, r)).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
  } finally {
    mac.close();
  }
});
test("Scope loss during held server verification prevents a delayed approval from publishing", async ({
  page,
  identityServer,
}) => {
  const { mac } = await active(page);
  try {
    const r = await review(page, (await mac.invitation()).invitation);
    identityServer.hold();
    const pending = approve(page, r).catch((e) => String(e));
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    identityServer.release();
    expect(await pending).toContain("DENIED");
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
  } finally {
    mac.close();
  }
});
test("Offline host maintenance revokes local peer trust without claiming a remote revocation", async ({
  page,
  identityServer,
}) => {
  const { mac } = await active(page);
  try {
    const r = await review(page, (await mac.invitation()).invitation),
      saved = await approve(page, r);
    identityServer.offline(true);
    await expect(
      review(page, (await mac.invitation()).invitation),
    ).rejects.toThrow();
    const result = await page.evaluate(
      (s) =>
        window.browserPeersTest.revoke({
          peerId: s.peerId,
          expectedRevision: s.revision,
          confirmed: true,
        }),
      saved,
    );
    expect(result).toMatchObject({
      revokedLocally: true,
      remoteRevocationConfirmed: false,
    });
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).state!
        .peers[0]!.revoked,
    ).toBe(true);
  } finally {
    identityServer.offline(false);
    mac.close();
  }
});

test("Scope loss after local commit rejects the response and refresh reveals the committed outcome without replay", async ({
  page,
}) => {
  const { mac } = await active(page);
  try {
    const r = await review(page, (await mac.invitation()).invitation);
    await page.evaluate(() => window.browserPeersTest.holdSecondIdentity());
    const pending = approve(page, r).catch((e) => String(e));
    await expect
      .poll(() => page.evaluate(() => window.browserPeersTest.held()))
      .toBe(true);
    await page.evaluate(() => {
      window.browserPeersTest.scopeChange();
      window.browserPeersTest.release();
    });
    expect(await pending).toContain("DENIED");
    await page.evaluate(() => window.browserPeersTest.resume());
    const status = await page.evaluate(() => window.browserPeersTest.status());
    expect(status.revision).toBe(r.expectedRevision + 1);
    expect(status.state!.peers[0]!.fingerprint).toBe(r.fingerprint);
    await expect(approve(page, r)).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(status.revision);
  } finally {
    mac.close();
  }
});

async function checkPair(page: Page) {
  const p = await active(page),
    r = await review(page, (await p.mac.invitation()).invitation),
    pin = await approve(page, r);
  const invitation = await page.evaluate(
      (id) =>
        window.browserPeersTest.invitation({
          recipientId: id,
          confirmed: true,
        }),
      p.mac.binding.deviceId,
    ),
    mr = await p.mac.peers.prepare(invitation.invitation);
  p.mac.peers.approve({
    reviewId: mr.reviewId,
    expectedRevision: mr.expectedRevision,
    comparedFingerprint: invitation.fingerprint,
    confirmed: true,
  });
  const start = await page.evaluate(
    (input) => window.browserPeersTest.checkBegin(input),
    {
      peerId: pin.peerId,
      expectedKeyRevision: p.proof.revision,
      expectedPeerRevision: pin.revision,
      confirmed: true,
    },
  );
  const challenge = await page.evaluate(
      (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
      start.id,
    ),
    response = await p.mac.checks.respond({
      envelope: challenge,
      confirmed: true,
    }),
    wire = p.mac.checks.delivery({ id: response.id, confirmed: true });
  return { ...p, pin, start, wire };
}
test("Verified host completes a real retained Mac exchange and requires fresh server authority after remote revoke", async ({
  page,
  context,
}) => {
  const p = await checkPair(page);
  try {
    const completed = await page.evaluate(
      (envelope) =>
        window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
      p.wire,
    );
    expect(completed.state).toBe("verified");
    const challenge = await p.mac.checks.begin({
        peerId: p.registration.binding.deviceId,
        expectedKeyRevision: p.mac.keys.list().revision,
        expectedPeerRevision: p.mac.peers.list().revision,
        confirmed: true,
      }),
      incoming = p.mac.checks.delivery({ id: challenge.id, confirmed: true });
    const response = await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
        incoming,
      ),
      outgoing = await page.evaluate(
        (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
        response.id,
      );
    await p.mac.checks.complete({ envelope: outgoing, confirmed: true });
    expect(
      p.mac.checks.validFor(
        (await p.mac.keys.resolve()).proof,
        (
          await p.mac.peers.resolve(
            p.registration.binding.deviceId,
            p.proof.keyEpoch,
          )
        ).proof,
      ),
    ).toBe(true);
    const other = await context.newPage();
    await open(other);
    await other.evaluate(() => window.browserPeersTest.resume());
    await other.evaluate(
      (b) =>
        window.browserPeersTest.registerRevoke({
          deviceId: b.deviceId,
          credentialEpoch: b.credentialEpoch,
          confirmed: true,
        }),
      p.registration.binding,
    );
    await other.close();
    await expect(
      page.evaluate(
        (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
        response.id,
      ),
    ).rejects.toThrow();
    const status = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    expect(status.checks.some((c) => c.state === "verified")).toBe(true);
    expect(status).not.toHaveProperty("taskPermission");
    expect(JSON.stringify(status)).not.toContain("preparation");
  } finally {
    p.mac.close();
  }
});
test("Lost verification after proof commit reports uncertainty; fresh status reveals the saved proof without repeating the check", async ({
  page,
  identityServer,
}) => {
  const p = await checkPair(page);
  try {
    identityServer.reject("/browser/registration/identity", 1);
    await expect(
      page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
        p.wire,
      ),
    ).rejects.toThrow();
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    const status = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    expect(status.checks).toHaveLength(1);
    expect(status.checks[0]).toMatchObject({
      id: p.start.id,
      state: "verified",
    });
    identityServer.offline(true);
    await expect(
      page.evaluate(
        (id) => window.browserPeersTest.checkResume({ id, confirmed: true }),
        p.start.id,
      ),
    ).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus()))
        .checks[0]!.state,
    ).toBe("verified");
  } finally {
    identityServer.offline(false);
    p.mac.close();
  }
});
