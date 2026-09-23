import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RemoteClient } from "../modules/remote/client.js";
import type { VerifiedDeviceScope } from "../modules/remote/device-identity.js";
import { PrivateKeyLifecycle } from "../modules/remote/private-key-lifecycle.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";

function fixture() {
  let now = 1800000000000;
  let elapsed = 0;
  const grant = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  let bytes: Uint8Array | undefined;
  const secret = {
    async getSecret() {
      return bytes?.slice();
    },
    async setSecret(value: Uint8Array) {
      bytes = Uint8Array.from(value);
    },
    async deleteCredential() {
      bytes = undefined;
      return true;
    },
  };
  const expected = () => ({
    ownerId: grant.ownerId,
    deviceId: grant.deviceId,
    credentialEpoch: grant.epoch,
    expiresAt: grant.expiresAt,
  });
  const calls: { path: string; body: unknown }[] = [];
  let response: () => Promise<Response> = async () =>
    Response.json({ version: 1, ...expected() });
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    const path = String(url).replace("https://ai.bittrees.org/device/", "");
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    if (path === "pairings")
      return Response.json({
        id: randomUUID(),
        approvalCode: randomBytes(32).toString("base64url"),
        expiresAt: now + 300000,
      });
    if (path === "redeem") return Response.json(grant);
    assert.equal(path, "identity");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer " + grant.credential,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    return response();
  };
  const client = () =>
    new RemoteClient(
      "synthetic-local-owner",
      secret,
      transport,
      () => now,
      undefined,
      undefined,
      () => elapsed,
    );
  const c = client();
  return {
    c,
    client,
    calls,
    grant,
    expected,
    secret,
    now: () => now,
    time: (value: number) => {
      now = value;
    },
    elapsed: (value: number) => {
      elapsed = value;
    },
    respond: (fn: typeof response) => {
      response = fn;
    },
    async pair() {
      await c.begin();
      await c.finish(grant.ownerId);
    },
    async replaceCredential() {
      const saved = JSON.parse(Buffer.from(bytes!).toString());
      saved.grant.credential = randomBytes(32).toString("base64url");
      await secret.setSecret(Buffer.from(JSON.stringify(saved)));
    },
  };
}

test("Verified device scope is explicit, credential-matched, transient and never cached across restart", async () => {
  const f = fixture();
  let invoked = false;
  await assert.rejects(
    f.c.withVerifiedDevice(async () => {
      invoked = true;
    }),
    /PAIRING_REQUIRED/,
  );
  assert.equal(invoked, false);
  assert.equal(f.calls.length, 0);
  await f.pair();
  assert.equal(f.calls.length, 2);
  let captured!: VerifiedDeviceScope;
  assert.equal(
    await f.c.withVerifiedDevice(async (scope) => {
      captured = scope;
      assert.deepEqual(scope.current(), f.expected());
      const copy = scope.current()!;
      copy.ownerId = randomUUID();
      assert.deepEqual(scope.current(), f.expected());
      assert.ok(Object.isFrozen(scope));
      return "reviewed operation";
    }),
    "reviewed operation",
  );
  assert.equal(captured.current(), null);
  await f.client().withVerifiedDevice(async (scope) => {
    assert.deepEqual(scope.current(), f.expected());
    assert.equal(captured.current(), null);
  });
  assert.equal(f.calls.filter((c) => c.path === "identity").length, 2);
  f.respond(async () => Response.json({ error: "DENIED" }, { status: 403 }));
  await assert.rejects(
    f
      .client()
      .withVerifiedDevice(async () => assert.fail("revoked registration")),
    /DENIED/,
  );
  assert.equal(captured.current(), null);
});

test("Identity responses cannot substitute account, device, epoch, lease or arbitrary authority", async () => {
  for (const patch of [
    { ownerId: randomUUID() },
    { deviceId: randomUUID() },
    { credentialEpoch: 2 },
    { expiresAt: 1800007200000 },
    { version: 2 },
    { permissions: ["private:send"] },
    { credential: "secret" },
  ]) {
    const f = fixture();
    await f.pair();
    f.respond(async () =>
      Response.json({ version: 1, ...f.expected(), ...patch }),
    );
    await assert.rejects(
      f.c.withVerifiedDevice(async () => assert.fail("unverified scope")),
      /INVALID_RESPONSE/,
    );
  }
  const f = fixture();
  await f.pair();
  f.respond(async () => {
    throw Error("PRIVATE_NETWORK_CAUSE");
  });
  await assert.rejects(
    f.c.withVerifiedDevice(async () => assert.fail()),
    /^Error: UNAVAILABLE$/,
  );
  assert.equal(f.calls.filter((c) => c.path === "identity").length, 1);
});

