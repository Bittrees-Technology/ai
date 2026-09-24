import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RemoteClient } from "../modules/remote/client.js";
import type {
  PrivateRelayEnrollmentScope,
  PrivateRelayGrant,
} from "../modules/remote/private-relay-enrollment.js";
function fixture() {
  const now = 1800000000000;
  const status = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  let stored = Buffer.from(
    JSON.stringify({
      localOwner: "synthetic",
      grant: status,
      sequence: 1,
      mode: "active",
    }),
  );
  const secret = {
    async getSecret() {
      return Uint8Array.from(stored);
    },
    async setSecret(v: Uint8Array) {
      stored = Buffer.from(v);
    },
    async deleteCredential() {
      return true;
    },
  };
  const credential = randomBytes(32).toString("base64url");
  let grant: PrivateRelayGrant = {
    id: randomUUID(),
    ownerId: status.ownerId,
    endpointId: status.deviceId,
    endpointKind: "mac",
    credentialEpoch: 1,
    revision: 1,
    state: "pending",
    operationId: randomUUID(),
    createdAt: now - 1,
    expiresAt: now + 1800000,
    approvalExpiresAt: now + 60000,
    revokedAt: null,
  };
  const calls: string[] = [];
  const control = {
    transform: undefined as undefined | ((body: any, path: string) => any),
    after: undefined as undefined | (() => void),
    mime: "application/json",
    redirected: false,
    url: undefined as undefined | string,
  };
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split("/device/")[1]!;
    calls.push(path);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(
      authorization,
      "Bearer " +
        (["relay/permission/inspect", "relay/permission/revoke"].includes(path)
          ? credential
          : status.credential),
    );
    let value: unknown;
    if (path === "identity")
      value = {
        version: 1,
        ownerId: status.ownerId,
        deviceId: status.deviceId,
        credentialEpoch: 1,
        expiresAt: status.expiresAt,
      };
    else if (path === "relay/approval/inspect") value = grant;
    else if (path === "relay/permission/accept") {
      assert.equal(grant.state, "pending");
      grant = {
        ...grant,
        state: "active",
        revision: 2,
        approvalExpiresAt: null,
      };
      value = { grant, credential, scope: "private:relay" };
    } else if (path === "relay/permission/inspect")
      value = {
        version: 1,
        scope: "private:relay",
        ownerId: status.ownerId,
        endpointId: status.deviceId,
        endpointKind: "mac",
        credentialEpoch: 1,
        permissionId: grant.id,
        expiresAt: grant.expiresAt,
      };
    else if (path === "relay/permission/revoke") {
      grant = { ...grant, state: "revoked", revision: 3, revokedAt: now };
      value = grant;
    } else throw Error("Unexpected route");
    if (path.startsWith("relay/")) {
      value = control.transform?.(structuredClone(value), path) ?? value;
      control.after?.();
    }
    const response = new Response(JSON.stringify(value), {
      headers: {
        "content-type": path === "identity" ? "application/json" : control.mime,
      },
    });
    Object.defineProperty(response, "url", {
      value: path === "identity" ? String(url) : (control.url ?? String(url)),
    });
    Object.defineProperty(response, "redirected", {
      value: path !== "identity" && control.redirected,
    });
    return response;
  };
  const client = new RemoteClient("synthetic", secret, transport, () => now);
  return {
    client,
    control,
    calls,
    credential,
    status,
    secret,
    grant: () => grant,
    rotate: () => {
      stored = Buffer.from(
        JSON.stringify({
          localOwner: "synthetic",
          grant: {
            ...status,
            credential: randomBytes(32).toString("base64url"),
            epoch: 2,
          },
          sequence: 1,
          mode: "active",
        }),
      );
    },
  };
}
test("Native enrollment keeps status and relay credentials separate and closes all escaped methods", async () => {
  const f = fixture();
  let escaped!: PrivateRelayEnrollmentScope;
  await f.client.withPrivateRelayEnrollment(async (scope) => {
    escaped = scope;
    const g = await scope.inspect(f.grant().id);
    const accepted = await scope.accept({
      id: g.id,
      expectedRevision: g.revision,
      confirmed: true,
    });
    await assert.rejects(
      scope.accept({ id: g.id, expectedRevision: g.revision, confirmed: true }),
      /DENIED/,
    );
    assert.equal(accepted.credential, f.credential);
    await assert.rejects(scope.identifyRelay(f.status.credential), /DENIED/);
    const identity = await scope.identifyRelay(accepted.credential);
    assert.equal(identity.permissionId, g.id);
    assert.equal(
      (
        await scope.revokeRelay(accepted.credential, {
          id: g.id,
          expectedRevision: 2,
          confirmed: true,
        })
      ).state,
      "revoked",
    );
  });
  assert.equal(escaped.current(), null);
  const count = f.calls.length;
  await assert.rejects(escaped.inspect(f.grant().id), /DENIED/);
  assert.equal(f.calls.length, count);
  assert.ok(
    !Buffer.from((await f.secret.getSecret())!)
      .toString()
      .includes(f.credential),
  );
});
test("Native enrollment rejects wrong identity, permission and one-use secret projections", async () => {
  for (const patch of [
    { ownerId: randomUUID() },
    { endpointId: randomUUID() },
    { credentialEpoch: 2 },
    { id: randomUUID() },
  ]) {
    const f = fixture();
    f.control.transform = (value) => ({ ...value, ...patch });
    await assert.rejects(
      f.client.withPrivateRelayEnrollment((scope) =>
        scope.inspect(f.grant().id),
      ),
      /INVALID_RESPONSE/,
    );
  }
  const f = fixture();
  f.control.transform = (value, path) =>
    path.endsWith("accept")
      ? { ...value, credential: f.status.credential }
      : value;
  await assert.rejects(
    f.client.withPrivateRelayEnrollment((scope) =>
      scope.accept({ id: f.grant().id, expectedRevision: 1, confirmed: true }),
    ),
    /INVALID_RESPONSE/,
  );
});
test("Native enrollment fences identity invalidation and separate-client credential rotation during a response", async () => {
  for (const rotate of [false, true]) {
    const f = fixture();
    f.control.after = () =>
      rotate ? f.rotate() : f.client.invalidatePrivateIdentity();
    await assert.rejects(
      f.client.withPrivateRelayEnrollment((scope) =>
        scope.inspect(f.grant().id),
      ),
      /DENIED/,
    );
    assert.equal(f.calls.filter((p) => p.startsWith("relay/")).length, 1);
  }
});
test("Native enrollment rejects redirected, wrong-origin and non-JSON responses", async () => {
  for (const patch of [
    { redirected: true },
    { url: "https://other.invalid/device/relay/approval/inspect" },
    { mime: "text/html" },
  ]) {
    const f = fixture();
    Object.assign(f.control, patch);
    await assert.rejects(
      f.client.withPrivateRelayEnrollment((scope) =>
        scope.inspect(f.grant().id),
      ),
      /INVALID_RESPONSE/,
    );
  }
});
