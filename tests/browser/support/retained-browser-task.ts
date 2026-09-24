import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { retainedMac } from "./retained-mac.js";
export const payload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_RETAINED_BROWSER_TASK",
};
const confirmed = (id: string) => ({ id, confirmed: true });
export async function init(
  page: Page,
  previous: boolean | "task" | "delivery" = false,
) {
  const f = {
    owner: "synthetic:" + randomUUID(),
    binding: {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: Date.now() + 3600000,
    },
    now: Date.now(),
  };
  await reopen(page, f, previous);
  await page.evaluate(() => window.browserPeersTest.activate());
  return f;
}
export async function reopen(
  page: Page,
  f: { owner: string; binding: any; now: number },
  previous: boolean | "task" | "delivery" = false,
) {
  await page.goto("/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
  await page.evaluate(
    ({ f, previous }) =>
      window.browserPeersTest.init(f.owner, f.binding, f.now, previous),
    { f, previous },
  );
}
export async function paired(
  page: Page,
  previous: boolean | "task" | "delivery" = false,
) {
  const f = await init(page, previous),
    mac = await retainedMac(f.binding, f.now);
  try {
    const i = await mac.invitation();
    const r = await page.evaluate(
      (i) => window.browserPeersTest.prepare(i),
      i.invitation,
    );
    const pin = await page.evaluate(
      (r) =>
        window.browserPeersTest.approve({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          comparedFingerprint: r.fingerprint,
          confirmed: true,
        }),
      r,
    );
    const outgoing = await page.evaluate(
      (id) =>
        window.browserPeersTest.invitation({
          recipientId: id,
          confirmed: true,
        }),
      mac.binding.deviceId,
    );
    const mr = await mac.peers.prepare(outgoing.invitation);
    mac.peers.approve({
      reviewId: mr.reviewId,
      expectedRevision: mr.expectedRevision,
      comparedFingerprint: outgoing.fingerprint,
      confirmed: true,
    });
    const local = (await page.evaluate(() => window.browserPeersTest.key()))
      .proof;
    const proveBrowser = async () => {
      const c = await page.evaluate(
        (p) =>
          window.browserPeersTest.checkBegin({
            peerId: p.id,
            expectedKeyRevision: p.key,
            expectedPeerRevision: p.peer,
            confirmed: true,
          }),
        { id: pin.peerId, key: local.revision, peer: pin.revision },
      );
      const wire = await page.evaluate(
        (c) => window.browserPeersTest.checkEnvelope(c),
        confirmed(c.id),
      );
      const a = await mac.checks.respond({ envelope: wire, confirmed: true });
      const reply = await mac.checks.delivery(confirmed(a.id));
      await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
        reply,
      );
    };
    const proveMac = async () => {
      const c = await mac.checks.begin({
        peerId: f.binding.deviceId,
        expectedKeyRevision: mac.keys.list().revision,
        expectedPeerRevision: mac.peers.list().revision,
        confirmed: true,
      });
      const wire = await mac.checks.delivery(confirmed(c.id));
      const a = await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
        wire,
      );
      const reply = await page.evaluate(
        (c) => window.browserPeersTest.checkEnvelope(c),
        confirmed(a.id),
      );
      await mac.checks.complete({ envelope: reply, confirmed: true });
    };
    const choices = {
      peerId: pin.peerId,
      peerKeyEpoch: pin.keyEpoch,
      sendTasks: true,
      receiveResults: true,
      expiresAt: f.now + 300000,
    };
    const prepare = async (override = {}) => {
      const state = await page.evaluate(() =>
        window.browserPeersTest.consentStatus(),
      );
      return page.evaluate(
        (input) => window.browserPeersTest.consentPrepare(input),
        {
          expectedRevision: state.revision,
          choices: { ...choices, ...override },
        },
      );
    };
    const approve = (r: Awaited<ReturnType<typeof prepare>>) =>
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
    const authorize = () =>
      page.evaluate(
        (p) => window.browserPeersTest.authorize(p.peerId, p.keyEpoch),
        pin,
      );
    return {
      f,
      mac,
      pin,
      local,
      proveBrowser,
      proveMac,
      prepare,
      approve,
      authorize,
    };
  } catch (e) {
    mac.close();
    throw e;
  }
}
export async function ready(
  page: Page,
  previous: boolean | "task" | "delivery" = false,
) {
  const f = await paired(page, previous);
  try {
    await f.proveBrowser();
    await f.proveMac();
    await f.mac.allowTasks(f.f.binding.deviceId, f.local.keyEpoch);
    await f.approve(await f.prepare());
    await f.authorize();
    await page.evaluate(() =>
      window.browserPeersTest.taskInitialize({
        expectedRevision: 0,
        confirmed: true,
      }),
    );
    return f;
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
