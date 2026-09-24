import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { retainedMac } from "./support/retained-mac.js";
import { Wallet } from "ethers";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../../modules/remote/devices.js";
import { RemotePrivateRelayAccess } from "../../modules/remote/private-relay-access.js";
import { RemotePrivateRelayStore } from "../../modules/remote/private-relay-store.js";
const origin = "https://ai.bittrees.org";
const payload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_TASK_THROUGH_REAL_RELAY",
};
const confirmed = (id: string) => ({ id, confirmed: true });
async function ready(page: Page, pool: Pool) {
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
          receiveResults: true,
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
    const native = await new RemotePrivateRelayAccess(
      pool,
      origin,
      1,
    ).acceptMac(device.credential, {
      id: approval.id,
      expectedRevision: approval.revision,
      confirmed: true,
    });
    const store = new RemotePrivateRelayStore(
      pool,
      {
        version: 1,
        origin,
        chainId: 1,
        receivedContent: "until-deleted",
        unreceivedContent: { mode: "until-deleted" },
        operationalMetadataMs: 604800000,
        maxMessagesPerOwner: 100,
        maxBytesPerOwner: 1048576,
      },
      Date.now,
      native.grant.id,
    );
    const route = { peerId: pin.peerId, peerKeyEpoch: pin.keyEpoch };
    const prepared = await page.evaluate(
      (p) => window.browserPeersTest.relayPrepare(p),
      { ...route, payload },
    );
    expect(prepared.deliveryExpiresAt).toBe(native.grant.expiresAt);
    const entry = await page.evaluate(
      (reviewId) =>
        window.browserPeersTest.composeConfirm({
          reviewId,
          confirmed: true,
          acknowledged: true,
        }),
      prepared.reviewId,
    );
    expect(entry.header.expiresAt).toBe(native.grant.expiresAt);
    return { mac, native, store, route, entry, registration };
  } catch (e) {
    mac.close();
    throw e;
  }
}
async function send(page: Page, f: Awaited<ReturnType<typeof ready>>) {
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
test("verified browser host relays retained ciphertext and reopens without duplicating a locally admitted task", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(page, identityServer.pool);
  try {
    const sent = await send(page, f);
    expect(sent.transportOnly).toBe(true);
    expect(sent.receipt.state).toBe("stored");
    expect(sent.duplicate).toBe(false);
    const received = await f.store.pollMac(f.native.credential, {
      after: null,
      limit: 20,
    });
    expect(received.items).toHaveLength(1);
    expect(received.items[0]!.envelope).toEqual(f.entry.envelope);
    const admitted = await f.mac.executeTask(received.items[0]!.envelope);
    expect(admitted.task!.input.prompt).toBe(payload.prompt);
    expect(
      (await page.evaluate(() => window.browserPeersTest.historyStatus()))
        .entries[0]!.state,
    ).toBe("pending");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    const retry = await send(page, f);
    expect(retry.duplicate).toBe(true);
    expect(retry.receipt).toEqual(sent.receipt);
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
  const f = await ready(page, identityServer.pool);
  try {
    identityServer.drop("/browser/relay/messages/submit");
    await expect(send(page, f)).rejects.toThrow();
    const retried = await send(page, f);
    expect(retried.duplicate).toBe(true);
    const received = await f.store.pollMac(f.native.credential, {
      after: null,
      limit: 20,
    });
    expect(received.items).toHaveLength(1);
    expect(received.items[0]!.envelope).toEqual(f.entry.envelope);
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
  const f = await ready(page, identityServer.pool);
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
    expect(
      (await f.store.pollMac(f.native.credential, { after: null, limit: 20 }))
        .items,
    ).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});
