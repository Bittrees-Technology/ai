import { RemoteClient } from "../modules/remote/client.js";
import { PrivateRelayCustody } from "../modules/remote/private-relay-custody.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  PrivateRelayClient,
  PrivateRelayOwnerClient,
  BrowserRelayPermissionsClient,
} from "../modules/remote/private-relay-client.js";
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
      browserEpoch: registration.body.binding.credentialEpoch,
      mac: redeemed.body,
      status: { Authorization: "Bearer " + redeemed.body.credential },
    };
  }
  const transportFor =
    (owner: Record<string, string>): typeof fetch =>
    async (url, init) => {
      assert.equal(new URL(String(url)).origin, browser.Origin);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      assert.equal(headers.cookie, undefined);
      if (init?.credentials === "same-origin") {
        headers.origin = browser.Origin;
        headers["sec-fetch-site"] = "same-origin";
        headers.cookie = owner.Cookie!;
      } else {
        assert.equal(init?.credentials, "omit");
        assert.ok(headers.authorization);
      }
      const r = await call(
        new URL(String(url)).pathname,
        JSON.parse(String(init?.body)),
        headers,
      );
      return Response.json(r.body, { status: r.status });
    };
  const f = await fixture(),
    other = await fixture(),
    request = () => ({
      operationId: randomUUID(),
      expected: null,
      expiresAt: Date.now() + 600000,
      confirmed: true,
    });
  for (const identity of [
    { deviceId: other.browserId, credentialEpoch: f.browserEpoch },
    { deviceId: f.browserId, credentialEpoch: f.browserEpoch + 1 },
  ]) {
    assert.equal(
      (
        await call(
          "/browser/relay/permission/enable",
          { ...request(), ...identity },
          f.owner,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/browser/relay/permission/inspect", {}, f.owner)).body,
      null,
    );
  }
  assert.equal(
    (await call("/browser/relay/permission/enable", request(), f.owner)).status,
    400,
  );
  const permissions = new BrowserRelayPermissionsClient(
    () => ({ ownerId: f.ownerId, scope: "https-owner" }),
    transportFor(f.owner),
  );
  const browserLookup = {
    endpointKind: "browser",
    endpointId: f.browserId,
    credentialEpoch: f.browserEpoch,
  };
  const macLookup = {
    endpointKind: "mac",
    endpointId: f.mac.deviceId,
    credentialEpoch: f.mac.epoch,
  };
  assert.equal(
    (await permissions.inspectEndpoint(browserLookup)).permission,
    null,
  );
  assert.equal((await permissions.inspectEndpoint(macLookup)).permission, null);
  for (const lookup of [
    { ...macLookup, endpointId: other.mac.deviceId },
    { ...macLookup, credentialEpoch: f.mac.epoch + 1 },
    { ...browserLookup, endpointId: other.browserId },
  ])
    await assert.rejects(permissions.inspectEndpoint(lookup), /DENIED/);
  assert.equal(
    (await disabled("/browser/relay/permissions/endpoint", macLookup, f.owner))
      .status,
    404,
  );
  assert.equal(
    (
      await call("/browser/relay/permissions/endpoint", macLookup, {
        ...f.owner,
        "X-Bittrees-Account": other.ownerId,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/browser/relay/permissions/endpoint", macLookup, {
        ...f.owner,
        Origin: "https://other.invalid",
      })
    ).status,
    403,
  );
  const enabled = await call(
    "/browser/relay/permission/enable",
    { ...request(), deviceId: f.browserId, credentialEpoch: f.browserEpoch },
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
  assert.equal(
    (
      await call(
        "/browser/relay/messages/recipient",
        { endpointId: f.mac.deviceId },
        f.owner,
      )
    ).status,
    403,
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
  const actualTransport = transportFor(f.owner);
  const browserContext = {
    kind: "browser" as const,
    scope: "https-session",
    identity: {
      version: 1 as const,
      scope: "private:relay" as const,
      ownerId: f.ownerId,
      endpointId: f.browserId,
      endpointKind: "browser" as const,
      credentialEpoch: 1,
      permissionId: enabled.body.id,
      expiresAt: enabled.body.expiresAt,
    },
  };
  const macContext = {
    kind: "mac" as const,
    scope: "https-native",
    credential: native.body.credential,
    identity: {
      version: 1 as const,
      scope: "private:relay" as const,
      ownerId: f.ownerId,
      endpointId: f.mac.deviceId,
      endpointKind: "mac" as const,
      credentialEpoch: f.mac.epoch,
      permissionId: native.body.grant.id,
      expiresAt: native.body.grant.expiresAt,
    },
  };
  const browserClient = new PrivateRelayClient(
      () => browserContext,
      actualTransport,
    ),
    macClient = new PrivateRelayClient(() => macContext, actualTransport),
    historyClient = new PrivateRelayOwnerClient(
      () => ({ ownerId: f.ownerId, scope: "https-owner" }),
      actualTransport,
    );
  const recipient = await browserClient.recipient({
    endpointId: f.mac.deviceId,
  });
  assert.equal(recipient.permissionId, native.body.grant.id);
  assert.equal(recipient.credentialEpoch, f.mac.epoch);
  assert.equal(recipient.expiresAt, native.body.grant.expiresAt);
  assert.equal(
    (await macClient.recipient({ endpointId: f.browserId })).permissionId,
    enabled.body.id,
  );
  await assert.rejects(
    browserClient.recipient({ endpointId: other.mac.deviceId }),
    /DENIED/,
  );
  await assert.rejects(
    macClient.recipient({ endpointId: other.browserId }),
    /DENIED/,
  );
  assert.equal(
    (
      await disabled(
        "/browser/relay/messages/recipient",
        { endpointId: f.mac.deviceId },
        f.owner,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/browser/relay/messages/recipient",
        { endpointId: f.mac.deviceId },
        { ...f.owner, "X-Bittrees-Relay-Permission": randomUUID() },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/device/relay/messages/recipient",
        { endpointId: f.browserId },
        f.status,
      )
    ).status,
    403,
  );
  const wrongCredentialClient = new PrivateRelayClient(
    () => ({ ...macContext, credential: f.mac.credential }),
    actualTransport,
  );
  await assert.rejects(wrongCredentialClient.poll(page), /DENIED/);
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
  assert.equal((await browserClient.submit(message)).duplicate, true);
  const clientPoll = await macClient.poll(page);
  assert.deepEqual(clientPoll.items[0]!.envelope, envelope);
  assert.equal((await historyClient.export(page)).items.length, 1);
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
  assert.equal((await macClient.acknowledge(ack)).duplicate, true);
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
  assert.equal(
    (await browserClient.poll(page)).items[0]!.receipt.messageId,
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
  const observed = await permissions.inspectEndpoint(browserLookup);
  assert.equal(observed.permission?.id, enabled.body.id);
  assert.equal(
    (await permissions.inspectEndpoint(macLookup)).permission?.revision,
    native.body.grant.revision,
  );
  const replacement = await permissions.enableBrowser({
    ...request(),
    expected: {
      id: observed.permission!.id,
      revision: observed.permission!.revision,
    },
    deviceId: f.browserId,
    credentialEpoch: f.browserEpoch,
  });
  assert.equal(
    (await permissions.inspectOperation(replacement.operationId)).id,
    replacement.id,
  );
  assert.equal((await permissions.inspect(replacement.id)).state, "active");
  assert.equal(
    (
      await permissions.inspectBrowser({
        ownerId: f.ownerId,
        deviceId: f.browserId,
        credentialEpoch: f.browserEpoch,
        expiresAt: observed.endpoint.expiresAt,
      })
    )?.id,
    replacement.id,
  );
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
  await assert.rejects(browserClient.submit(staleMessage), /DENIED/);
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
  const currentBrowserClient = new PrivateRelayClient(
    () => ({
      ...browserContext,
      identity: {
        ...browserContext.identity,
        permissionId: replacement.id,
        expiresAt: replacement.expiresAt,
      },
    }),
    actualTransport,
  );
  assert.equal(
    (await currentBrowserClient.recipient({ endpointId: f.mac.deviceId }))
      .permissionId,
    native.body.grant.id,
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
  await assert.rejects(
    currentBrowserClient.recipient({ endpointId: f.mac.deviceId }),
    /DENIED/,
  );
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
  const ownerPage = await permissions.list({ after: null, limit: 2 });
  assert.equal(ownerPage.items.length, 2);
  assert.ok(ownerPage.nextCursor);
  assert.equal(
    (await permissions.list({ after: ownerPage.nextCursor, limit: 2 })).items
      .length,
    1,
  );
  const ownerRevoked = await permissions.revoke({
    id: replacement.id,
    expectedRevision: replacement.revision,
    confirmed: true,
  });
  assert.equal(ownerRevoked.state, "revoked");
  assert.equal(
    (await permissions.inspectEndpoint(browserLookup)).permission,
    null,
  );
  assert.equal((await call("/browser/logout", {}, f.owner)).status, 200);
  assert.equal(
    (await call("/browser/relay/history/export", page, f.owner)).status,
    403,
  );
  await assert.rejects(permissions.inspectEndpoint(macLookup), /DENIED/);
  // Actual native identity/enrollment and durable journal against the TLS host.
  // Synthetic in-memory secret slots exercise the OS-provider contract without Keychain access.
  const local = await fixture(),
    localOwner = { userId: "synthetic-native", tenantId: "personal" };
  const localPermissions = new BrowserRelayPermissionsClient(
    () => ({ ownerId: local.ownerId, scope: "https-native-owner" }),
    transportFor(local.owner),
  );
  const localApproval = {
    body: await localPermissions.approveMac({
      ...request(),
      deviceId: local.mac.deviceId,
      credentialEpoch: local.mac.epoch,
    }),
  };
  let saved = Buffer.from(
    JSON.stringify({
      localOwner: localOwner.userId,
      grant: local.mac,
      sequence: 1,
      mode: "active",
    }),
  );
  const statusSecret = {
    async getSecret() {
      return Uint8Array.from(saved);
    },
    async setSecret(value: Uint8Array) {
      saved = Buffer.from(value);
    },
    async deleteCredential() {
      return true;
    },
  };
  const slot = () => {
    let value: Uint8Array | undefined;
    return {
      async getSecret() {
        return value ? Uint8Array.from(value) : undefined;
      },
      async addSecretIfAbsent(input: Uint8Array) {
        if (value) return false;
        value = Uint8Array.from(input);
        return true;
      },
      async deleteCredential() {
        const found = !!value;
        value = undefined;
        return found;
      },
    };
  };
  const entries = new Map<
    string,
    {
      key: ReturnType<typeof slot>;
      attempt: ReturnType<typeof slot>;
      deleted: ReturnType<typeof slot>;
    }
  >();
  const provider = {
    forSlot(_owner: unknown, id: string) {
      let current = entries.get(id);
      if (!current) {
        current = { key: slot(), attempt: slot(), deleted: slot() };
        entries.set(id, current);
      }
      return current;
    },
  };
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  try {
    const remote = new RemoteClient(
      localOwner.userId,
      statusSecret,
      actualTransport,
    );
    const custody = new PrivateRelayCustody(
      store,
      vault,
      localOwner,
      provider,
      remote,
      actualTransport,
    );
    const review = await custody.review({ id: localApproval.body.id });
    const active = await custody.confirm({
      reviewId: review.reviewId,
      confirmed: true,
    });
    const reopened = new PrivateRelayCustody(
      store,
      vault,
      localOwner,
      provider,
      remote,
      actualTransport,
    );
    assert.deepEqual(
      await reopened.withClient(
        { id: active.id, expectedRevision: active.revision },
        (client) => client.poll(page),
      ),
      { items: [], nextCursor: null },
    );
    const revoked = await reopened.revoke({
      id: active.id,
      expectedRevision: active.revision,
      confirmed: true,
    });
    assert.equal(revoked.remoteRevocationConfirmed, true);
    assert.equal(
      (await call("/device/identity", {}, local.status)).status,
      200,
    );
    await assert.rejects(
      reopened.withClient(
        { id: active.id, expectedRevision: revoked.revision },
        (client) => client.poll(page),
      ),
      /DENIED/,
    );
    await reopened.remove({
      id: active.id,
      expectedRevision: revoked.revision,
      confirmed: true,
    });
    assert.equal(
      await provider.forSlot(localOwner, active.id).key.getSecret(),
      undefined,
    );
    assert.equal(reopened.list().items[0]!.phase, "deleted");
  } finally {
    store.close();
  }
  console.log(
    "Private relay native custody: actual TLS identity, one-use acceptance, separate synthetic OS slots, journal reopen, polling, revoke and cleanup passed.",
  );
  console.log(
    "Private relay recipient readiness: exact opposite endpoint and permission checks passed. Browser relay permissions: exact endpoint lookup, owner client approval/replacement, operation recovery, paged history and revoke passed.",
  );
  console.log(
    "Private relay HTTPS: default-disabled routes, real SIWE/cookies and native opt-in, credential/CSRF separation, maximum encrypted payload, exact receipts, owner history/deletion and revocation passed.",
  );
}
