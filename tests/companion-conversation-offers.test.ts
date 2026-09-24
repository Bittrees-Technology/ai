import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { conversationOfferEndpoints as fixture } from "./helpers/conversation-offer-endpoints.js";
import { localApi } from "../apps/companion/http.js";
import { CompanionConversationOffers } from "../apps/companion/private-conversation-offers.js";
test("reviewed Mac offer exports exact scope once and reveals original ciphertext after restart", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    assert.deepEqual(f.e.controls.conversationOfferStatus().offers, []);
    assert.equal(r.choices.conversationId, f.conversationId);
    assert.equal(JSON.stringify(r).includes("SYNTHETIC_NEVER_IN_OFFER"), false);
    const exact = structuredClone(r);
    r.choices.permissions.answersToMac = true;
    f.advance(5000);
    const created = await f.confirm(r.id);
    assert.ok(created.envelope);
    assert.equal(created.envelope.header.expiresAt, exact.offerExpiresAt);
    const opened = await f.open(created.envelope);
    assert.equal(opened.type, "conversation.offer");
    assert.equal(opened.permissions.answersToMac, false);
    assert.equal(opened.scope.permissionId, f.input.permissionId);
    assert.equal(JSON.stringify(opened).includes(f.conversationId), false);
    assert.equal(
      JSON.stringify(opened).includes("SYNTHETIC_NEVER_IN_OFFER"),
      false,
    );
    assert.equal(
      JSON.stringify(f.e.controls.conversationOfferStatus()).includes(
        '"envelope"',
      ),
      false,
    );
    await assert.rejects(f.confirm(r.id), /DENIED/);
    f.e.reopen();
    const next = await f.e.controls.prepareConversationOffer({
      action: "reveal",
      id: created.offer.id,
      expectedRevision: created.offer.revision,
    });
    const retry = await f.confirm(next.id);
    assert.deepEqual(retry.envelope, created.envelope);
    assert.equal(f.e.controls.conversationOfferStatus().offers.length, 1);
    assert.deepEqual(
      f.e.store.db.prepare("SELECT count(*) AS count FROM tasks").get(),
      { count: 0 },
    );
  } finally {
    f.close();
  }
});
test("offer review denies changed consent, Inbox and rejected verified identity without exporting", async () => {
  for (const change of ["consent", "inbox", "identity"] as const) {
    const f = await fixture();
    try {
      const r = await f.prepare();
      if (change === "consent") {
        const state = f.e.controls.conversationPermissionStatus();
        const revoke = await f.e.controls.prepareConversationPermission({
          action: "revoke",
          expectedRevision: state.revision,
          permissionId: f.input.permissionId,
        });
        await f.e.controls.confirmConversationPermission({
          reviewId: revoke.id,
          confirmed: true,
          acknowledged: true,
        });
      } else if (change === "inbox") f.e.store.createInbox(f.e.owner, f.inbox);
      else f.e.deny();
      await assert.rejects(f.confirm(r.id));
      assert.deepEqual(f.e.controls.conversationOfferStatus().offers, []);
    } finally {
      f.close();
    }
  }
});
test("offer review expiry follows both clocks, consumes invalid confirmation and fences late identity reads", async () => {
  const f = await fixture();
  try {
    let mono = 0;
    const controls = new CompanionConversationOffers(
      f.e.store,
      f.e.vault,
      f.e.owner,
      (current) => f.e.keys(current ?? (() => null)),
      f.e.remote,
      true,
      f.clock,
      () => mono,
    );
    let r = await controls.prepare(f.input);
    mono = 120000;
    await assert.rejects(
      controls.confirm({ reviewId: r.id, confirmed: true, acknowledged: true }),
      /DENIED/,
    );
    r = await controls.prepare(f.input);
    f.advance(120000);
    await assert.rejects(
      controls.confirm({ reviewId: r.id, confirmed: true, acknowledged: true }),
      /DENIED/,
    );
    r = await controls.prepare(f.input);
    await assert.rejects(
      controls.confirm({
        reviewId: r.id,
        confirmed: true,
        acknowledged: false,
      }),
      /DENIED/,
    );
    await assert.rejects(
      controls.confirm({ reviewId: r.id, confirmed: true, acknowledged: true }),
      /DENIED/,
    );
    f.e.readHook(() => controls.invalidate());
    await assert.rejects(controls.prepare(f.input), /DENIED/);
    assert.deepEqual(controls.status().offers, []);
  } finally {
    f.close();
  }
});
test("competing key/peer/task reviews fence offers; stop works offline and cannot revoke exported copies", async () => {
  const f = await fixture();
  try {
    let r = await f.prepare();
    await f.e.controls.preparePermission({
      action: "revoke",
      expectedRevision: f.e.controls.permissionStatus().revision,
      peerId: f.a.grant.deviceId,
    });
    await assert.rejects(f.confirm(r.id), /DENIED/);
    r = await f.prepare();
    await f.e.controls.peerInvitation({
      recipientId: f.a.grant.deviceId,
      expectedKeyRevision: f.e.controls.peerStatus().keyRevision,
      confirmed: true,
    });
    await assert.rejects(f.confirm(r.id), /DENIED/);
    r = await f.prepare();
    const state = f.e.controls.status().state;
    await f.e.controls.prepare({
      action: "revoke",
      expectedRevision: state.revision,
      keyId: state.slots.find((s) => s.state === "active")!.id,
    });
    await assert.rejects(f.confirm(r.id), /DENIED/);
    const created = await f.confirm((await f.prepare()).id),
      offline = f.e.build(false, false);
    const stop = await offline.prepareConversationOffer({
      action: "stop",
      id: created.offer.id,
      expectedRevision: created.offer.revision,
    });
    const stopped = await offline.confirmConversationOffer({
      reviewId: stop.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(stopped.envelope, null);
    assert.equal(stopped.offer.state, "stopped");
    await assert.rejects(
      f.e.controls.prepareConversationOffer({
        action: "reveal",
        id: stopped.offer.id,
        expectedRevision: stopped.offer.revision,
      }),
      /DENIED/,
    );
    assert.equal((await f.open(created.envelope!)).type, "conversation.offer");
    assert.equal(
      f.e.controls.conversationPermissionStatus().grants[0]!.state,
      "saved",
    );
  } finally {
    f.close();
  }
});
test("offer HTTP routes enforce auth/origin, shared deletion lock, logout fencing and reviewed recovery", async () => {
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
      path = "/v1/private-conversation-offers",
      headers = {
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
    const r = await (await post("/review", f.input)).json();
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
    const pending = post("/confirm", {
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
    assert.notEqual((await pending).status, 200);
    slot.beforeRead = undefined;
    assert.deepEqual(f.e.controls.conversationOfferStatus().offers, []);
    const next = await (await post("/review", f.input)).json();
    const confirmed = await post("/confirm", {
      reviewId: next.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(confirmed.status, 200);
    const created = await confirmed.json();
    const exported = await (
      await fetch(base + "/v1/export", { headers })
    ).json();
    assert.equal(exported.privateConversationOffers.length, 1);
    const foreign = f.e.build(true, true, {
      userId: "other",
      tenantId: f.e.owner.tenantId,
    });
    assert.deepEqual(foreign.conversationOfferStatus().offers, []);
    await assert.rejects(
      foreign.prepareConversationOffer({
        action: "reveal",
        id: created.offer.id,
        expectedRevision: created.offer.revision,
      }),
      /DENIED/,
    );
    assert.equal((await remove()).status, 204);
    assert.deepEqual(f.e.controls.conversationOfferStatus().offers, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
