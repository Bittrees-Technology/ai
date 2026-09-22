import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import type { ConnectorSecret } from "../modules/connectors/crm.js";
class MemorySecret implements ConnectorSecret {
  bytes?: Uint8Array;
  fail = false;
  async getSecret() {
    return this.bytes;
  }
  async setSecret(value: Uint8Array) {
    if (this.fail) throw Error("secret store unavailable");
    this.bytes = Uint8Array.from(value);
  }
  async deleteCredential() {
    this.bytes = undefined;
    return true;
  }
}
function fixture() {
  const now = Date.now(),
    secret = new MemorySecret();
  const ownerId = randomUUID(),
    deviceId = randomUUID(),
    pairId = randomUUID();
  let failDelivery = false,
    failRotation = false,
    seq = 0;
  let grant = {
    ownerId,
    deviceId,
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  const calls: { path: string; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://ai.bittrees.org/device/"));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    const path = String(url).split("/device/")[1]!,
      body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === "pairings")
      return Response.json({
        id: pairId,
        approvalCode: randomBytes(32).toString("base64url"),
        expiresAt: now + 300000,
      });
    if (path === "redeem") return Response.json(grant);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer " + grant.credential,
    );
    if (path === "status") {
      const duplicate = seq === body.sequence;
      seq = body.sequence;
      if (failDelivery) {
        failDelivery = false;
        throw Error("response lost after acceptance");
      }
      return Response.json({ sequence: seq, duplicate });
    }
    if (path === "rotate") {
      grant = {
        ...grant,
        epoch: grant.epoch + 1,
        credential: randomBytes(32).toString("base64url"),
      };
      if (failRotation) throw Error("response lost after rotation");
      return Response.json(grant);
    }
    throw Error("unexpected route");
  };
  const client = () =>
    new RemoteClient("local-user", secret, fetcher, () => now);
  return {
    client,
    secret,
    calls,
    ownerId,
    deviceId,
    fetcher,
    now,
    loseDelivery: () => {
      failDelivery = true;
    },
    loseRotation: () => {
      failRotation = true;
    },
  };
}
function task() {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  const t = store.create(
    { userId: "local-user", tenantId: "personal" },
    {
      conversationId: "PRIVATE_CONVERSATION",
      kind: "draft",
      prompt: "PRIVATE_PROMPT",
      modelProfileId: "PRIVATE_MODEL",
      dependencies: [],
      priority: "normal",
      tags: ["PRIVATE_TAG"],
    },
    randomUUID(),
  );
  store.close();
  return t;
}
test("Remote client is opt-in, persists scoped credential and journals exact retry without private content", async () => {
  const f = fixture(),
    c = f.client();
  assert.equal(await c.status(), null);
  assert.equal(f.calls.length, 0);
  const p = await c.begin();
  assert.ok(p.approvalCode);
  assert.equal("verifier" in p, false);
  await c.finish(f.ownerId);
  assert.equal((await c.status())!.state, "paired");
  assert.equal(JSON.stringify(await c.status()).includes("credential"), false);
  const t = task();
  f.loseDelivery();
  await assert.rejects(c.publish([t]), /UNAVAILABLE/);
  assert.equal((await c.status())!.pendingDelivery, true);
  await assert.rejects(c.publish([t]), /PENDING_DELIVERY/);
  const resumed = f.client();
  assert.equal((await resumed.retryPending()).duplicate, true);
  const batches = f.calls.filter((x) => x.path === "status");
  assert.deepEqual(batches[0]!.body, batches[1]!.body);
  assert.equal(JSON.stringify(batches).includes("PRIVATE"), false);
  assert.equal(
    Buffer.from(f.secret.bytes!).toString().includes("PRIVATE"),
    false,
  );
  await resumed.publish([{ ...t, revision: 2 }]);
  assert.equal(f.calls.at(-1)!.body.sequence, 2);
  await resumed.rotate();
  await resumed.publish([{ ...t, revision: 3 }]);
  assert.equal(f.calls.at(-1)!.body.sequence, 3);
  const forgotten = await resumed.forgetLocal();
  assert.equal(forgotten.remoteRevocationConfirmed, false);
  assert.equal(await resumed.status(), null);
});
test("Interrupted rotation stays disabled across restart and cannot reuse old secret", async () => {
  const f = fixture(),
    c = f.client();
  await c.begin();
  await c.finish(f.ownerId);
  f.loseRotation();
  await assert.rejects(c.rotate(), /UNAVAILABLE/);
  const resumed = f.client();
  assert.equal((await resumed.status())!.state, "pairing_required");
  const before = f.calls.length;
  await assert.rejects(resumed.publish([task()]), /PAIRING_REQUIRED/);
  await assert.rejects(resumed.rotate(), /PAIRING_REQUIRED/);
  assert.equal(f.calls.length, before);
});
test("Owner mismatch and failed credential-store writes prevent publication", async () => {
  const f = fixture(),
    c = f.client();
  await c.begin();
  await c.finish(f.ownerId);
  const other = new RemoteClient(
    "another-user",
    f.secret,
    f.fetcher,
    () => f.now,
  );
  await assert.rejects(other.status(), /STORAGE_UNAVAILABLE/);
  const before = f.calls.length;
  f.secret.fail = true;
  await assert.rejects(c.publish([task()]), /STORAGE_UNAVAILABLE/);
  assert.equal(f.calls.length, before);
  await assert.rejects(c.rotate(), /STORAGE_UNAVAILABLE/);
});
test("Pairing rejects substituted owner, extra response fields and oversized responses", async () => {
  const f = fixture();
  let mode = "owner";
  const wrapped: typeof fetch = async (url, init) => {
    const response = await f.fetcher(url, init);
    if (String(url).endsWith("/redeem")) {
      const grant = await response.json();
      if (mode === "owner")
        return Response.json({ ...grant, ownerId: randomUUID() });
      if (mode === "extra")
        return Response.json({ ...grant, permissions: ["read_mail"] });
      return new Response("x".repeat(8193));
    }
    return response;
  };
  for (mode of ["owner", "extra", "large"]) {
    const client = new RemoteClient(
      "local-user",
      f.secret,
      wrapped,
      () => f.now,
    );
    await client.begin();
    await assert.rejects(client.finish(f.ownerId), /INVALID_RESPONSE/);
    assert.equal(f.secret.bytes, undefined);
  }
});

test("Remote storage capacity stays distinct from transient rate limiting and preserves pending delivery", async () => {
  const f = fixture();
  let code = "CAPACITY";
  const transport: typeof fetch = async (url, init) =>
    String(url).endsWith("/status")
      ? Response.json({ error: code }, { status: 429 })
      : f.fetcher(url, init);
  const client = new RemoteClient(
    "local-user",
    f.secret,
    transport,
    () => f.now,
  );
  await client.begin();
  await client.finish(f.ownerId);
  await assert.rejects(client.publish([]), /CAPACITY/);
  assert.equal((await client.status())?.pendingDelivery, true);
  code = "RATE_LIMITED";
  await assert.rejects(client.retryPending(), /UNAVAILABLE/);
  assert.equal((await client.status())?.pendingDelivery, true);
});
