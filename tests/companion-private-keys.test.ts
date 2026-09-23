import { PrivateKeyLifecycle } from "../modules/remote/private-key-lifecycle.js";
import { inspectPrivateInvitation } from "../modules/remote/private-peer-contracts.js";
import { PrivatePeerPanelState } from "../apps/dashboard/private-peer-state.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CompanionPrivateKeys } from "../apps/companion/private-keys.js";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { dashboardServer } from "../apps/companion/dashboard-server.js";
import { PrivateKeyPanelState } from "../apps/dashboard/private-key-state.js";
class Slot {
  bytes?: Uint8Array;
  failDelete = false;
  afterGet?: () => Promise<void>;
  afterAdd?: () => Promise<void>;
  async getSecret() {
    await this.afterGet?.();
    return this.bytes?.slice();
  }
  async addSecretIfAbsent(value: Uint8Array) {
    if (this.bytes) return false;
    this.bytes = Uint8Array.from(value);
    await this.afterAdd?.();
    return true;
  }
  async deleteCredential() {
    if (this.failDelete) throw Error("PRIVATE_NATIVE_ERROR");
    const found = !!this.bytes;
    this.bytes = undefined;
    return found;
  }
}
async function fixture() {
  let now = 1800000000000,
    denied = false,
    calls = 0,
    saved: Uint8Array | undefined;
  const owner = { userId: "synthetic", tenantId: "personal" },
    vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  const grant = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  const remote = new RemoteClient(
    "synthetic",
    {
      async getSecret() {
        return saved?.slice();
      },
      async setSecret(b) {
        saved = Uint8Array.from(b);
      },
      async deleteCredential() {
        saved = undefined;
        return true;
      },
    },
    async (url) => {
      calls++;
      const path = String(url).split("/device/")[1];
      if (path === "pairings")
        return Response.json({
          id: randomUUID(),
          approvalCode: randomBytes(32).toString("base64url"),
          expiresAt: now + 300000,
        });
      if (path === "redeem") return Response.json(grant);
      assert.equal(path, "identity");
      return denied
        ? Response.json({ error: "DENIED" }, { status: 403 })
        : Response.json({
            version: 1,
            ownerId: grant.ownerId,
            deviceId: grant.deviceId,
            credentialEpoch: grant.epoch,
            expiresAt: grant.expiresAt,
          });
    },
    () => now,
  );
  await remote.begin();
  await remote.finish(grant.ownerId);
  calls = 0;
  const slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  let afterAdd: (() => Promise<void>) | undefined;
  const entries = (id: string) => {
    if (!slots.has(id)) {
      const key = new Slot();
      key.afterAdd = () => afterAdd?.() ?? Promise.resolve();
      slots.set(id, { key, attempt: new Slot(), deleted: new Slot() });
    }
    return slots.get(id)!;
  };
  const build = (online = true, enabled = true) =>
    new CompanionPrivateKeys(
      store,
      vault,
      owner,
      entries,
      online ? remote : undefined,
      enabled,
      () => now,
    );
  const controls = build();
  const prepare = (action: string, keyId?: string, c = controls) =>
    c.prepare({
      action,
      expectedRevision: c.status().state.revision,
      ...(keyId ? { keyId } : {}),
    });
  const confirm = (id: string, c = controls) =>
    c.confirm({ reviewId: id, confirmed: true, acknowledged: true });
  return {
    store,
    vault,
    owner,
    controls,
    build,
    entries,
    slots,
    remote,
    grant,
    prepare,
    confirm,
    calls: () => calls,
    time: (v: number) => {
      now = v;
    },
    deny: () => {
      denied = true;
    },
    hold: (fn?: () => Promise<void>) => {
      afterAdd = fn;
    },
    close: () => store.close(),
  };
}
test("Key controls require fresh exact one-use review and explicit recovery acknowledgement before creation", async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls(), 0);
    assert.equal(f.controls.status().state.slots.length, 0);
    assert.equal(f.slots.size, 0);
    const r = await f.prepare("create");
    assert.equal(f.slots.size, 0);
    assert.equal(f.calls(), 1);
    r.action = "remove";
    r.binding!.ownerId = randomUUID();
    await assert.rejects(
      f.controls.confirm({
        reviewId: r.id,
        confirmed: true,
        acknowledged: false,
      }),
      /DENIED/,
    );
    await assert.rejects(f.confirm(r.id), /DENIED/);
    assert.equal(f.slots.size, 0);
    const fresh = await f.prepare("create");
    await f.confirm(fresh.id);
    assert.equal(f.controls.status().state.slots[0]!.state, "active");
    await assert.rejects(f.confirm(fresh.id), /DENIED/);
    await assert.rejects(
      f.controls.prepare({
        action: "create",
        expectedRevision: f.controls.status().state.revision,
        ownerId: randomUUID(),
      }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Uncertain native creation can be reviewed and resumed without replacing retained key bytes", async () => {
  const f = await fixture();
  try {
    f.hold(async () => {
      throw Error("PRIVATE_NATIVE_ERROR");
    });
    const r = await f.prepare("create");
    await assert.rejects(f.confirm(r.id), /STORAGE_UNAVAILABLE/);
    const slot = f.controls.status().state.slots[0]!;
    assert.equal(slot.state, "preparing");
    const bytes = f.entries(slot.id).key.bytes!.slice();
    f.hold();
    await f.confirm((await f.prepare("resume", slot.id)).id);
    assert.deepEqual(f.entries(slot.id).key.bytes, bytes);
    assert.equal(f.controls.status().state.slots.length, 1);
    await f.confirm((await f.prepare("replace")).id);
    assert.deepEqual(
      f.controls.status().state.slots.map((s) => [s.keyEpoch, s.state]),
      [
        [1, "retired"],
        [2, "active"],
      ],
    );
  } finally {
    f.close();
  }
});
test("Stale, expired, invalidated or revoked reviews cannot perform a key change", async () => {
  const f = await fixture();
  try {
    const stale = await f.prepare("create"),
      other = f.build();
    await f.confirm((await f.prepare("create", undefined, other)).id, other);
    await assert.rejects(f.confirm(stale.id), /CONFLICT/);
    const invalid = await f.prepare("replace");
    f.controls.invalidate();
    await assert.rejects(f.confirm(invalid.id), /DENIED/);
    const expired = await f.prepare("replace");
    f.time(expired.expiresAt);
    await assert.rejects(f.confirm(expired.id), /DENIED/);
    const revoked = await f.prepare("replace");
    f.deny();
    await assert.rejects(f.confirm(revoked.id), /DENIED/);
    assert.equal(f.controls.status().state.slots.length, 1);
  } finally {
    f.close();
  }
});
test("Offline revoke/removal and failed cleanup retain obligations without enabling new setup", async () => {
  const f = await fixture();
  try {
    await f.confirm((await f.prepare("create")).id);
    const keyId = f.controls.status().state.slots[0]!.id;
    const offline = f.build(false, false),
      calls = f.calls();
    await assert.rejects(f.prepare("replace", undefined, offline), /DENIED/);
    await f.confirm((await f.prepare("revoke", keyId, offline)).id, offline);
    f.entries(keyId).key.failDelete = true;
    await assert.rejects(
      f.confirm((await f.prepare("remove", keyId, offline)).id, offline),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(offline.status().state.pendingKeyDeletionCount, 1);
    f.entries(keyId).key.failDelete = false;
    await f.confirm(
      (await f.prepare("cleanup", undefined, offline)).id,
      offline,
    );
    assert.equal(offline.status().state.pendingKeyDeletionCount, 0);
    assert.equal(f.entries(keyId).key.bytes, undefined);
    assert.equal(f.calls(), calls);
    await offline.clearAll();
    await assert.rejects(f.prepare("create"), /REPAIR_REQUIRED/);
  } finally {
    f.close();
  }
});
test("Authenticated local routes protect key review, busy deletion and real native-cleanup wiring", async () => {
  const f = await fixture(),
    server = createServer();
  try {
    f.store.create(
      f.owner,
      {
        conversationId: "test",
        kind: "query",
        prompt: "preserve during key action",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store: f.store,
        owner: f.owner,
        port,
        token,
        privateKeys: f.controls,
      }),
    );
    const url = `http://127.0.0.1:${port}`,
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
    assert.equal((await fetch(url + "/v1/private-keys")).status, 401);
    assert.equal(
      (
        await fetch(url + "/v1/private-keys", {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await (await fetch(url + "/v1/private-keys", { headers })).json()).state
        .slots.length,
      0,
    );
    const r = await (
      await fetch(url + "/v1/private-keys/review", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "create", expectedRevision: 0 }),
      })
    ).json();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
        started = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    f.hold(async () => {
      started();
      await held;
    });
    const creation = fetch(url + "/v1/private-keys/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        reviewId: r.id,
        confirmed: true,
        acknowledged: true,
      }),
    });
    await entered;
    const remove = () =>
      fetch(url + "/v1/data", {
        method: "DELETE",
        headers: { ...headers, "X-Confirm-Delete": "all-local-task-data" },
      });
    assert.equal((await remove()).status, 409);
    assert.equal(f.store.list(f.owner).length, 1);
    release();
    assert.equal((await creation).status, 200);
    const keyId = f.controls.status().state.slots[0]!.id;
    f.entries(keyId).key.failDelete = true;
    const failure = await remove();
    assert.equal(failure.status, 503);
    assert.ok(
      !JSON.stringify(await failure.json()).includes("PRIVATE_NATIVE_ERROR"),
    );
    assert.equal(f.store.list(f.owner).length, 1);
    f.entries(keyId).key.failDelete = false;
    assert.equal((await remove()).status, 204);
    assert.equal(f.entries(keyId).key.bytes, undefined);
    assert.equal(f.store.list(f.owner).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("Host invalidation fences key output while retained setup remains explicitly resumable", async () => {
  const f = await fixture();
  try {
    f.hold(async () => {
      f.controls.invalidate();
    });
    const review = await f.prepare("create");
    await assert.rejects(f.confirm(review.id), /DENIED/);
    assert.equal(f.controls.status().state.slots[0]!.state, "preparing");
    f.hold();
    const id = f.controls.status().state.slots[0]!.id;
    await f.confirm((await f.prepare("resume", id)).id);
    assert.equal(f.controls.status().state.slots[0]!.state, "active");
  } finally {
    f.close();
  }
});
const emptyStatus = {
  available: true,
  canSetup: true,
  state: {
    revision: 0,
    needsFreshPairing: false,
    pendingKeyDeletionCount: 0,
    slots: [],
  },
};
test("Key panel requires acknowledgement, captures revision and never retries uncertain confirmation", async () => {
  const calls: any[] = [];
  const controller = new PrivateKeyPanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      if (path.endsWith("/review"))
        return {
          id: randomUUID(),
          action: "create",
          expiresAt: Date.now() + 60000,
          binding: null,
        };
      if (path.endsWith("/confirm")) throw Error("STORAGE_UNAVAILABLE");
      return emptyStatus;
    },
    () => {},
  );
  await controller.refresh();
  await controller.prepare("create");
  await controller.confirm(false);
  assert.equal(calls.length, 2);
  await controller.confirm(true);
  assert.equal(calls[1].body.expectedRevision, 0);
  assert.equal(calls.length, 3);
  assert.equal(controller.state.review, null);
  assert.equal(controller.state.status, null);
  assert.ok(controller.state.error.includes("unfinished"));
  await controller.confirm(true);
  assert.equal(calls.length, 3);
});
test("Key panel focus loss suppresses delayed reviews and requires another explicit review", async () => {
  let release!: (v: any) => void;
  const controller = new PrivateKeyPanelState(
    async (path) =>
      path.endsWith("/review")
        ? new Promise((r) => {
            release = r;
          })
        : emptyStatus,
    () => {},
  );
  await controller.refresh();
  const pending = controller.prepare("create");
  controller.hide();
  release({
    id: randomUUID(),
    action: "create",
    expiresAt: Date.now() + 60000,
    binding: null,
  });
  await pending;
  assert.equal(controller.state.review, null);
  assert.equal(controller.state.busy, false);
});
test("Key panel rejects expired review locally and hides late successful confirmation notices", async () => {
  let now = 1000,
    release!: (v: any) => void;
  const controller = new PrivateKeyPanelState(
    async (path) =>
      path.endsWith("/review")
        ? {
            id: randomUUID(),
            action: "create",
            expiresAt: now + 1000,
            binding: null,
          }
        : path.endsWith("/confirm")
          ? new Promise((r) => {
              release = r;
            })
          : emptyStatus,
    () => {},
    () => now,
  );
  await controller.refresh();
  await controller.prepare("create");
  now += 1000;
  await controller.confirm(true);
  assert.equal(controller.state.review, null);
  assert.ok(controller.state.error.includes("expired"));
  await controller.prepare("create");
  const pending = controller.confirm(true);
  controller.hide();
  release(emptyStatus);
  await pending;
  assert.equal(controller.state.notice, "");
});

