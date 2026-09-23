import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { retainedMac } from "./support/retained-mac.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
const confirmed = (id: string) => ({ id, confirmed: true });
const make = () => ({
  owner: "synthetic:" + randomUUID(),
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
  now: Date.now(),
});
async function init(page: Page, f = make(), activate = true) {
  await page.goto("/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
  await page.evaluate(
    (f) => window.browserPeersTest.init(f.owner, f.binding, f.now),
    f,
  );
  if (activate) await page.evaluate(() => window.browserPeersTest.activate());
  return f;
}
async function paired(page: Page) {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now),
    invitation = await mac.invitation();
  const reviewed = await page.evaluate(
    (i) => window.browserPeersTest.prepare(i),
    invitation.invitation,
  );
  const pin = await page.evaluate(
    (r) =>
      window.browserPeersTest.approve({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        comparedFingerprint: r.fingerprint,
        confirmed: true,
      }),
    reviewed,
  );
  const browserInvitation = await page.evaluate(
    (id) =>
      window.browserPeersTest.invitation({ recipientId: id, confirmed: true }),
    mac.binding.deviceId,
  );
  const mr = await mac.peers.prepare(browserInvitation.invitation);
  mac.peers.approve({
    reviewId: mr.reviewId,
    expectedRevision: mr.expectedRevision,
    comparedFingerprint: browserInvitation.fingerprint,
    confirmed: true,
  });
  const local = (await page.evaluate(() => window.browserPeersTest.key()))
    .proof;
  const begin = () =>
    page.evaluate((input) => window.browserPeersTest.checkBegin(input), {
      peerId: pin.peerId,
      expectedKeyRevision: local.revision,
      expectedPeerRevision: pin.revision,
      confirmed: true,
    });
  const browserValid = () =>
    page.evaluate(
      (p) => window.browserPeersTest.checkValid(p.peerId, p.keyEpoch),
      pin,
    );
  const macBegin = () =>
    mac.checks.begin({
      peerId: f.binding.deviceId,
      expectedKeyRevision: mac.keys.list().revision,
      expectedPeerRevision: mac.peers.list().revision,
      confirmed: true,
    });
  const macValid = async () =>
    mac.checks.validFor(
      (await mac.keys.resolve()).proof,
      (await mac.peers.resolve(f.binding.deviceId, local.keyEpoch)).proof,
    );
  const reseal = async (
    wire: PrivateEnvelope,
    mutate: (value: any) => unknown,
  ) => {
    const local = await mac.keys.resolve(),
      peer = await mac.peers.resolve(
        f.binding.deviceId,
        wire.header.recipientKeyEpoch,
      ),
      decoded = await page.evaluate(
        ({ pin, wire }) =>
          window.browserPeersTest.open(
            pin.peerId,
            pin.keyEpoch,
            wire,
            wire.header,
          ),
        { pin, wire },
      );
    return sealPrivateEnvelope(
      wire.header,
      new TextEncoder().encode(JSON.stringify(mutate(JSON.parse(decoded)))),
      { senderKey: local.pair, recipientPublicKey: peer.publicKey },
      () => f.now,
    );
  };
  return {
    f,
    mac,
    pin,
    local,
    begin,
    browserValid,
    macBegin,
    macValid,
    reseal,
  };
}
async function browserEnvelope(page: Page, id: string) {
  return page.evaluate(
    (i) => window.browserPeersTest.checkEnvelope(i),
    confirmed(id),
  );
}
async function browserComplete(page: Page, envelope: PrivateEnvelope) {
  return page.evaluate(
    (envelope) =>
      window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
    envelope,
  );
}
async function browserRespond(page: Page, envelope: PrivateEnvelope) {
  return page.evaluate(
    (envelope) =>
      window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
    envelope,
  );
}
async function answer(page: Page, p: Awaited<ReturnType<typeof paired>>) {
  const start = await p.begin(),
    challenge = await browserEnvelope(page, start.id),
    response = await p.mac.checks.respond({
      envelope: challenge,
      confirmed: true,
    }),
    wire = p.mac.checks.delivery(confirmed(response.id));
  return { start, challenge, response, wire };
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("Both retained endpoints independently prove possession; encrypted preparations, exact replies and proof history survive reload", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    expect(await p.browserValid()).toBe(false);
    expect(await p.macValid()).toBe(false);
    const { start, challenge, wire } = await answer(page, p);
    expect(await p.macValid()).toBe(false);
    expect(await p.browserValid()).toBe(false);
    const opened = await openPrivateEnvelope(
      challenge,
      challenge.header,
      {
        recipientKey: (await p.mac.keys.resolve()).pair,
        senderPublicKey: (
          await p.mac.peers.resolve(p.f.binding.deviceId, p.local.keyEpoch)
        ).publicKey,
      },
      () => p.f.now,
    );
    const nonce = JSON.parse(
      new TextDecoder().decode(opened.plaintext),
    ).challenge;
    opened.plaintext.fill(0);
    const raw = await page.evaluate(() =>
      window.browserPeersTest.inspectChecks(),
    );
    expect(raw.json).not.toContain(nonce);
    expect(raw.privatePreparationExportDenied).toBe(true);
    await init(page, p.f, false);
    expect(await browserEnvelope(page, start.id)).toEqual(challenge);
    const done = await browserComplete(page, wire);
    expect(done.state).toBe("verified");
    expect(await browserComplete(page, wire)).toEqual(done);
    expect(await p.browserValid()).toBe(true);
    expect(await p.macValid()).toBe(false);
    const next = await p.macBegin(),
      incoming = p.mac.checks.delivery(confirmed(next.id)),
      response = await browserRespond(page, incoming),
      outgoing = await browserEnvelope(page, response.id);
    expect((await browserRespond(page, incoming)).id).toBe(response.id);
    expect(await browserEnvelope(page, response.id)).toEqual(outgoing);
    expect(outgoing.header.sequence).toBe(challenge.header.sequence + 1);
    await p.mac.checks.complete({ envelope: outgoing, confirmed: true });
    expect(await p.macValid()).toBe(true);
    expect(await p.browserValid()).toBe(true);
    await init(page, p.f, false);
    expect(await p.browserValid()).toBe(true);
    const status = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    expect(status.checks).toHaveLength(2);
    expect(JSON.stringify(status)).not.toContain(nonce);
    expect(status).not.toHaveProperty("taskPermission");
    expect(status).not.toHaveProperty("preparationKey");
  } finally {
    p.mac.close();
  }
});

