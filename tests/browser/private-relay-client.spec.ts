import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { Wallet } from "ethers";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../../modules/remote/devices.js";
import { RemotePrivateRelayAccess } from "../../modules/remote/private-relay-access.js";
import { RemotePrivateRelayStore } from "../../modules/remote/private-relay-store.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
const origin = "https://ai.bittrees.org";
const policy = {
  version: 1,
  origin,
  chainId: 1,
  receivedContent: "until-deleted",
  unreceivedContent: { mode: "until-deleted" },
  operationalMetadataMs: 604800000,
  maxMessagesPerOwner: 100,
  maxBytesPerOwner: 1048576,
};
async function setup(page: Page, pool: Pool) {
  await page.goto(origin + "/?private-relay");
  await page.waitForFunction(() => !!window.privateRelayTest);
  const wallet = Wallet.createRandom(),
    challenge = await page.evaluate(
      (address) => window.privateRelayTest.challenge(address),
      wallet.address,
    );
  const browser = await page.evaluate(
    (p) => window.privateRelayTest.login(p.message, p.signature),
    {
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
    },
  );
  const devices = new RemoteDeviceStore(pool, 7200000),
    verifier = randomBytes(32).toString("base64url"),
    pair = await devices.begin(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  await devices.approve(browser.ownerId, pair.id, pair.approvalCode);
  const mac = await devices.redeem(pair.id, verifier, browser.ownerId);
  const pending = await page.evaluate(
    (p) => window.privateRelayTest.approve(p.deviceId, p.epoch),
    { deviceId: mac.deviceId, epoch: mac.epoch },
  );
  const access = new RemotePrivateRelayAccess(pool, origin, 1),
    native = await access.acceptMac(mac.credential, {
      id: pending.id,
      expectedRevision: 1,
      confirmed: true,
    });
  const store = new RemotePrivateRelayStore(
    pool,
    policy,
    Date.now,
    native.grant.id,
  );
  const key = () =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]),
    a = await key(),
    b = await key();
  let sequence = 0;
  const message = async (reverse = false) =>
    sealPrivateEnvelope(
      {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: browser.ownerId,
        senderId: reverse ? mac.deviceId : browser.binding.deviceId,
        recipientId: reverse ? browser.binding.deviceId : mac.deviceId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: 1,
        messageId: randomUUID(),
        operationId: randomUUID(),
        sequence: ++sequence,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
      },
      new Uint8Array(65536).fill(41),
      {
        senderKey: reverse ? b : a,
        recipientPublicKey: reverse ? a.publicKey : b.publicKey,
      },
    );
  return { browser, mac, native, store, message };
}
test("Actual browser relay client uses HttpOnly registration and exact permission for encrypted delivery, replies and owner history", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await setup(page, identityServer.pool),
    envelope = await f.message();
  const sent = await page.evaluate(
    (e) => window.privateRelayTest.submit(e),
    envelope,
  );
  expect(sent.duplicate).toBe(false);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(
    (await f.store.pollMac(f.native.credential, { after: null, limit: 20 }))
      .items[0]!.envelope,
  ).toEqual(envelope);
  expect(
    (await page.evaluate((e) => window.privateRelayTest.submit(e), envelope))
      .duplicate,
  ).toBe(true);
  const reply = await f.message(true),
    stored = await f.store.submitMac(f.native.credential, {
      version: 1,
      envelope: reply,
    });
  const received = await page.evaluate(() => window.privateRelayTest.poll());
  expect(received.items[0]!.envelope).toEqual(reply);
  const ack = await page.evaluate(
    (raw) => window.privateRelayTest.acknowledge(raw),
    {
      messageId: reply.header.messageId,
      envelopeHash: stored.receipt.envelopeHash,
      expectedRevision: 1,
      confirmed: true,
    },
  );
  expect(ack.receipt.state).toBe("received");
  expect(
    (await page.evaluate(() => window.privateRelayTest.export())).items,
  ).toHaveLength(2);
  await page.evaluate(
    (g) => window.privateRelayTest.replace(g.id, g.revision),
    f.browser.grant,
  );
  expect(
    await page.evaluate(
      async (e) => {
        try {
          await window.privateRelayTest.submit(e);
          return "accepted";
        } catch (e) {
          return (e as Error).message;
        }
      },
      await f.message(),
    ),
  ).toBe("DENIED");
  expect(
    (await page.evaluate(() => window.privateRelayTest.export())).items,
  ).toHaveLength(2);
});
test("Actual browser relay client aborts a held HTTPS response after local scope invalidation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await setup(page, identityServer.pool),
    envelope = await f.message();
  await page.evaluate((e) => window.privateRelayTest.submit(e), envelope);
  identityServer.hold("/browser/relay/messages/inspect");
  await page.evaluate(
    (id) => window.privateRelayTest.startInspect(id),
    envelope.header.messageId,
  );
  await expect.poll(() => identityServer.held()).toBe(true);
  await page.evaluate(() => window.privateRelayTest.invalidate());
  await expect
    .poll(() => page.evaluate(() => window.privateRelayTest.result()))
    .toMatch(/^(DENIED|UNAVAILABLE)$/);
  identityServer.release();
  expect(await page.evaluate(() => window.privateRelayTest.result())).not.toBe(
    "accepted",
  );
});