test("Dashboard logout invalidates an outstanding review and suppresses late native key completion", async () => {
  const f = await fixture(),
    server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      origin = `http://127.0.0.1:${port}`;
    server.on(
      "request",
      dashboardServer({
        store: f.store,
        owner: f.owner,
        port,
        token: "t".repeat(64),
        pairCode: "p".repeat(24),
        assets: "apps/dashboard",
        privateKeys: f.controls,
      }),
    );
    const post = (path: string, body: unknown, Cookie = "") =>
      fetch(origin + path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", Cookie },
        body: JSON.stringify(body),
      });
    const pair = await post("/pair", { code: "p".repeat(24) });
    const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
    const r = await (
      await post(
        "/v1/private-keys/review",
        { action: "create", expectedRevision: 0 },
        cookie,
      )
    ).json();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
        started = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    f.hold(async () => {
      started();
      await held;
    });
    const pending = post(
      "/v1/private-keys/confirm",
      { reviewId: r.id, confirmed: true, acknowledged: true },
      cookie,
    );
    await entered;
    assert.equal((await post("/logout", {}, cookie)).status, 204);
    release();
    assert.notEqual((await pending).status, 200);
    assert.equal(f.controls.status().state.slots[0]!.state, "preparing");
    assert.equal(
      (
        await fetch(origin + "/v1/private-keys", {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("All-data deletion invalidates an unconfirmed first-key review even when no key exists yet", async () => {
  const f = await fixture(),
    server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = "t".repeat(64);
    server.on(
      "request",
      localApi({
        store: f.store,
        owner: f.owner,
        port,
        token,
        privateKeys: f.controls,
      }),
    );
    const review = await f.prepare("create");
    assert.equal(f.slots.size, 0);
    const result = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + token,
        "X-Confirm-Delete": "all-local-task-data",
      },
    });
    assert.equal(result.status, 204);
    await assert.rejects(f.confirm(review.id), /DENIED/);
    assert.equal(f.slots.size, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

async function peerInvitation(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = {
    version: 1,
    ownerId: f.grant.ownerId,
    recipientId: f.grant.deviceId,
    peerId: randomUUID(),
    keyEpoch: 1,
    publicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ).toString("base64url"),
    nonce: randomUUID(),
    issuedAt: 1800000000000,
    expiresAt: 1800000300000,
    ...overrides,
  };
  return await inspectPrivateInvitation(raw, 1800000000000);
}
async function activeKey(f: Awaited<ReturnType<typeof fixture>>) {
  await f.confirm((await f.prepare("create")).id);
}
function reviewPeer(
  f: Awaited<ReturnType<typeof fixture>>,
  invitation: unknown,
) {
  const s = f.controls.peerStatus();
  return f.controls.preparePeer({
    action: "approve",
    expectedRevision: s.revision,
    expectedKeyRevision: s.keyRevision,
    invitation,
  });
}
function confirmPeer(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  fingerprint: string,
) {
  return f.controls.confirmPeer({
    reviewId: id,
    confirmed: true,
    acknowledged: true,
    comparedFingerprint: fingerprint,
  });
}
test("Mac peer controls export only a recipient-bound public invitation and require independent full fingerprint confirmation", async () => {
  const f = await fixture();
  try {
    assert.equal(f.controls.peerStatus().hasSelectedKey, false);
    assert.equal(f.calls(), 0);
    assert.equal(f.slots.size, 0);
    await assert.rejects(
      f.controls.peerInvitation({
        recipientId: randomUUID(),
        expectedKeyRevision: 0,
        confirmed: true,
      }),
    );
    await activeKey(f);
    const recipient = randomUUID(),
      keyRevision = f.controls.peerStatus().keyRevision;
    const sent = await f.controls.peerInvitation({
      recipientId: recipient,
      expectedKeyRevision: keyRevision,
      confirmed: true,
    });
    assert.equal(sent.invitation.recipientId, recipient);
    assert.equal(sent.invitation.peerId, f.grant.deviceId);
    assert.equal(
      (await inspectPrivateInvitation(sent.invitation, 1800000000000))
        .fingerprint,
      sent.fingerprint,
    );
    assert.equal(
      sent.invitation.publicKey,
      f.controls.status().state.slots[0]!.publicKey,
    );
    assert.deepEqual(Object.keys(sent).sort(), ["fingerprint", "invitation"]);
    const incoming = await peerInvitation(f);
    const wrong = await reviewPeer(f, incoming.invitation);
    await assert.rejects(confirmPeer(f, wrong.id, "0".repeat(64)), /DENIED/);
    await assert.rejects(
      confirmPeer(f, wrong.id, incoming.fingerprint),
      /DENIED/,
    );
    assert.equal(f.controls.peerStatus().peers.length, 0);
    const r = await reviewPeer(f, incoming.invitation);
    r.peerId = randomUUID();
    r.binding!.ownerId = randomUUID();
    r.fingerprint = "0".repeat(64);
    const result = await confirmPeer(f, r.id, incoming.fingerprint);
    assert.equal(result.peers[0]!.peerId, incoming.invitation.peerId);
    assert.equal(result.peers[0]!.fingerprint, incoming.fingerprint);
    await assert.rejects(confirmPeer(f, r.id, incoming.fingerprint), /DENIED/);
    await assert.rejects(reviewPeer(f, incoming.invitation), /DENIED/);
    assert.equal(
      f.store.exportPrivatePeerTrust(f.owner).state!.peers.length,
      1,
    );
  } finally {
    f.close();
  }
});
test("Mac peer approval denies wrong account/recipient, expired review, changed key, changed registry and revoked registration", async () => {
  const f = await fixture();
  try {
    await activeKey(f);
    await assert.rejects(
      reviewPeer(
        f,
        (await peerInvitation(f, { ownerId: randomUUID() })).invitation,
      ),
      /DENIED/,
    );
    await assert.rejects(
      reviewPeer(
        f,
        (await peerInvitation(f, { recipientId: randomUUID() })).invitation,
      ),
      /DENIED/,
    );
    const incoming = await peerInvitation(f);
    let r = await reviewPeer(f, incoming.invitation);
    f.time(1800000300001);
    await assert.rejects(confirmPeer(f, r.id, incoming.fingerprint), /DENIED/);
    f.time(1800000000000);
    r = await reviewPeer(f, incoming.invitation);
    const other = f.build();
    await f.confirm((await f.prepare("replace", undefined, other)).id, other);
    await assert.rejects(
      confirmPeer(f, r.id, incoming.fingerprint),
      /CONFLICT/,
    );
    r = await reviewPeer(f, incoming.invitation);
    const s = other.peerStatus(),
      second = await peerInvitation(f);
    const concurrent = await other.preparePeer({
      action: "approve",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      invitation: second.invitation,
    });
    await other.confirmPeer({
      reviewId: concurrent.id,
      acknowledged: true,
      confirmed: true,
      comparedFingerprint: second.fingerprint,
    });
    await assert.rejects(
      confirmPeer(f, r.id, incoming.fingerprint),
      /CONFLICT/,
    );
    r = await reviewPeer(f, incoming.invitation);
    f.deny();
    await assert.rejects(confirmPeer(f, r.id, incoming.fingerprint));
    assert.equal(f.controls.peerStatus().peers.length, 1);
  } finally {
    f.close();
  }
});
test("Mac peer revocation works offline and cannot silently restore a revoked or changed key", async () => {
  const f = await fixture();
  try {
    await activeKey(f);
    const incoming = await peerInvitation(f);
    await confirmPeer(
      f,
      (await reviewPeer(f, incoming.invitation)).id,
      incoming.fingerprint,
    );
    const offline = f.build(false, false),
      calls = f.calls();
    const r = await offline.preparePeer({
      action: "revoke",
      expectedRevision: offline.peerStatus().revision,
      peerId: incoming.invitation.peerId,
    });
    await assert.rejects(
      offline.confirmPeer({
        reviewId: r.id,
        confirmed: true,
        acknowledged: false,
      }),
      /DENIED/,
    );
    const fresh = await offline.preparePeer({
      action: "revoke",
      expectedRevision: offline.peerStatus().revision,
      peerId: incoming.invitation.peerId,
    });
    await offline.confirmPeer({
      reviewId: fresh.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(f.calls(), calls);
    assert.equal(offline.peerStatus().peers[0]!.revoked, true);
    await assert.rejects(reviewPeer(f, incoming.invitation), /DENIED/);
    const replacement = await peerInvitation(f, {
      peerId: incoming.invitation.peerId,
      keyEpoch: 2,
    });
    const review = await reviewPeer(f, replacement.invitation);
    assert.equal((review.replaces as any).keyEpoch, 1);
    await confirmPeer(f, review.id, replacement.fingerprint);
    assert.equal(offline.peerStatus().peers[0]!.keyEpoch, 2);
    await assert.rejects(
      offline.peerInvitation({
        recipientId: randomUUID(),
        expectedKeyRevision: offline.peerStatus().keyRevision,
        confirmed: true,
      }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Mac peer operations share key/deletion exclusion and discard output on logout invalidation", async () => {
  const f = await fixture();
  try {
    await activeKey(f);
    const incoming = await peerInvitation(f),
      r = await reviewPeer(f, incoming.invitation);
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
        started = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const key = [...f.slots.values()][0]!.key;
    key.afterGet = async () => {
      started();
      await held;
    };
    const confirmation = confirmPeer(f, r.id, incoming.fingerprint);
    await entered;
    assert.equal(f.controls.busy, true);
    await assert.rejects(f.controls.clearAll(), /BUSY/);
    await assert.rejects(f.prepare("replace"), /BUSY/);
    f.controls.invalidate();
    release();
    await assert.rejects(confirmation);
    assert.equal(f.controls.peerStatus().peers.length, 0);
    key.afterGet = undefined;
    const fresh = await reviewPeer(f, incoming.invitation);
    await f.prepare("replace");
    await assert.rejects(
      confirmPeer(f, fresh.id, incoming.fingerprint),
      /DENIED/,
    );
    await assert.rejects(
      f.controls.peerInvitation({
        recipientId: randomUUID(),
        expectedKeyRevision: f.controls.peerStatus().keyRevision,
        confirmed: true,
        ownerId: f.grant.ownerId,
      }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Authenticated Mac peer routes preserve one-use review, deletion invalidation and origin boundaries", async () => {
  const f = await fixture(),
    server = createServer();
  try {
    await activeKey(f);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store: f.store,
        owner: f.owner,
        port,
        token,
        privateKeys: f.controls,
      }),
    );
    const base = `http://127.0.0.1:${port}`,
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    for (const path of [
      "/v1/private-peers",
      "/v1/private-peers/review",
      "/v1/private-peers/confirm",
      "/v1/private-peers/invitation",
    ]) {
      assert.equal(
        (
          await fetch(base + path, {
            method: path.endsWith("peers") ? "GET" : "POST",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(base + path, {
            headers: { ...headers, Origin: "https://evil.example" },
          })
        ).status,
        403,
      );
    }
    const incoming = await peerInvitation(f),
      state = f.controls.peerStatus();
    const reviewResponse = await post("/v1/private-peers/review", {
      action: "approve",
      expectedRevision: state.revision,
      expectedKeyRevision: state.keyRevision,
      invitation: incoming.invitation,
    });
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json();
    assert.equal(
      (
        await post("/v1/private-peers/confirm", {
          reviewId: review.id,
          acknowledged: true,
          confirmed: true,
          comparedFingerprint: incoming.fingerprint,
        })
      ).status,
      200,
    );
    const listed = await (
      await fetch(base + "/v1/private-peers", { headers })
    ).json();
    assert.equal(listed.peers.length, 1);
    const pending = await reviewPeer(f, (await peerInvitation(f)).invitation);
    assert.equal(
      (
        await fetch(base + "/v1/data", {
          method: "DELETE",
          headers: { ...headers, "X-Confirm-Delete": "all-local-task-data" },
        })
      ).status,
      204,
    );
    await assert.rejects(
      confirmPeer(f, pending.id, incoming.fingerprint),
      /DENIED/,
    );
    assert.equal(f.controls.peerStatus().needsFreshPairing, true);
    assert.equal(f.controls.peerStatus().peers.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("Peer panel never fills the independent comparison, fences delayed work and avoids confirmation replay", async () => {
  let release!: (value: unknown) => void,
    mode = "normal",
    calls: { path: string; body: any }[] = [],
    now = 1800000000000;
  const fingerprint = "a".repeat(64),
    status = {
      available: true,
      canSetup: true,
      revision: 0,
      keyRevision: 2,
      needsFreshPairing: false,
      hasSelectedKey: true,
      peers: [],
    };
  const review = {
    id: randomUUID(),
    action: "approve",
    expiresAt: now + 300000,
    fingerprint,
    peerId: randomUUID(),
    binding: null,
    keyEpoch: 1,
    replaces: null,
  };
  const c = new PrivatePeerPanelState(
    async (path, _method, body) => {
      calls.push({ path, body });
      if (path.endsWith("peers")) return status;
      if (path.endsWith("review"))
        return mode === "held"
          ? new Promise((r) => {
              release = r;
            })
          : review;
      throw Error("CONFLICT");
    },
    () => {},
    () => now,
  );
  await c.refresh();
  mode = "held";
  const pending = c.prepare("approve", "{}");
  c.hide();
  release(review);
  await pending;
  assert.equal(c.state.review, null);
  mode = "normal";
  await c.prepare("approve", "{}");
  await c.confirm(true, "");
  await c.confirm(false, fingerprint);
  assert.equal(calls.filter((v) => v.path.endsWith("confirm")).length, 0);
  await c.confirm(true, fingerprint);
  await c.confirm(true, fingerprint);
  assert.equal(calls.filter((v) => v.path.endsWith("confirm")).length, 1);
  assert.equal(c.state.review, null);
  assert.match(c.state.error, /no automatic retry/);
  await c.refresh();
  await c.prepare("approve", "{}");
  now += 300001;
  await c.confirm(true, fingerprint);
  assert.match(c.state.error, /expired/);
  assert.equal(calls.filter((v) => v.path.endsWith("confirm")).length, 1);
});

test("Peer publication rechecks the Mac key under the same SQLite write lock", async () => {
  const f = await fixture();
  try {
    await activeKey(f);
    const incoming = await peerInvitation(f),
      review = await reviewPeer(f, incoming.invitation);
    const original = f.store.db.transaction.bind(f.store.db);
    let injected = false;
    f.store.db.transaction = ((fn: any) => {
      const tx = original(fn),
        immediate = tx.immediate.bind(tx);
      const wrapped = (...args: any[]) => tx(...args);
      wrapped.immediate = (...args: any[]) => {
        if (!injected) {
          injected = true;
          f.store.db.transaction = original;
          const state = f.controls.status().state;
          new PrivateKeyLifecycle(
            f.store,
            f.vault,
            f.owner,
            () => null,
            f.entries,
          ).revoke({
            keyId: state.slots[0]!.id,
            expectedRevision: state.revision,
            confirmed: true,
          });
        }
        return immediate(...args);
      };
      return wrapped;
    }) as typeof f.store.db.transaction;
    await assert.rejects(
      confirmPeer(f, review.id, incoming.fingerprint),
      /CONFLICT/,
    );
    assert.equal(injected, true);
    assert.equal(f.controls.peerStatus().peers.length, 0);
    assert.equal(f.controls.status().state.slots[0]!.state, "retired");
  } finally {
    f.close();
  }
});