test("Altered nonce/transcript/type, conflicting reseals and unconfirmed responses cannot complete a check", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    const { wire } = await answer(page, p);
    for (const mutate of [
      (v: any) => ({ ...v, challenge: "A".repeat(43) }),
      (v: any) => ({ ...v, requestHash: "a".repeat(64) }),
      () => ({
        version: 1,
        type: "task.submit",
        kind: "query",
        prompt: "not a proof",
      }),
    ]) {
      await expect(
        browserComplete(page, await p.reseal(wire, mutate)),
      ).rejects.toThrow();
      expect(await p.browserValid()).toBe(false);
    }
    await expect(
      page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: false }),
        wire,
      ),
    ).rejects.toThrow("DENIED");
    const done = await browserComplete(page, wire);
    await expect(
      browserComplete(page, await p.reseal(wire, (v) => v)),
    ).rejects.toThrow("CONFLICT");
    expect(await browserComplete(page, wire)).toEqual(done);
    await expect(browserRespond(page, wire)).rejects.toThrow("DENIED");
  } finally {
    p.mac.close();
  }
});

test("Failed ciphertext publication resumes the original encrypted preparation after reload", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    await page.evaluate(() => window.browserPeersTest.failCheckPublication());
    await expect(p.begin()).rejects.toThrow("CAPACITY");
    const before = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    expect(before.checks).toHaveLength(1);
    expect(before.checks[0]!.state).toBe("preparing");
    await expect(browserEnvelope(page, before.checks[0]!.id)).rejects.toThrow(
      "DENIED",
    );
    const raw = await page.evaluate(() =>
      window.browserPeersTest.inspectChecks(),
    );
    expect(raw.privatePreparationExportDenied).toBe(true);
    await init(page, p.f, false);
    const pending = await page.evaluate(
      (i) => window.browserPeersTest.checkResume(i),
      confirmed(before.checks[0]!.id),
    );
    expect(pending.id).toBe(before.checks[0]!.id);
    expect(pending.state).toBe("pending");
    const wire = await browserEnvelope(page, pending.id),
      reply = await p.mac.checks.respond({ envelope: wire, confirmed: true });
    await browserComplete(page, p.mac.checks.delivery(confirmed(reply.id)));
    expect(await p.browserValid()).toBe(true);
  } finally {
    p.mac.close();
  }
});

