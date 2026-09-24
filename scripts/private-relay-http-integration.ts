import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { IncomingHttpHeaders } from "node:http";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
type Call = (
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: IncomingHttpHeaders; body: any }>;
export async function checkPrivateRelayHttp(call: Call, disabled: Call) {
  const browser = {
    Origin: "https://ai.bittrees.org",
    "X-Bittrees-Request": "1",
    "Sec-Fetch-Site": "same-origin",
  };
  const cookie = (r: Awaited<ReturnType<Call>>, name: string) =>
    r.headers["set-cookie"]!.find((c) => c.startsWith(name + "="))!.split(
      ";",
    )[0]!;
  async function fixture() {
    const wallet = Wallet.createRandom(),
      begun = await call(
        "/browser/login/challenge",
        { address: wallet.address },
        browser,
      );
    const verified = await call(
      "/browser/login/verify",
      {
        message: begun.body.message,
        signature: await wallet.signMessage(begun.body.message),
      },
      { ...browser, Cookie: cookie(begun, "__Host-bittrees-login") },
    );
    assert.equal(verified.status, 200);
    const session = cookie(verified, "__Host-bittrees-session"),
      ownerId = verified.body.ownerId;
    const owner: Record<string, string> & { Cookie: string } = {
      ...browser,
      Cookie: session,
      "X-Bittrees-Account": ownerId,
    };
    const registration = await call(
      "/browser/registration/create",
      { operationId: randomUUID(), expected: null, confirmed: true },
      owner,
    );
    assert.equal(registration.status, 200);
    owner.Cookie +=
      "; " + cookie(registration, "__Host-bittrees-browser-device");
    const verifier = randomBytes(32).toString("base64url"),
      pair = await call("/device/pairings", {
        challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
    assert.equal(
      (
        await call(
          "/browser/pairings/approve",
          {
            id: pair.body.id,
            approvalCode: pair.body.approvalCode,
            confirmed: true,
          },
          owner,
        )
      ).status,
      200,
    );
    const redeemed = await call("/device/redeem", {
      id: pair.body.id,
      verifier,
      expectedOwnerId: ownerId,
    });
    assert.equal(redeemed.status, 200);
    return {
      owner,
      ownerId,
      session,
      browserId: registration.body.binding.deviceId,
      mac: redeemed.body,
      status: { Authorization: "Bearer " + redeemed.body.credential },
    };
  }
  const f = await fixture(),
    other = await fixture(),
    request = () => ({
      operationId: randomUUID(),
      expected: null,
      expiresAt: Date.now() + 600000,
      confirmed: true,
    });
  const enabled = await call(
    "/browser/relay/permission/enable",
    request(),
    f.owner,
  );
  assert.equal(enabled.status, 200);
  f.owner["X-Bittrees-Relay-Permission"] = enabled.body.id;
  assert.equal(
    (await disabled("/browser/relay/permission/inspect", {}, f.owner)).status,
    404,
  );
  const approve = request(),
    pending = await call(
      "/browser/relay/mac/approve",
      { ...approve, deviceId: f.mac.deviceId, credentialEpoch: f.mac.epoch },
      f.owner,
    );
  assert.equal(pending.status, 200);
  assert.equal(
    (
      await call(
        "/browser/relay/permissions/operation",
        { operationId: approve.operationId },
        f.owner,
      )
    ).body.id,
    pending.body.id,
  );
  const reviewed = await call(
    "/device/relay/approval/inspect",
    { id: pending.body.id },
    f.status,
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.state, "pending");
  assert.equal(reviewed.body.endpointId, f.mac.deviceId);
  assert.equal(reviewed.body.credential, undefined);
  assert.equal(
    (
      await call(
        "/device/relay/approval/inspect",
        { id: pending.body.id },
        other.status,
      )
    ).status,
    403,
  );
  const accept = { id: pending.body.id, expectedRevision: 1, confirmed: true };
  assert.equal(
    (await call("/device/relay/permission/accept", accept, other.status))
      .status,
    403,
  );
  const native = await call(
    "/device/relay/permission/accept",
    accept,
    f.status,
  );
  assert.equal(native.status, 200);
  const relay = {
    Authorization: "Bearer " + native.body.credential,
    "X-Bittrees-Relay-Permission": native.body.grant.id,
  };
  assert.notEqual(native.body.credential, f.mac.credential);
  const reconciled = await call(
    "/device/relay/approval/inspect",
    { id: pending.body.id },
    f.status,
  );
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.state, "active");
  assert.equal(reconciled.body.credential, undefined);
  assert.equal(
    (
      await call(
        "/device/relay/approval/inspect",
        { id: pending.body.id },
        relay,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/device/relay/permission/accept", accept, f.status)).status,
    403,
  );
  assert.equal((await call("/device/identity", {}, relay)).status, 403);
  assert.equal(
    (await call("/device/relay/permission/inspect", {}, f.status)).status,
    403,
  );
  assert.equal(
    (await call("/device/relay/permission/inspect", {}, relay)).body.scope,
    "private:relay",
  );
  const key = () =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]),
    a = await key(),
    b = await key();
  const header = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: f.ownerId,
    senderId: f.browserId,
    recipientId: f.mac.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 300000,
  };
  const envelope = await sealPrivateEnvelope(
    header,
    new Uint8Array(65536).fill(29),
    { senderKey: a, recipientPublicKey: b.publicKey },
  );
  const message = { version: 1, envelope },
    submitPath = "/browser/relay/messages/submit",
    page = { after: null, limit: 20 };
  const sent = await call(submitPath, message, f.owner);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.duplicate, false);
  for (const permission of [
    randomUUID(),
    "",
    enabled.body.id + "," + enabled.body.id,
  ])
    assert.equal(
      (
        await call(submitPath, message, {
          ...f.owner,
          "X-Bittrees-Relay-Permission": permission,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await call("/device/relay/messages/poll", page, {
        ...relay,
        "X-Bittrees-Relay-Permission": enabled.body.id,
      })
    ).status,
    403,
  );
  assert.equal(sent.headers["cache-control"], "no-store");
  assert.equal(sent.headers["access-control-allow-origin"], undefined);
  assert.equal((await call(submitPath, message, f.owner)).body.duplicate, true);
  for (const headers of [
    { ...f.owner, Origin: "https://evil.invalid" },
    { ...f.owner, "X-Bittrees-Request": "0" },
    { ...f.owner, "Sec-Fetch-Site": "same-site" },
    { ...f.owner, Authorization: relay.Authorization },
    { ...f.owner, "X-Bittrees-Account": other.ownerId },
    { ...f.owner, Cookie: f.session },
    { ...f.owner, Cookie: f.owner.Cookie + "; " + f.session },
    {
      ...f.owner,
      Cookie: f.owner.Cookie + "; " + f.owner.Cookie.split("; ")[1],
    },
    {
      ...f.owner,
      Cookie: other.session + "; " + f.owner.Cookie.split("; ")[1],
    },
  ])
    assert.equal((await call(submitPath, message, headers)).status, 403);
  assert.equal(
    (await call(submitPath, { ...message, ownerId: other.ownerId }, f.owner))
      .status,
    400,
  );
  assert.equal(
    (await call(submitPath, '{"x":"' + "x".repeat(100000) + '"}', f.owner))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        "/browser/relay/messages/poll",
        '"' + "x".repeat(40000) + '"',
        f.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(submitPath, message, {
        ...f.owner,
        "Content-Encoding": "gzip",
      })
    ).status,
    400,
  );
  const polls = "/device/relay/messages/poll";
  for (const bad of [
    f.status,
    {},
    { ...relay, Origin: browser.Origin },
    { ...relay, Cookie: f.session },
    { ...relay, "Sec-Fetch-Site": "same-origin" },
  ])
    assert.equal((await call(polls, page, bad)).status, 403);
  const received = await call(polls, page, relay);
  assert.equal(received.status, 200);
  assert.equal(received.body.items.length, 1);
  const clear = await openPrivateEnvelope(
    received.body.items[0].envelope,
    header,
    { recipientKey: b, senderPublicKey: a.publicKey },
  );
  assert.equal(clear.plaintext.length, 65536);
  assert.ok(clear.plaintext.every((x) => x === 29));
  const receipt = sent.body.receipt,
    ack = {
      messageId: receipt.messageId,
      envelopeHash: receipt.envelopeHash,
      expectedRevision: 1,
      confirmed: true,
    };
  assert.equal(
    (
      await call(
        "/device/relay/messages/acknowledge",
        { ...ack, expectedRevision: 2 },
        relay,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call("/device/relay/messages/acknowledge", ack, relay)).body.receipt
      .state,
    "received",
  );
  assert.equal(
    (await call("/device/relay/messages/acknowledge", ack, relay)).body
      .duplicate,
    true,
  );
  assert.equal((await call(polls, page, relay)).body.items.length, 0);
  const reverse = {
    ...header,
    senderId: header.recipientId,
    recipientId: header.senderId,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 2,
  };
  const reply = {
    version: 1,
    envelope: await sealPrivateEnvelope(reverse, new Uint8Array([7]), {
      senderKey: b,
      recipientPublicKey: a.publicKey,
    }),
  };
  assert.equal(
    (await call("/device/relay/messages/submit", reply, relay)).status,
    200,
  );
  assert.equal(
    (await call("/browser/relay/messages/poll", page, f.owner)).body.items[0]
      .receipt.messageId,
    reverse.messageId,
  );
  const history = await call("/browser/relay/history/export", page, f.owner);
  assert.equal(history.status, 200);
  assert.equal(history.body.restoreAuthority, false);
  assert.equal(history.body.items.length, 2);
  assert.equal(
    (await call("/browser/relay/history/export", page, other.owner)).body.items
      .length,
    0,
  );
  assert.equal(
    (
      await call(
        "/browser/relay/history/delete",
        { messageId: receipt.messageId, expectedRevision: 2, confirmed: true },
        f.owner,
      )
    ).body.receipt.state,
    "deleted",
  );
  assert.equal(
    (
      await call(
        "/device/relay/messages/inspect",
        { messageId: receipt.messageId },
        relay,
      )
    ).body.state,
    "deleted",
  );
  // Replacing permission cannot silently authorize a previously prepared client.
  const replacement = await call(
    "/browser/relay/permission/enable",
    {
      ...request(),
      expected: { id: enabled.body.id, revision: enabled.body.revision },
    },
    f.owner,
  );
  assert.equal(replacement.status, 200);
  const staleMessage = {
    version: 1,
    envelope: await sealPrivateEnvelope(
      {
        ...header,
        messageId: randomUUID(),
        operationId: randomUUID(),
        sequence: 3,
      },
      new Uint8Array([8]),
      { senderKey: a, recipientPublicKey: b.publicKey },
    ),
  };
  assert.equal((await call(submitPath, staleMessage, f.owner)).status, 403);
  assert.equal(
    (await call("/browser/relay/history/export", page, f.owner)).body.items
      .length,
    2,
  );
  const list = await call(
    "/browser/relay/permissions/list",
    { after: null, limit: 20 },
    f.owner,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 3);
  assert.equal(
    JSON.stringify(list.body).includes(native.body.credential),
    false,
  );
  assert.equal(
    (
      await call(
        "/device/relay/permission/revoke",
        {
          id: native.body.grant.id,
          expectedRevision: native.body.grant.revision,
          confirmed: true,
        },
        relay,
      )
    ).status,
    200,
  );
  assert.equal((await call(polls, page, relay)).status, 403);
  assert.equal((await call("/device/identity", {}, f.status)).status, 200);
  assert.equal(
    (
      await call("/browser/relay/history/export", page, {
        ...f.owner,
        Cookie: f.session,
      })
    ).body.items.length,
    2,
  );
  assert.equal((await call("/browser/logout", {}, f.owner)).status, 200);
  assert.equal(
    (await call("/browser/relay/history/export", page, f.owner)).status,
    403,
  );
  console.log(
    "Private relay HTTPS: default-disabled routes, real SIWE/cookies and native opt-in, credential/CSRF separation, maximum encrypted payload, exact receipts, owner history/deletion and revocation passed.",
  );
}
