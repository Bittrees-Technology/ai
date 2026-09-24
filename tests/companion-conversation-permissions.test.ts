import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateEndpoints } from "./helpers/private-endpoints.js";
import { localApi } from "../apps/companion/http.js";
async function fixture(verified = true) {
  const f = await privateEndpoints(verified),
    e = f.b;
  const inbox = {
    id: "personal",
    tenantId: e.owner.tenantId,
    ownerId: e.owner.userId,
    ownerType: "user",
    memberUserIds: [e.owner.userId],
  };
  e.store.createInbox(e.owner, inbox);
  const conversationId = randomUUID();
  e.store.appendMessage(
    e.owner,
    {
      conversationId,
      recipientInboxId: inbox.id,
      type: "notification",
      content: "SYNTHETIC_PRIVATE_THREAD",
    },
    randomUUID(),
  );
  const request = () => {
    const s = e.controls.conversationPermissionStatus();
    return {
      action: "grant",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      expectedPeerRevision: s.peerRevision,
      peerId: f.a.grant.deviceId,
      peerKeyEpoch: 1,
      conversationId,
      inboxId: inbox.id,
      permissions: {
        messagesToMac: true,
        messagesToBrowser: true,
        questionsToBrowser: false,
        answersToMac: false,
      },
      minutes: 15,
    };
  };
  const prepare = (overrides = {}) =>
    e.controls.prepareConversationPermission({ ...request(), ...overrides });
  const confirm = (id: string) =>
    e.controls.confirmConversationPermission({
      reviewId: id,
      confirmed: true,
      acknowledged: true,
    });
  return { ...f, e, inbox, conversationId, request, prepare, confirm };
}
test("Mac conversation review rechecks exact choices, expires and never uses existing task permission as consent", async () => {
  const f = await fixture();
  try {
    assert.equal(f.e.controls.permissionStatus().grants.length, 1);
    assert.deepEqual(f.e.controls.conversationPermissionStatus().grants, []);
    await assert.rejects(f.prepare({ conversationId: "unknown" }), /DENIED/);
    const r = await f.prepare();
    assert.equal(JSON.stringify(r).includes("SYNTHETIC_PRIVATE_THREAD"), false);
    assert.equal(r.choices!.conversationId, f.conversationId);
    r.choices!.permissions.answersToMac = true;
    const saved = await f.confirm(r.id);
    assert.equal(saved.grants.length, 1);
    assert.equal(saved.grants[0]!.choices.permissions.answersToMac, false);
    await assert.rejects(f.confirm(r.id), /DENIED/);
    const expired = await f.prepare();
    f.advance(300000);
    await assert.rejects(f.confirm(expired.id), /DENIED/);
  } finally {
    f.close();
  }
});
test("Mac conversation grants require current verified possession; task, peer and key reviews invalidate pending conversation review", async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.prepare(), /DENIED/);
  } finally {
    f.close();
  }
  const g = await fixture();
  try {
    let r = await g.prepare();
    await g.e.controls.preparePermission({
      action: "revoke",
      expectedRevision: g.e.controls.permissionStatus().revision,
      peerId: g.a.grant.deviceId,
    });
    await assert.rejects(g.confirm(r.id), /DENIED/);
    r = await g.prepare();
    const peer = g.e.controls.peerStatus();
    await g.e.controls.peerInvitation({
      recipientId: g.a.grant.deviceId,
      expectedKeyRevision: peer.keyRevision,
      confirmed: true,
    });
    await assert.rejects(g.confirm(r.id), /DENIED/);
    r = await g.prepare();
    const key = g.e.controls.status().state;
    await g.e.controls.prepare({
      action: "revoke",
      keyId: key.slots.find((s) => s.state === "active")!.id,
      expectedRevision: key.revision,
    });
    await assert.rejects(g.confirm(r.id), /DENIED/);
  } finally {
    g.close();
  }
});
test("changed Inbox or rejected live identity cannot commit a previously reviewed conversation grant", async () => {
  const f = await fixture();
  try {
    let r = await f.prepare();
    f.e.store.createInbox(f.e.owner, f.inbox);
    await assert.rejects(f.confirm(r.id), /CONFLICT/);
    r = await f.prepare();
    f.e.deny();
    await assert.rejects(f.confirm(r.id));
    assert.deepEqual(f.e.controls.conversationPermissionStatus().grants, []);
  } finally {
    f.close();
  }
});
test("saved conversation choices can be reviewed and revoked offline without authorizing another thread", async () => {
  const f = await fixture();
  try {
    const saved = await f.confirm((await f.prepare()).id),
      grant = saved.grants[0]!;
    const offline = f.e.build(false, false);
    const r = await offline.prepareConversationPermission({
      action: "revoke",
      permissionId: grant.id,
      expectedRevision: saved.revision,
    });
    assert.equal(r.peerId, f.a.grant.deviceId);
    assert.equal(r.choices!.conversationId, f.conversationId);
    const after = await offline.confirmConversationPermission({
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(after.grants[0]!.state, "revoked");
    await assert.rejects(
      offline.prepareConversationPermission({
        ...f.request(),
        expectedRevision: after.revision,
      }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("authenticated conversation routes enforce origin, owner export, deletion exclusion and logout while resolving native keys", async () => {
  const f = await fixture(),
    server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store: f.e.store,
        owner: f.e.owner,
        token,
        port,
        privateKeys: f.e.controls,
      }),
    );
    const base = `http://127.0.0.1:${port}`,
      path = "/v1/private-conversation-permissions";
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
    const post = (suffix: string, body: unknown) =>
      fetch(base + path + suffix, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    for (const suffix of ["", "/review", "/confirm"]) {
      const method = suffix ? "POST" : "GET";
      assert.equal((await fetch(base + path + suffix, { method })).status, 401);
      assert.equal(
        (
          await fetch(base + path + suffix, {
            method,
            headers: { ...headers, Origin: "https://wrong.invalid" },
          })
        ).status,
        403,
      );
    }
    const r = await (await post("/review", f.request())).json();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    const slot = [...f.e.slots.values()][0]!.key;
    slot.beforeRead = async () => {
      entered();
      await waiting;
    };
    const confirmation = post("/confirm", {
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
    await started;
    const remove = () =>
      fetch(base + "/v1/data", {
        method: "DELETE",
        headers: { ...headers, "X-Confirm-Delete": "all-local-task-data" },
      });
    assert.equal((await remove()).status, 409);
    f.e.controls.invalidate();
    release();
    assert.notEqual((await confirmation).status, 200);
    slot.beforeRead = undefined;
    assert.deepEqual(f.e.controls.conversationPermissionStatus().grants, []);
    const next = await (await post("/review", f.request())).json();
    assert.equal(
      (
        await post("/confirm", {
          reviewId: next.id,
          confirmed: true,
          acknowledged: true,
        })
      ).status,
      200,
    );
    const exported = await (
      await fetch(base + "/v1/export", { headers })
    ).json();
    assert.equal(exported.privateConversationConsent.grants.length, 1);
    assert.equal((await remove()).status, 204);
    assert.deepEqual(f.e.controls.conversationPermissionStatus().grants, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
