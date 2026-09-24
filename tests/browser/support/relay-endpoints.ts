import { expect, type Page } from "@playwright/test";
import { retainedMac } from "./retained-mac.js";
import { Wallet } from "ethers";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../../../modules/remote/devices.js";
const origin = "https://ai.bittrees.org";
export const payload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_TASK_THROUGH_REAL_RELAY",
};
const confirmed = (id: string) => ({ id, confirmed: true });
export async function ready(
  page: Page,
  pool: Pool,
  nativeTransport: typeof fetch,
  receiveResults = true,
) {
  await page.goto(origin + "/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
  const wallet = Wallet.createRandom(),
    challenge = await page.evaluate(
      (address) => window.browserPeersTest.challenge(address),
      wallet.address,
    );
  await page.evaluate(
    (p) => window.browserPeersTest.login(p.message, p.signature),
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
  await page.evaluate(() =>
    window.browserPeersTest.composeInitialize({
      expectedRevision: 0,
      confirmed: true,
    }),
  );
  const proof = await page.evaluate(() =>
    window.browserPeersTest.hostActivate(),
  );
  const devices = new RemoteDeviceStore(pool, 7200000),
    verifier = randomBytes(32).toString("base64url");
  const pairing = await devices.begin(
    createHash("sha256").update(verifier).digest("base64url"),
  );
  await devices.approve(
    registration.binding.ownerId,
    pairing.id,
    pairing.approvalCode,
  );
  const device = await devices.redeem(
    pairing.id,
    verifier,
    registration.binding.ownerId,
  );
  const mac = await retainedMac(registration.binding, Date.now(), {
    ownerId: registration.binding.ownerId,
    deviceId: device.deviceId,
    credentialEpoch: device.epoch,
    expiresAt: device.expiresAt,
  });
  try {
    const r = await page.evaluate(
      (i) => window.browserPeersTest.prepare(i),
      (await mac.invitation()).invitation,
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
    const c = await page.evaluate(
      (p) =>
        window.browserPeersTest.checkBegin({
          peerId: p.id,
          expectedKeyRevision: p.key,
          expectedPeerRevision: p.peer,
          confirmed: true,
        }),
      { id: pin.peerId, key: proof.revision, peer: pin.revision },
    );
    const wire = await page.evaluate(
      (c) => window.browserPeersTest.checkEnvelope(c),
      confirmed(c.id),
    );
    const reply = await mac.checks.respond({ envelope: wire, confirmed: true });
    await page.evaluate(
      (envelope) =>
        window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
      await mac.checks.delivery(confirmed(reply.id)),
    );
    const reverse = await mac.checks.begin({
      peerId: registration.binding.deviceId,
      expectedKeyRevision: mac.keys.list().revision,
      expectedPeerRevision: mac.peers.list().revision,
      confirmed: true,
    });
    const answered = await page.evaluate(
      (envelope) =>
        window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
      await mac.checks.delivery(confirmed(reverse.id)),
    );
    await mac.checks.complete({
      envelope: await page.evaluate(
        (c) => window.browserPeersTest.checkEnvelope(c),
        confirmed(answered.id),
      ),
      confirmed: true,
    });
    await mac.allowTasks(registration.binding.deviceId, proof.keyEpoch);
    const status = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    const review = await page.evaluate(
      (p) => window.browserPeersTest.consentPrepare(p),
      {
        expectedRevision: status.revision,
        choices: {
          peerId: pin.peerId,
          peerKeyEpoch: pin.keyEpoch,
          sendTasks: true,
          receiveResults,
          expiresAt: Date.now() + 300000,
        },
      },
    );
    await page.evaluate(
      (r) =>
        window.browserPeersTest.consentApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        }),
      review,
    );
    await page.evaluate((p) => window.browserPeersTest.relayEnable(p), {
      operationId: randomUUID(),
      expected: null,
      expiresAt: Date.now() + 240000,
      confirmed: true,
      deviceId: registration.binding.deviceId,
      credentialEpoch: registration.binding.credentialEpoch,
    });
    const approval = await page.evaluate(
      (p) => window.browserPeersTest.relayApprove(p),
      {
        operationId: randomUUID(),
        expected: null,
        expiresAt: Date.now() + 150000,
        confirmed: true,
        deviceId: device.deviceId,
        credentialEpoch: device.epoch,
      },
    );
    const native = await mac.connectRelay(device, nativeTransport, approval.id);
    const route = { peerId: pin.peerId, peerKeyEpoch: pin.keyEpoch };
    const prepared = await page.evaluate(
      (p) => window.browserPeersTest.relayPrepare(p),
      { ...route, payload },
    );
    expect(prepared.deliveryExpiresAt).toBe(
      native.record().permission!.expiresAt,
    );
    const entry = await page.evaluate(
      (reviewId) =>
        window.browserPeersTest.composeConfirm({
          reviewId,
          confirmed: true,
          acknowledged: true,
        }),
      prepared.reviewId,
    );
    expect(entry.header.expiresAt).toBe(native.record().permission!.expiresAt);
    return { mac, native, route, entry, registration, wallet };
  } catch (e) {
    mac.close();
    throw e;
  }
}
export async function send(page: Page, f: Awaited<ReturnType<typeof ready>>) {
  const history = await page.evaluate(() =>
    window.browserPeersTest.historyStatus(),
  );
  const current = history.entries.find((e) => e.id === f.entry.id)!;
  return page.evaluate((p) => window.browserPeersTest.relaySend(p), {
    ...f.route,
    id: current.id,
    expectedRevision: current.revision,
    confirmed: true,
  });
}
