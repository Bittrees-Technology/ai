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

async function consentReview(page: Page) {
  const p = await checkPair(page);
  await page.evaluate(
    (envelope) =>
      window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
    p.wire,
  );
  const review = await page.evaluate(
    (choices) =>
      window.browserPeersTest.consentPrepare({ expectedRevision: 0, choices }),
    {
      peerId: p.pin.peerId,
      peerKeyEpoch: p.pin.keyEpoch,
      sendTasks: true,
      receiveResults: true,
      expiresAt: Date.now() + 240000,
    },
  );
  return { ...p, review };
}
const approveConsent = (
  page: Page,
  r: { reviewId: string; expectedRevision: number },
) =>
  page.evaluate(
    (r) =>
      window.browserPeersTest.consentApprove({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        confirmed: true,
        acknowledged: true,
      }),
    r,
  );
test("verified host saves retained consent and supports offline local revocation", async ({
  page,
  identityServer,
}) => {
  const p = await consentReview(page);
  try {
    const grant = await approveConsent(page, p.review);
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .grants,
    ).toEqual([grant]);
    identityServer.offline(true);
    await expect(
      page.evaluate(
        (c) =>
          window.browserPeersTest.consentPrepare({
            expectedRevision: 1,
            choices: c,
          }),
        p.review.choices,
      ),
    ).rejects.toThrow();
    await page.evaluate((r) => window.browserPeersTest.consentRevoke(r), {
      peerId: p.pin.peerId,
      expectedRevision: 1,
      confirmed: true,
    });
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .grants[0]!.revoked,
    ).toBe(true);
  } finally {
    identityServer.offline(false);
    p.mac.close();
  }
});
test("server device revocation prevents a previously reviewed permission from committing", async ({
  page,
  context,
}) => {
  const p = await consentReview(page),
    other = await context.newPage();
  try {
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
    await expect(approveConsent(page, p.review)).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .revision,
    ).toBe(0);
  } finally {
    await other.close();
    p.mac.close();
  }
});
test("lost final server verification leaves inspectable committed consent and refuses approval replay", async ({
  page,
  identityServer,
}) => {
  const p = await consentReview(page);
  try {
    identityServer.reject("/browser/registration/identity", 1);
    await expect(approveConsent(page, p.review)).rejects.toThrow();
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    const state = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    expect(state.revision).toBe(1);
    expect(state.grants[0]!.choices).toEqual(p.review.choices);
    await expect(approveConsent(page, p.review)).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .revision,
    ).toBe(1);
  } finally {
    p.mac.close();
  }
});

const composedPayload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_HOST_DURABLE_TASK",
};
async function taskHostReady(page: Page) {
  const p = await consentReview(page);
  try {
    const check = await p.mac.checks.begin({
      peerId: p.registration.binding.deviceId,
      expectedKeyRevision: p.mac.keys.list().revision,
      expectedPeerRevision: p.mac.peers.list().revision,
      confirmed: true,
    });
    const wire = await p.mac.checks.delivery({ id: check.id, confirmed: true });
    const response = await page.evaluate(
      (envelope) =>
        window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
      wire,
    );
    const reply = await page.evaluate(
      (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
      response.id,
    );
    await p.mac.checks.complete({ envelope: reply, confirmed: true });
    await p.mac.allowTasks(p.registration.binding.deviceId, p.proof.keyEpoch);
    const r = await page.evaluate(
      (choices) =>
        window.browserPeersTest.consentPrepare({
          expectedRevision: 0,
          choices,
        }),
      p.review.choices,
    );
    await approveConsent(page, r);
    return {
      ...p,
      route: { peerId: p.pin.peerId, peerKeyEpoch: p.pin.keyEpoch },
    };
  } catch (e) {
    p.mac.close();
    throw e;
  }
}
const initializeTasks = (
  page: Page,
  p: Awaited<ReturnType<typeof taskHostReady>>,
) =>
  page.evaluate((raw) => window.browserPeersTest.composeInitialize(raw), {
    ...p.route,
    expectedRevision: 0,
    confirmed: true,
  });
const reviewTask = (page: Page, p: Awaited<ReturnType<typeof taskHostReady>>) =>
  page.evaluate((raw) => window.browserPeersTest.composePrepare(raw), {
    ...p.route,
    payload: composedPayload,
  });
const confirmTask = (page: Page, reviewId: string) =>
  page.evaluate(
    (reviewId) =>
      window.browserPeersTest.composeConfirm({
        reviewId,
        confirmed: true,
        acknowledged: true,
      }),
    reviewId,
  );

test("verified task host requires explicit initialization and carries reviewed input through the actual Mac worker and result", async ({
  page,
}) => {
  const p = await taskHostReady(page);
  try {
    await expect(reviewTask(page, p)).rejects.toThrow("SETUP_REQUIRED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus())).meta,
    ).toBeNull();
    await initializeTasks(page, p);
    const review = await reviewTask(page, p),
      saved = await confirmTask(page, review.reviewId);
    expect(saved.id).toBe(review.operationId);
    expect(JSON.stringify(saved)).not.toMatch(
      /privateKey|preparationKey|SYNTHETIC_HOST_DURABLE_TASK/,
    );
    const wire = await page.evaluate(
      (raw) => window.browserPeersTest.composeEnvelope(raw),
      {
        ...p.route,
        id: saved.id,
        expectedRevision: saved.revision,
        confirmed: true,
      },
    );
    const result = await p.mac.executeTask(wire);
    expect(result.task!.input.prompt).toBe(composedPayload.prompt);
    await page.evaluate((raw) => window.browserPeersTest.composeReceive(raw), {
      ...p.route,
      kind: "receipt",
      envelope: result.acceptance,
      confirmed: true,
    });
    const received = await page.evaluate(
      (raw) => window.browserPeersTest.composeReceive(raw),
      { ...p.route, kind: "result", envelope: result.result, confirmed: true },
    );
    const output = await page.evaluate(
      (raw) => window.browserPeersTest.composeReadResult(raw),
      {
        ...p.route,
        id: saved.id,
        expectedRevision: received.revision,
        confirmed: true,
      },
    );
    expect(output.task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    await expect(confirmTask(page, review.reviewId)).rejects.toThrow(
      "CONFLICT",
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries,
    ).toHaveLength(1);
  } finally {
    p.mac.close();
  }
});

test("lost final task verification reconciles one saved operation after reload without replaying confirmation", async ({
  page,
  identityServer,
}) => {
  const p = await taskHostReady(page);
  try {
    await initializeTasks(page, p);
    const review = await reviewTask(page, p);
    identityServer.reject("/browser/registration/identity", 1);
    await expect(confirmTask(page, review.reviewId)).rejects.toThrow();
    const status = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]!.id).toBe(review.operationId);
    expect(status.entries[0]!.state).toBe("pending");
    const before = await page.evaluate(
      (r) =>
        window.browserPeersTest.historyExport({
          expectedRevision: r,
          confirmed: true,
        }),
      status.meta!.revision,
    );
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    const recovered = await page.evaluate(
      (raw) => window.browserPeersTest.composeResume(raw),
      {
        ...p.route,
        id: review.operationId,
        expectedRevision: 1,
        confirmed: true,
      },
    );
    expect(recovered.envelope).toEqual(before.entries[0]!.envelope);
    await expect(confirmTask(page, review.reviewId)).rejects.toThrow(
      "CONFLICT",
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus())).meta,
    ).toEqual(status.meta);
  } finally {
    p.mac.close();
  }
});

