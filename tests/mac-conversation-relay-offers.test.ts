import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { macConversationRelayFixture as fixture } from "./helpers/mac-conversation-relay.js";

test("reviewed native offer upload retains server storage separately from browser consent", async () => {
  const g = await fixture();
  try {
    const before = g.e.controls.conversationPermissionStatus(),
      r = await g.prepare();
    assert.equal(g.outgoing.size, 0);
    assert.equal(r.action, "send");
    assert.equal(r.transportOnly, true);
    assert.equal(r.relayRecipient!.endpointId, g.f.a.grant.deviceId);
    const sent = await g.confirm(r.id);
    assert.equal(sent.envelope, null);
    assert.ok("transport" in sent);
    assert.equal(sent.transport.transportOnly, true);
    assert.equal(sent.transport.receipt.state, "stored");
    assert.equal(sent.offer.relayAttempts, 1);
    assert.equal(sent.offer.relayObservation?.attempt, 1);
    assert.deepEqual(
      g.outgoing.get(sent.transport.receipt.messageId)!.envelope,
      g.offer.envelope,
    );
    const opened = await g.f.open(
      g.outgoing.get(sent.transport.receipt.messageId)!.envelope,
    );
    assert.equal(opened.type, "conversation.offer");
    assert.equal(opened.scope.permissionId, g.consent.grants[0]!.id);
    assert.doesNotMatch(
      JSON.stringify({ r, sent, opened }),
      /PRIVATE_NEVER_IN_OFFER|ciphertext|privateKey|"credential":/,
    );
    assert.deepEqual(g.e.controls.conversationPermissionStatus(), before);
    await assert.rejects(g.confirm(r.id), /DENIED/);
    assert.equal(g.outgoing.size, 1);
  } finally {
    g.close();
  }
});

test("lost relay replies survive restart and explicit offer retry keeps the original ciphertext and sequence", async () => {
  const g = await fixture();
  try {
    const r = await g.prepare(),
      oldInput = g.input();
    g.control.loseSubmit = true;
    await assert.rejects(g.confirm(r.id));
    assert.equal(g.outgoing.size, 1);
    assert.equal(g.statusOffer().relayAttempts, 1);
    assert.equal(g.statusOffer().relayObservation, null);
    const wire = structuredClone([...g.outgoing.values()][0]);
    g.reopen();
    g.control.loseSubmit = false;
    const calls = g.control.calls.length;
    await assert.rejects(g.prepare(oldInput), /CONFLICT/);
    assert.equal(g.control.calls.length, calls);
    const sent = await g.confirm((await g.prepare()).id);
    assert.ok("transport" in sent);
    assert.equal(sent.transport.duplicate, true);
    assert.equal(sent.offer.relayAttempts, 2);
    assert.equal(sent.offer.relayObservation?.attempt, 2);
    assert.deepEqual([...g.outgoing.values()][0], wire);
    assert.equal(g.outgoing.size, 1);
  } finally {
    g.close();
  }
});

test("offer review binds current relay destination and lease without extending a retained offer", async () => {
  const g = await fixture();
  try {
    const initial = g.statusOffer();
    g.control.recipientExpiresAt = initial.expiresAt - 1;
    await assert.rejects(g.prepare(), /DENIED/);
    g.control.recipientExpiresAt = g.f.clock() + 1800000;
    const review = await g.prepare();
    g.control.recipientExpiresAt -= 1;
    await assert.rejects(g.confirm(review.id), /CONFLICT/);
    assert.deepEqual(g.statusOffer(), initial);
    g.control.denyRecipient = true;
    await assert.rejects(g.prepare(), /DENIED/);
    assert.equal(g.outgoing.size, 0);
    await assert.rejects(
      g.e.controls.prepareConversationOffer(g.input()),
      /DENIED/,
    );
  } finally {
    g.close();
  }
});

