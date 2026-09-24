import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserRelayTransport } from "../modules/remote/browser-relay-transport.js";
import type { PrivateRelayClient } from "../modules/remote/private-relay-client.js";
const wall = 1900000000000;
function fixture() {
  const ownerId = randomUUID(),
    deviceId = randomUUID();
  const scope = {
    ownerId,
    scope: "verified-current",
    binding: {
      ownerId,
      deviceId,
      credentialEpoch: 2,
      expiresAt: wall + 120000,
    },
  };
  const grant = {
    id: randomUUID(),
    ownerId,
    endpointId: deviceId,
    endpointKind: "browser",
    credentialEpoch: 2,
    operationId: randomUUID(),
    state: "active",
    revision: 1,
    createdAt: wall,
    expiresAt: wall + 60000,
    approvalExpiresAt: null,
    revokedAt: null,
  };
  return { scope, grant };
}
test("browser relay bridge accepts only a matching current grant and closes captured clients", async () => {
  const f = fixture();
  let captured!: PrivateRelayClient,
    calls = 0;
  const bridge = new BrowserRelayTransport(
    () => f.scope,
    async (url, init) => {
      calls++;
      assert.equal(
        url,
        "https://ai.bittrees.org/browser/relay/permission/inspect",
      );
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return Response.json(f.grant);
    },
    () => wall,
    () => 0,
  );
  const result = await bridge.withClient(async (client, identity) => {
    captured = client;
    assert.equal(identity.expiresAt, f.grant.expiresAt);
    assert.equal(identity.permissionId, f.grant.id);
    identity.permissionId = randomUUID();
    return "done";
  });
  assert.equal(result, "done");
  await assert.rejects(captured.poll({ after: null, limit: 1 }), /DENIED/);
  assert.equal(calls, 1);
});
test("browser relay bridge rejects missing, expired and wrong-registration grants before invoking sender", async () => {
  const f = fixture();
  let response: unknown;
  const bridge = new BrowserRelayTransport(
    () => f.scope,
    async () => Response.json(response),
    () => wall,
    () => 0,
  );
  for (const raw of [
    null,
    { ...f.grant, endpointId: randomUUID() },
    { ...f.grant, credentialEpoch: 1 },
    { ...f.grant, createdAt: wall - 1000, expiresAt: wall },
    { ...f.grant, state: "revoked", revokedAt: wall },
  ]) {
    response = raw;
    await assert.rejects(
      bridge.withClient(async () => {
        assert.fail("unverified sender invoked");
      }),
      /DENIED|INVALID_RESPONSE/,
    );
  }
});
test("browser relay bridge cancels permission inspection and rejects concurrent use or changed scope", async () => {
  const f = fixture();
  let resolve!: (r: Response) => void;
  const bridge = new BrowserRelayTransport(
    () => f.scope,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    () => wall,
    () => 0,
  );
  const pending = bridge.withClient(async () => {
    assert.fail("cancelled sender invoked");
  });
  await assert.rejects(
    bridge.withClient(async () => true),
    /BUSY/,
  );
  bridge.invalidate();
  resolve(Response.json(f.grant));
  await assert.rejects(pending, /DENIED|UNAVAILABLE/);
  const retry = bridge.withClient(async () => {
    assert.fail("changed sender invoked");
  });
  f.scope.scope = "new-session";
  resolve(Response.json(f.grant));
  await assert.rejects(retry, /DENIED|UNAVAILABLE/);
});
test("browser relay bridge enforces bounded current scope through callback completion", async () => {
  for (const mode of ["clock", "elapsed", "scope"] as const) {
    const f = fixture();
    let now = wall,
      mono = 0;
    const bridge = new BrowserRelayTransport(
      () => f.scope,
      async () => Response.json(f.grant),
      () => now,
      () => mono,
    );
    await assert.rejects(
      bridge.withClient(async () => {
        if (mode === "clock") now--;
        if (mode === "elapsed") mono = 30000;
        if (mode === "scope") f.scope.binding.credentialEpoch++;
        return "late";
      }),
      /DENIED/,
    );
  }
});
