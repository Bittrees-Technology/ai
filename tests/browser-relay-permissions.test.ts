import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserRelayPermissionsClient } from "../modules/remote/private-relay-client.js";
import type { PrivateRelayGrant } from "../modules/remote/private-relay-enrollment.js";

const time = 1900000000000;
function fixture(kind: "browser" | "mac" = "browser") {
  const ownerId = randomUUID(),
    deviceId = randomUUID();
  const request = {
    operationId: randomUUID(),
    expected: null,
    expiresAt: time + 600000,
    confirmed: true as const,
    deviceId,
    credentialEpoch: 2,
  };
  const grant: PrivateRelayGrant = {
    id: randomUUID(),
    ownerId,
    endpointKind: kind,
    endpointId: deviceId,
    credentialEpoch: 2,
    operationId: request.operationId,
    revision: 1,
    state: kind === "browser" ? "active" : "pending",
    createdAt: time,
    expiresAt: request.expiresAt,
    approvalExpiresAt: kind === "mac" ? time + 120000 : null,
    revokedAt: null,
  };
  const context = { ownerId, scope: "session-one" };
  const binding = {
    ownerId,
    deviceId,
    credentialEpoch: 2,
    expiresAt: time + 900000,
  };
  const endpoint = {
    ownerId,
    endpointKind: kind,
    endpointId: deviceId,
    credentialEpoch: 2,
    expiresAt: binding.expiresAt,
  };
  const lookup = {
    endpointKind: kind,
    endpointId: deviceId,
    credentialEpoch: 2,
  };
  return { ownerId, request, grant, context, binding, endpoint, lookup };
}

test("owner permission approvals bind endpoint, operation and expiry using cookies only", async () => {
  for (const kind of ["browser", "mac"] as const) {
    const f = fixture(kind);
    let calls = 0;
    const client = new BrowserRelayPermissionsClient(
      () => f.context,
      async (url, init) => {
        calls++;
        assert.equal(
          url,
          "https://ai.bittrees.org/browser/relay/" +
            (kind === "browser" ? "permission/enable" : "mac/approve"),
        );
        assert.equal(init?.method, "POST");
        assert.equal(init?.credentials, "same-origin");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.cache, "no-store");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("cookie"), null);
        assert.equal(headers.get("x-bittrees-account"), f.ownerId);
        assert.equal(headers.get("x-bittrees-request"), "1");
        assert.deepEqual(JSON.parse(String(init?.body)), f.request);
        return Response.json(f.grant);
      },
      () => time,
      () => 0,
    );
    const approve = () =>
      kind === "browser"
        ? client.enableBrowser(f.request)
        : client.approveMac(f.request);
    assert.deepEqual(await approve(), f.grant);
    assert.equal(calls, 1);
    assert.throws(
      () => client.enableBrowser({ ...f.request, confirmed: false }),
      /INVALID_INPUT/,
    );
    assert.throws(
      () => client.enableBrowser({ ...f.request, credential: "secret" }),
      /INVALID_INPUT/,
    );
    assert.equal(calls, 1);
  }
});

test("owner permission approval rejects substituted or secret-bearing responses", async () => {
  for (const kind of ["browser", "mac"] as const) {
    const f = fixture(kind);
    let response: unknown;
    const client = new BrowserRelayPermissionsClient(
      () => f.context,
      async () => Response.json(response),
      () => time,
      () => 0,
    );
    const changes = [
      { ownerId: randomUUID() },
      { endpointId: randomUUID() },
      { credentialEpoch: 3 },
      { operationId: randomUUID() },
      { expiresAt: f.request.expiresAt + 1 },
      { revision: 2 },
      { createdAt: time + 1 },
      { credential: "S".repeat(43) },
      { state: "revoked", revokedAt: time, approvalExpiresAt: null },
      ...(kind === "mac"
        ? [
            { approvalExpiresAt: time + 120001 },
            { state: "active", approvalExpiresAt: null },
          ]
        : []),
    ];
    for (const changed of changes) {
      response = { ...f.grant, ...changed };
      await assert.rejects(
        kind === "browser"
          ? client.enableBrowser(f.request)
          : client.approveMac(f.request),
        /INVALID_RESPONSE/,
      );
    }
    response = f.grant;
    await assert.rejects(
      client.approveMac({
        ...f.request,
        expected: { id: f.grant.id, revision: 1 },
      }),
      /INVALID_RESPONSE/,
    );
  }
});

test("endpoint review distinguishes exact current registration from a grant predating rotation", async () => {
  const f = fixture("mac");
  let response: unknown = { endpoint: f.endpoint, permission: null };
  const client = new BrowserRelayPermissionsClient(
    () => f.context,
    async (url, init) => {
      assert.match(String(url), /permissions\/endpoint$/);
      assert.deepEqual(JSON.parse(String(init?.body)), f.lookup);
      return Response.json(response);
    },
    () => time,
    () => 0,
  );
  assert.equal((await client.inspectEndpoint(f.lookup)).permission, null);
  response = {
    endpoint: f.endpoint,
    permission: { ...f.grant, credentialEpoch: 1 },
  };
  assert.equal(
    (await client.inspectEndpoint(f.lookup)).permission?.credentialEpoch,
    1,
  );
  for (const changed of [
    { ownerId: randomUUID() },
    { endpointId: randomUUID() },
    { credentialEpoch: 3 },
    { endpointKind: "browser" },
    { expiresAt: time },
  ]) {
    response = { endpoint: { ...f.endpoint, ...changed }, permission: null };
    await assert.rejects(
      client.inspectEndpoint(f.lookup),
      /INVALID_RESPONSE|DENIED/,
    );
  }
  for (const changed of [
    { ownerId: randomUUID() },
    { endpointId: randomUUID() },
    { state: "revoked", revokedAt: time, approvalExpiresAt: null },
  ]) {
    response = { endpoint: f.endpoint, permission: { ...f.grant, ...changed } };
    await assert.rejects(client.inspectEndpoint(f.lookup), /INVALID_RESPONSE/);
  }
});