test("stale review, revoked conversation and stopped offers cannot initiate uploads", async () => {
  const g = await fixture();
  try {
    const r = await g.prepare();
    g.e.controls.invalidate();
    await assert.rejects(g.confirm(r.id), /DENIED/);
    assert.equal(g.statusOffer().relayAttempts, 0);
    const revoked = await g.e.controls.prepareConversationPermission({
      action: "revoke",
      expectedRevision: g.consent.revision,
      permissionId: g.consent.grants[0]!.id,
    });
    await g.e.controls.confirmConversationPermission({
      reviewId: revoked.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(g.prepare(), /DENIED/);
    const stop = await g.e.controls.prepareConversationOffer({
      action: "stop",
      id: g.offer.offer.id,
      expectedRevision: g.statusOffer().revision,
    });
    await g.e.controls.confirmConversationOffer({
      reviewId: stop.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(g.prepare(), /DENIED/);
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.close();
  }
});

test("late logout or invalid server receipts retain an uncertain attempt without claiming storage acknowledgement", async () => {
  for (const mode of ["logout", "wrong-receipt"] as const) {
    const g = await fixture();
    try {
      const review = await g.prepare();
      g.control.afterSubmit = async () => {
        if (mode === "logout") g.e.controls.invalidate();
        else [...g.outgoing.values()][0]!.receipt.envelopeHash = "a".repeat(64);
      };
      await assert.rejects(g.confirm(review.id));
      assert.equal(g.outgoing.size, 1);
      assert.equal(g.statusOffer().relayAttempts, 1);
      assert.equal(g.statusOffer().relayObservation, null);
      assert.deepEqual([...g.outgoing.values()][0]!.envelope, g.offer.envelope);
    } finally {
      g.close();
    }
  }
});

test("expiry while saving the offer attempt rolls back before any upload", async () => {
  const g = await fixture();
  const original = g.e.vault.seal.bind(g.e.vault);
  try {
    const r = await g.prepare(),
      before = g.statusOffer();
    g.e.vault.seal = (value, aad) => {
      const sealed = original(value, aad);
      if ((value as any)?.relay?.attempts === 1) g.f.advance(300000);
      return sealed;
    };
    await assert.rejects(g.confirm(r.id), /DENIED/);
    const after = g.statusOffer();
    assert.equal(after.revision, before.revision);
    assert.equal(after.relayAttempts, 0);
    assert.equal(after.relayObservation, null);
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.e.vault.seal = original;
    g.close();
  }
});

test("local authenticated offer review and confirmation routes can submit only the exact selected offer", async () => {
  const g = await fixture(),
    server = createServer(),
    token = randomBytes(32).toString("base64url");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const post = (path: string, body: unknown, credential = token) =>
    fetch(`http://127.0.0.1:${port}/v1/private-conversation-offers/${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    server.on(
      "request",
      localApi({
        store: g.e.store,
        owner: g.e.owner,
        token,
        port,
        privateKeys: g.e.controls,
        privateRelay: g.relay,
      }),
    );
    assert.equal((await post("review", g.input(), "wrong")).status, 401);
    const reviewed = await post("review", g.input());
    assert.equal(reviewed.status, 200);
    const review = await reviewed.json();
    assert.equal(g.outgoing.size, 0);
    const denied = await post("confirm", {
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
      envelope: g.offer.envelope,
    });
    assert.equal(denied.status, 400);
    assert.equal(g.outgoing.size, 0);
    const again = await (await post("review", g.input())).json();
    const sent = await post("confirm", {
      reviewId: again.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(sent.status, 200);
    const value = await sent.json();
    assert.equal(value.envelope, null);
    assert.equal(value.transport.transportOnly, true);
    assert.equal(g.outgoing.size, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    g.close();
  }
});

test("offer changes during relay lookup invalidate the prepared review", async () => {
  const g = await fixture();
  try {
    g.control.beforeRecipient = async () => {
      g.e.store.db
        .prepare(
          "UPDATE private_conversation_offers SET revision=revision+1,locked=1 WHERE id=?",
        )
        .run(g.offer.offer.id);
    };
    await assert.rejects(g.prepare(), /CONFLICT/);
    assert.equal(g.statusOffer().relayAttempts, 0);
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.close();
  }
});

test("receipt save failure preserves the committed attempt and explicit retry recovers the exact stored offer", async () => {
  for (const mode of ["write-error", "expiry"] as const) {
    const g = await fixture(),
      original = g.e.vault.seal.bind(g.e.vault);
    try {
      const r = await g.prepare();
      g.e.vault.seal = (value, aad) => {
        const sealed = original(value, aad);
        if ((value as any)?.relay?.observation) {
          if (mode === "write-error")
            throw Error("synthetic receipt persistence failure");
          g.f.advance(300000);
        }
        return sealed;
      };
      await assert.rejects(g.confirm(r.id));
      assert.equal(g.statusOffer().relayAttempts, 1);
      assert.equal(g.statusOffer().relayObservation, null);
      assert.equal(g.outgoing.size, 1);
      g.e.vault.seal = original;
      if (mode === "write-error") {
        const retried = await g.confirm((await g.prepare()).id);
        assert.ok("transport" in retried);
        assert.equal(retried.transport.duplicate, true);
        assert.equal(retried.offer.relayAttempts, 2);
        assert.equal(retried.offer.relayObservation?.attempt, 2);
        assert.equal(g.outgoing.size, 1);
      } else await assert.rejects(g.prepare(), /DENIED/);
    } finally {
      g.e.vault.seal = original;
      g.close();
    }
  }
});

test("an uncertain retry retains the last confirmed server observation as older history", async () => {
  const g = await fixture();
  try {
    const first = await g.confirm((await g.prepare()).id);
    g.control.loseSubmit = true;
    await assert.rejects(g.confirm((await g.prepare()).id));
    assert.equal(g.statusOffer().relayAttempts, 2);
    assert.equal(g.statusOffer().relayObservation?.attempt, 1);
    assert.deepEqual(
      g.statusOffer().relayObservation,
      first.offer.relayObservation,
    );
    g.reopen();
    assert.equal(g.statusOffer().relayAttempts, 2);
    assert.deepEqual(
      g.statusOffer().relayObservation,
      first.offer.relayObservation,
    );
  } finally {
    g.close();
  }
});
