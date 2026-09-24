import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PrivateRelayClient,
  type PrivateRelayClientContext,
} from "../modules/remote/private-relay-client.js";
const now = 1900000000000;
function fixture(kind: "browser" | "mac") {
  const identity = {
    version: 1 as const,
    scope: "private:relay" as const,
    ownerId: randomUUID(),
    endpointId: randomUUID(),
    endpointKind: kind,
    credentialEpoch: 3,
    permissionId: randomUUID(),
    expiresAt: now + 120000,
  };
  const context: PrivateRelayClientContext =
    kind === "mac"
      ? { kind, scope: "current", identity, credential: "S".repeat(43) }
      : { kind, scope: "current", identity };
  const recipient = {
    ...identity,
    endpointId: randomUUID(),
    endpointKind: kind === "browser" ? ("mac" as const) : ("browser" as const),
    credentialEpoch: 5,
    permissionId: randomUUID(),
    expiresAt: now + 60000,
  };
  return { context, recipient };
}
test("recipient readiness uses exact independent transport permission in both directions", async () => {
  for (const kind of ["browser", "mac"] as const) {
    const f = fixture(kind);
    let calls = 0;
    const client = new PrivateRelayClient(
      () => f.context,
      async (url, init) => {
        calls++;
        assert.equal(
          url,
          `https://ai.bittrees.org/${kind === "browser" ? "browser" : "device"}/relay/messages/recipient`,
        );
        assert.equal(
          new Headers(init?.headers).get("x-bittrees-relay-permission"),
          f.context.identity.permissionId,
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          endpointId: f.recipient.endpointId,
        });
        return Response.json(f.recipient);
      },
      () => now,
      () => 0,
    );
    assert.deepEqual(
      await client.recipient({ endpointId: f.recipient.endpointId }),
      f.recipient,
    );
    await assert.rejects(
      client.recipient({ endpointId: f.context.identity.endpointId }),
      /DENIED/,
    );
    await assert.rejects(
      client.recipient({
        endpointId: f.recipient.endpointId,
        credentialEpoch: 5,
      }),
      /INVALID_INPUT/,
    );
    assert.equal(calls, 1);
  }
});
test("recipient readiness rejects substituted owner, endpoint, kind, permission, expired and secret-bearing metadata", async () => {
  const f = fixture("browser");
  let raw: unknown;
  const client = new PrivateRelayClient(
    () => f.context,
    async () => Response.json(raw),
    () => now,
    () => 0,
  );
  for (const changed of [
    { ownerId: randomUUID() },
    { endpointId: randomUUID() },
    { endpointKind: "browser" },
    { permissionId: f.context.identity.permissionId },
    { expiresAt: now },
    { credential: "S".repeat(43) },
  ]) {
    raw = { ...f.recipient, ...changed };
    await assert.rejects(
      client.recipient({ endpointId: f.recipient.endpointId }),
      /INVALID_RESPONSE/,
    );
  }
});
test("readiness response cannot survive a changed sender permission or cancelled scope", async () => {
  for (const invalidate of [false, true]) {
    const f = fixture("browser");
    let finish!: (r: Response) => void;
    const client = new PrivateRelayClient(
      () => f.context,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      () => now,
      () => 0,
    );
    const pending = client.recipient({ endpointId: f.recipient.endpointId });
    if (invalidate) client.invalidate();
    else f.context.identity.permissionId = randomUUID();
    finish(Response.json(f.recipient));
    await assert.rejects(pending, /DENIED|UNAVAILABLE/);
  }
});