test("server revocation after task review denies confirmation before reservation", async ({
  page,
  context,
}) => {
  const p = await taskHostReady(page),
    other = await context.newPage();
  try {
    await initializeTasks(page, p);
    const review = await reviewTask(page, p);
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
    await expect(confirmTask(page, review.reviewId)).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries,
    ).toEqual([]);
  } finally {
    await other.close();
    p.mac.close();
  }
});

test("offline host can export its own reviewed input, stop retries and delete history after permission revocation", async ({
  page,
  identityServer,
}) => {
  const p = await taskHostReady(page);
  try {
    await initializeTasks(page, p);
    const saved = await confirmTask(page, (await reviewTask(page, p)).reviewId);
    const consent = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    await page.evaluate((raw) => window.browserPeersTest.consentRevoke(raw), {
      peerId: p.pin.peerId,
      expectedRevision: consent.revision,
      confirmed: true,
    });
    identityServer.offline(true);
    const status = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    const exported = await page.evaluate(
      (r) =>
        window.browserPeersTest.historyExport({
          expectedRevision: r,
          confirmed: true,
        }),
      status.meta!.revision,
    );
    expect(exported.entries[0]!.input).toEqual(composedPayload);
    expect(JSON.stringify(exported)).not.toMatch(
      /preparationKey|privateKey|"key":/,
    );
    await expect(
      page.evaluate((raw) => window.browserPeersTest.composeResume(raw), {
        ...p.route,
        id: saved.id,
        expectedRevision: saved.revision,
        confirmed: true,
      }),
    ).rejects.toThrow();
    await page.evaluate((raw) => window.browserPeersTest.historyStop(raw), {
      id: saved.id,
      expectedRevision: saved.revision,
      confirmed: true,
    });
    const stopped = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    await page.evaluate(
      (r) =>
        window.browserPeersTest.historyClear({
          expectedRevision: r,
          confirmed: true,
        }),
      stopped.meta!.revision,
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries,
    ).toEqual([]);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await expect(
      page.evaluate(() => window.browserPeersTest.historyStatus()),
    ).rejects.toThrow("DENIED");
  } finally {
    identityServer.offline(false);
    p.mac.close();
  }
});

test("scope loss during held task verification cannot restore a consumed content review", async ({
  page,
  identityServer,
}) => {
  const p = await taskHostReady(page);
  try {
    await initializeTasks(page, p);
    const review = await reviewTask(page, p);
    identityServer.hold();
    const pending = confirmTask(page, review.reviewId).then(
      (value) => ({ value }),
      (e) => ({ error: String(e) }),
    );
    await expect.poll(() => identityServer.held()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    identityServer.release();
    expect(await pending).toMatchObject({
      error: expect.stringMatching(/DENIED/),
    });
    await open(page);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries,
    ).toEqual([]);
    await expect(confirmTask(page, review.reviewId)).rejects.toThrow(
      "CONFLICT",
    );
  } finally {
    identityServer.release();
    p.mac.close();
  }
});