for (const action of [
  "peer-revoke",
  "key-revoke",
  "scope",
  "wall",
  "monotonic",
] as const)
  test(`Pending crypto cannot publish after ${action}`, async ({
    page,
    context,
  }) => {
    const p = await paired(page);
    const other = await context.newPage();
    try {
      await init(other, p.f, false);
      await page.evaluate(() => window.browserPeersTest.holdEncryption());
      const pending = p.begin().then(
        () => "unexpected",
        (e) => String(e),
      );
      await page.waitForFunction(() => window.browserPeersTest.held());
      if (action === "peer-revoke")
        await other.evaluate(
          (p) =>
            window.browserPeersTest.revoke({
              peerId: p.peerId,
              expectedRevision: p.revision,
              confirmed: true,
            }),
          p.pin,
        );
      else if (action === "key-revoke")
        await other.evaluate(
          (p) =>
            window.browserPeersTest.keyRevoke({
              keyId: p.keyId,
              expectedRevision: p.revision,
              confirmed: true,
            }),
          p.local,
        );
      else if (action === "scope")
        await page.evaluate(() => window.browserPeersTest.invalidate());
      else
        await page.evaluate(
          ({ now, mono }) => window.browserPeersTest.time(now, mono),
          {
            now: action === "wall" ? p.f.now - 1 : p.f.now,
            mono: action === "monotonic" ? 300001 : 0,
          },
        );
      await page.evaluate(() => window.browserPeersTest.release());
      expect(await pending).not.toBe("unexpected");
      const state = await other.evaluate(() =>
        window.browserPeersTest.checkStatus(),
      );
      expect(state.checks).toHaveLength(1);
      expect(state.checks[0]!.state).toBe("preparing");
    } finally {
      await other.close();
      p.mac.close();
    }
  });

test("Offline stop and deletion fence stale clients without rewinding shared sequence counters", async ({
  page,
  context,
}) => {
  const p = await paired(page),
    other = await context.newPage();
  try {
    const start = await p.begin();
    await init(other, p.f, false);
    await other.evaluate(() => window.browserPeersTest.set(null));
    const stopped = await other.evaluate(
      (s) =>
        window.browserPeersTest.checkStop({
          id: s.id,
          expectedRevision: s.revision,
          confirmed: true,
        }),
      start,
    );
    expect(stopped.state).toBe("stopped");
    await expect(browserEnvelope(page, start.id)).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (i) => window.browserPeersTest.checkResume(i),
        confirmed(start.id),
      ),
    ).rejects.toThrow("DENIED");
    const second = await p.begin();
    expect((await browserEnvelope(page, second.id)).header.sequence).toBe(2);
    const status = await other.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    await other.evaluate(
      (s) =>
        window.browserPeersTest.checkClear({
          expectedRevision: s.revision,
          confirmed: true,
        }),
      status,
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus())).checks,
    ).toHaveLength(0);
    await expect(p.begin()).rejects.toThrow("REPAIR_REQUIRED");
    const cleared = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    await expect(
      page.evaluate(
        (s) =>
          window.browserPeersTest.checkReset({
            expectedRevision: s.revision,
            confirmed: true,
          }),
        cleared,
      ),
    ).rejects.toThrow("REPAIR_REQUIRED");
    // Explicit fresh-device/key/peer setup is required to unlock deletion.
    const nextBinding = { ...p.f.binding, deviceId: randomUUID() };
    await init(page, { ...p.f, binding: nextBinding }, false);
    const keyStatus = await page.evaluate(() =>
      window.browserPeersTest.keyStatus(),
    );
    await page.evaluate(
      (revision) =>
        window.browserPeersTest.keyReset({
          expectedRevision: revision,
          confirmed: true,
        }),
      keyStatus.revision,
    );
    const nextKey = await page.evaluate(() =>
      window.browserPeersTest.activate(),
    );
    const peerStatus = await page.evaluate(() =>
      window.browserPeersTest.status(),
    );
    await page.evaluate(
      (revision) =>
        window.browserPeersTest.reset({
          expectedRevision: revision,
          confirmed: true,
        }),
      peerStatus.revision,
    );
    await p.mac.activate();
    const nextInvitation = await p.mac.invitation(nextBinding.deviceId),
      nextReview = await page.evaluate(
        (i) => window.browserPeersTest.prepare(i),
        nextInvitation.invitation,
      );
    const nextPin = await page.evaluate(
      (r) =>
        window.browserPeersTest.approve({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          comparedFingerprint: r.fingerprint,
          confirmed: true,
        }),
      nextReview,
    );
    await page.evaluate(
      (revision) =>
        window.browserPeersTest.checkReset({
          expectedRevision: revision,
          confirmed: true,
        }),
      cleared.revision,
    );
    const fresh = await page.evaluate(
      (input) => window.browserPeersTest.checkBegin(input),
      {
        peerId: nextPin.peerId,
        expectedKeyRevision: nextKey.revision,
        expectedPeerRevision: nextPin.revision,
        confirmed: true,
      },
    );
    expect(fresh.state).toBe("pending");
    expect(
      await page.evaluate(
        (p) => window.browserPeersTest.checkValid(p.peerId, p.keyEpoch),
        nextPin,
      ),
    ).toBe(false);
  } finally {
    await other.close();
    p.mac.close();
  }
});