test("current browser inspection rejects a replaced binding while retained owner history remains readable", async () => {
  const f = fixture();
  let response: unknown = f.grant;
  const client = new BrowserRelayPermissionsClient(
    () => f.context,
    async () => Response.json(response),
    () => time,
    () => 0,
  );
  assert.deepEqual(await client.inspectBrowser(f.binding), f.grant);
  await assert.rejects(
    client.inspectBrowser({ ...f.binding, ownerId: randomUUID() }),
    /DENIED/,
  );
  await assert.rejects(
    client.inspectBrowser({ ...f.binding, deviceId: randomUUID() }),
    /INVALID_RESPONSE/,
  );
  await assert.rejects(
    client.inspectBrowser({ ...f.binding, credentialEpoch: 3 }),
    /INVALID_RESPONSE/,
  );
  await assert.rejects(
    client.inspectBrowser({ ...f.binding, expiresAt: time }),
    /DENIED/,
  );
  response = null;
  assert.equal(await client.inspectBrowser(f.binding), null);
  const expired = {
    ...f.grant,
    createdAt: time - 1000,
    expiresAt: time - 1,
    revision: 2,
    state: "revoked",
    revokedAt: time - 2,
  };
  response = expired;
  assert.deepEqual(await client.inspect(f.grant.id), expired);
  await assert.rejects(client.inspect(randomUUID()), /INVALID_RESPONSE/);
  await assert.rejects(
    client.inspectOperation(randomUUID()),
    /INVALID_RESPONSE/,
  );
});

test("owner permission pages enforce bounds, owner isolation and exact nonrepeating cursors", async () => {
  const f = fixture();
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  const items = ids.slice(0, 2).map((id) => ({ ...f.grant, id }));
  let response: unknown = { items, nextCursor: ids[1] };
  const client = new BrowserRelayPermissionsClient(
    () => f.context,
    async () => Response.json(response),
    () => time,
    () => 0,
  );
  const page = { after: null, limit: 2 };
  assert.deepEqual((await client.list(page)).items, items);
  for (const malformed of [
    { items: [...items].reverse(), nextCursor: null },
    { items: [items[0], items[0]], nextCursor: null },
    { items, nextCursor: ids[2] },
    { items: [items[0]], nextCursor: ids[0] },
    { items: [...items, { ...f.grant, id: ids[2] }], nextCursor: null },
    { items: [{ ...items[0], ownerId: randomUUID() }], nextCursor: null },
  ]) {
    response = malformed;
    await assert.rejects(client.list(page), /INVALID_RESPONSE/);
  }
  response = { items, nextCursor: null };
  await assert.rejects(
    client.list({ ...page, after: ids[0] }),
    /INVALID_RESPONSE/,
  );
  assert.throws(() => client.list({ after: null, limit: 51 }), /INVALID_INPUT/);
});

test("lost approval replies require explicit operation lookup, never automatic retry", async () => {
  const f = fixture("mac");
  const paths: string[] = [];
  let response: unknown = f.grant;
  const client = new BrowserRelayPermissionsClient(
    () => f.context,
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith("mac/approve"))
        throw Error("lost response after commit");
      if (path.endsWith("operation"))
        assert.deepEqual(JSON.parse(String(init?.body)), {
          operationId: f.request.operationId,
        });
      return Response.json(response);
    },
    () => time,
    () => 0,
  );
  await assert.rejects(client.approveMac(f.request), /UNAVAILABLE/);
  assert.equal(paths.length, 1);
  assert.deepEqual(
    await client.inspectOperation(f.request.operationId),
    f.grant,
  );
  assert.equal(paths.filter((p) => p.endsWith("mac/approve")).length, 1);
  const revoke = { id: f.grant.id, expectedRevision: 1, confirmed: true };
  response = {
    ...f.grant,
    state: "revoked",
    revokedAt: time,
    approvalExpiresAt: null,
    revision: 2,
  };
  assert.equal((await client.revoke(revoke)).revision, 2);
  assert.equal(
    (await client.revoke({ ...revoke, expectedRevision: 2 })).revision,
    2,
  );
  response = {
    ...f.grant,
    state: "revoked",
    revokedAt: time,
    approvalExpiresAt: null,
    revision: 4,
  };
  await assert.rejects(client.revoke(revoke), /INVALID_RESPONSE/);
});

test("owner permission responses cannot outlive their account scope or explicit cancellation", async () => {
  for (const change of ["owner", "scope", "cancel"] as const) {
    const f = fixture();
    let context = f.context,
      finish!: (r: Response) => void;
    const client = new BrowserRelayPermissionsClient(
      () => context,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      () => time,
      () => 0,
    );
    const pending = client.inspect(f.grant.id);
    await assert.rejects(client.inspect(f.grant.id), /BUSY/);
    if (change === "owner") context = { ...context, ownerId: randomUUID() };
    else if (change === "scope") context = { ...context, scope: "session-two" };
    else client.invalidate();
    finish(Response.json(f.grant));
    await assert.rejects(pending, /DENIED|UNAVAILABLE/);
  }
});