test("Identity operation expires, rejects clock rollback and host invalidation, and suppresses late output", async () => {
  for (const mutation of [
    "deadline",
    "lease",
    "clock",
    "elapsed",
    "invalidate",
  ] as const) {
    const f = fixture();
    await f.pair();
    let captured!: VerifiedDeviceScope;
    await assert.rejects(
      f.c.withVerifiedDevice(async (scope) => {
        captured = scope;
        if (mutation === "deadline") f.time(f.now() + 30000);
        if (mutation === "lease") f.time(f.grant.expiresAt);
        if (mutation === "clock") f.time(f.now() - 1);
        if (mutation === "elapsed") f.elapsed(30000);
        if (mutation === "invalidate") f.c.invalidatePrivateIdentity();
        assert.equal(scope.current(), null);
        return "MUST_NOT_RETURN";
      }),
      /DENIED|PAIRING_REQUIRED/,
    );
    assert.equal(captured.current(), null);
  }
  for (const mutation of ["delay", "invalidate"] as const) {
    const f = fixture();
    await f.pair();
    f.respond(async () => {
      if (mutation === "delay") f.time(f.now() + 30000);
      else f.c.invalidatePrivateIdentity();
      return Response.json({ version: 1, ...f.expected() });
    });
    await assert.rejects(
      f.c.withVerifiedDevice(async () => assert.fail("late verification")),
      /DENIED/,
    );
  }
});

test("Credential changes before or during a verified operation prevent its output and leave no live scope", async () => {
  const first = fixture();
  await first.pair();
  first.respond(async () => {
    await first.replaceCredential();
    return Response.json({ version: 1, ...first.expected() });
  });
  await assert.rejects(
    first.c.withVerifiedDevice(async () => assert.fail()),
    /PAIRING_REQUIRED/,
  );
  const second = fixture();
  await second.pair();
  let scope!: VerifiedDeviceScope;
  await assert.rejects(
    second.c.withVerifiedDevice(async (current) => {
      scope = current;
      await second.replaceCredential();
      return "withheld";
    }),
    /PAIRING_REQUIRED/,
  );
  assert.equal(scope.current(), null);
});

test("Verified scopes exclude concurrent client mutation and close on callback failure without retry", async () => {
  const f = fixture();
  await f.pair();
  let scope!: VerifiedDeviceScope;
  await assert.rejects(
    f.c.withVerifiedDevice(async (current) => {
      scope = current;
      await assert.rejects(f.c.rotate(), /BUSY/);
      await assert.rejects(f.c.forgetLocal(), /BUSY/);
      await assert.rejects(
        f.c.withVerifiedDevice(async () => assert.fail()),
        /BUSY/,
      );
      assert.deepEqual(current.current(), f.expected());
      throw Error("synthetic host failure");
    }),
    /synthetic host failure/,
  );
  assert.equal(scope.current(), null);
  await f.c.withVerifiedDevice(async (next) =>
    assert.deepEqual(next.current(), f.expected()),
  );
  assert.equal(f.calls.filter((c) => c.path === "identity").length, 2);
});

test("Retained Mac keys use actual verified scopes for creation, reopen and public invitation; old scopes stay denied", async () => {
  const f = fixture();
  await f.pair();
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  const owner = { userId: "synthetic", tenantId: "personal" };
  const entry = () => {
    let bytes: Uint8Array | undefined;
    return {
      async getSecret() {
        return bytes?.slice();
      },
      async addSecretIfAbsent(value: Uint8Array) {
        if (bytes) return false;
        bytes = Uint8Array.from(value);
        return true;
      },
      async deleteCredential() {
        const found = !!bytes;
        bytes = undefined;
        return found;
      },
    };
  };
  const slots = new Map<
    string,
    {
      key: ReturnType<typeof entry>;
      attempt: ReturnType<typeof entry>;
      deleted: ReturnType<typeof entry>;
    }
  >();
  const entries = (id: string) => {
    if (!slots.has(id))
      slots.set(id, { key: entry(), attempt: entry(), deleted: entry() });
    return slots.get(id)!;
  };
  let previous!: PrivateKeyLifecycle;
  try {
    const original = await f.c.withVerifiedDevice(async (scope) => {
      const keys = new PrivateKeyLifecycle(
        store,
        vault,
        owner,
        scope.current,
        entries,
        undefined,
        f.now,
      );
      previous = keys;
      const reserved = keys.begin({ expectedRevision: 0, confirmed: true });
      return keys.provision({
        keyId: reserved.keyId,
        expectedRevision: reserved.revision,
        confirmed: true,
      });
    });
    await assert.rejects(previous.resolve(), /DENIED/);
    await f.client().withVerifiedDevice(async (scope) => {
      const keys = new PrivateKeyLifecycle(
        store,
        vault,
        owner,
        scope.current,
        entries,
        undefined,
        f.now,
      );
      const resolved = await keys.resolve();
      assert.equal(resolved.proof.publicKey, original.publicKey);
      assert.equal(resolved.pair.privateKey.extractable, false);
      assert.equal(keys.validate(resolved.proof), true);
      assert.equal(
        (await keys.invitation({ recipientId: randomUUID(), confirmed: true }))
          .invitation.publicKey,
        original.publicKey,
      );
      await assert.rejects(previous.resolve(), /DENIED/);
      f.c.invalidatePrivateIdentity(); // This is another client: its generation cannot grant or revoke this scope.
      assert.equal(keys.validate(resolved.proof), true);
    });
    f.respond(async () => Response.json({ error: "DENIED" }, { status: 403 }));
    await assert.rejects(
      f.c.withVerifiedDevice(async () => assert.fail()),
      /DENIED/,
    );
    assert.equal(store.exportPrivateEndpointKeys(owner).slots.length, 1);
    await previous.clearAll({ confirmed: true }); // Local key removal remains possible without remote identity.
    assert.equal(
      store.exportPrivateEndpointKeys(owner).pendingKeyDeletionCount,
      0,
    );
  } finally {
    store.close();
  }
});