test("Competing tabs consume one incoming operation and retain the first published response", async ({
  page,
  context,
}) => {
  const p = await paired(page),
    other = await context.newPage();
  try {
    await init(other, p.f, false);
    const start = await p.macBegin(),
      wire = p.mac.checks.delivery(confirmed(start.id));
    const results = await Promise.allSettled([
      browserRespond(page, wire),
      browserRespond(other, wire),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const status = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    expect(status.checks).toHaveLength(1);
    const first = await browserEnvelope(page, status.checks[0]!.id);
    expect((await browserRespond(other, wire)).id).toBe(status.checks[0]!.id);
    expect(await browserEnvelope(other, status.checks[0]!.id)).toEqual(first);
    expect(first.header.sequence).toBe(1);
    expect(await p.browserValid()).toBe(false);
    await p.mac.checks.complete({ envelope: first, confirmed: true });
    expect(await p.macValid()).toBe(true);
  } finally {
    await other.close();
    p.mac.close();
  }
});

test("Completed evidence survives exchange expiry but a changed peer revision immediately invalidates it", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    const { wire } = await answer(page, p);
    await browserComplete(page, wire);
    expect(await p.browserValid()).toBe(true);
    await page.evaluate(
      (n) => window.browserPeersTest.time(n, 0),
      p.f.now + 300001,
    );
    expect(await p.browserValid()).toBe(true);
    await page.evaluate(
      (p) =>
        window.browserPeersTest.revoke({
          peerId: p.peerId,
          expectedRevision: p.revision,
          confirmed: true,
        }),
      p.pin,
    );
    await expect(p.browserValid()).rejects.toThrow();
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus()))
        .checks[0]!.state,
    ).toBe("verified");
  } finally {
    p.mac.close();
  }
});

test("Failed completion rolls back the proof and exact retry reconciles the original response", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    const { wire } = await answer(page, p);
    await page.evaluate(() =>
      window.browserPeersTest.failCheckPublication("verified"),
    );
    await expect(browserComplete(page, wire)).rejects.toThrow("CAPACITY");
    expect(await p.browserValid()).toBe(false);
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus()))
        .checks[0]!.state,
    ).toBe("pending");
    await browserComplete(page, wire);
    expect(await p.browserValid()).toBe(true);
  } finally {
    p.mac.close();
  }
});

test("Wrong route, owner, key epoch and expired envelopes never create completion or responder records", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    const { wire } = await answer(page, p);
    const before = await page.evaluate(() =>
      window.browserPeersTest.checkStatus(),
    );
    for (const patch of [
      { ownerId: randomUUID() },
      { recipientId: randomUUID() },
      { senderKeyEpoch: wire.header.senderKeyEpoch + 1 },
      { recipientKeyEpoch: wire.header.recipientKeyEpoch + 1 },
      { issuedAt: p.f.now - 400000, expiresAt: p.f.now - 1 },
    ]) {
      const altered = { ...wire, header: { ...wire.header, ...patch } };
      await expect(browserComplete(page, altered)).rejects.toThrow();
      await expect(browserRespond(page, altered)).rejects.toThrow();
    }
    expect(
      await page.evaluate(() => window.browserPeersTest.checkStatus()),
    ).toEqual(before);
    expect(await p.browserValid()).toBe(false);
  } finally {
    p.mac.close();
  }
});

test("An orphaned proof cannot reconstruct its missing deletion marker or regain authority", async ({
  page,
}) => {
  const p = await paired(page);
  try {
    const { wire } = await answer(page, p);
    await browserComplete(page, wire);
    expect(await p.browserValid()).toBe(true);
    await page.evaluate(() => window.browserPeersTest.removeCheckMarker());
    expect(await p.browserValid()).toBe(false);
    await expect(p.begin()).rejects.toThrow("STORAGE_UNAVAILABLE");
    await expect(
      page.evaluate(() => window.browserPeersTest.checkStatus()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect(
      (await page.evaluate(() => window.browserPeersTest.key())).proof,
    ).toEqual(p.local);
    const raw = await page.evaluate(() =>
      window.browserPeersTest.inspectChecks(),
    );
    expect(raw.json).toContain("verified");
    expect(raw.json).not.toContain('"kind":"meta"');
  } finally {
    p.mac.close();
  }
});
