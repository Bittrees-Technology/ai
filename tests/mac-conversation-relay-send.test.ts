import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { localApi } from "../apps/companion/http.js";
import { macConversationRelayFixture } from "./helpers/mac-conversation-relay.js";
import { privateRelayEnvelopeHash } from "../modules/remote/private-relay-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";

async function fixture(incoming = false) {
  const g = await macConversationRelayFixture(true);
  try {
    const permissionId = g.consent.grants[0]!.id;
    let id: string;
    if (incoming) {
      id = randomUUID();
      const content = {
        version: 1,
        type: "conversation.message",
        id,
        parentId: null,
        content: "SYNTHETIC_INCOMING_CONTENT",
        scope: {
          permissionId,
          conversationRef: g.e.store.exportPrivateConversationConsent(g.e.owner)
            .grants[0]!.conversationRef,
        },
      };
      const envelope = await g.f.a.remote.withVerifiedDevice((sender) =>
        g.e.remote.withVerifiedDevice(async (recipient) => {
          const a = await g.f.a.keys(sender.current).resolve(),
            b = await g.e.keys(recipient.current).resolve();
          return sealPrivateEnvelope(
            {
              version: 1,
              suite: privateEnvelopeSuite,
              ownerId: g.e.grant.ownerId,
              senderId: g.f.a.grant.deviceId,
              recipientId: g.e.grant.deviceId,
              senderKeyEpoch: 1,
              recipientKeyEpoch: 1,
              operationId: id,
              messageId: randomUUID(),
              sequence: 1000,
              issuedAt: g.f.clock(),
              expiresAt: g.f.clock() + 60000,
            },
            new TextEncoder().encode(JSON.stringify(content)),
            { senderKey: a.pair, recipientPublicKey: b.pair.publicKey },
            g.f.clock,
          );
        }),
      );
      await g.e.controls.receiveConversationContent({
        permissionId,
        envelope,
        confirmed: true,
      });
    } else {
      id = randomUUID();
      const local = g.e.store.messages(
        g.e.owner,
        g.inbox.id,
        g.conversationId,
      )[0]!;
      await g.e.controls.prepareConversationContent({
        id,
        permissionId,
        expectedConsentRevision: g.consent.revision,
        localMessageId: local.id,
        parentId: null,
        kind: "message",
        expiresAt: g.f.clock() + 60000,
        confirmed: true,
      });
    }
    const status = () =>
      g.e.controls.conversationContentStatus().items.find((e) => e.id === id)!;
    const sealed = await g.e.controls.conversationContentEnvelope({
      id,
      permissionId,
      expectedRevision: status().revision,
      confirmed: true,
    });
    const input = () => ({
      action: "send",
      id,
      permissionId,
      expectedRevision: status().revision,
      connection: { ...g.input().connection },
    });
    const prepare = (raw: unknown = input()) =>
      g.e.controls.prepareConversationRelay(raw, g.relay);
    const confirm = (reviewId: string) =>
      g.e.controls.confirmConversationRelay(
        { reviewId, confirmed: true, acknowledged: true },
        g.relay,
      );
    return {
      ...g,
      id,
      permissionId,
      sealed: sealed.envelope,
      status,
      contentInput: input,
      prepareContent: prepare,
      confirmContent: confirm,
    };
  } catch (error) {
    g.close();
    throw error;
  }
}

test("reviewed Mac content upload records server storage without claiming recipient acceptance", async () => {
  for (const incoming of [false, true]) {
    const f = await fixture(incoming);
    try {
      const before = f.e.controls.conversationPermissionStatus(),
        review = await f.prepareContent();
      assert.equal(f.outgoing.size, 0);
      assert.equal(review.transportOnly, true);
      assert.equal(review.entry.id, f.id);
      assert.equal(review.entry.recipientAccepted, false);
      const sent = await f.confirmContent(review.id);
      assert.ok("transport" in sent);
      assert.equal(sent.transport.transportOnly, true);
      assert.equal(sent.entry.relayAttempts, 1);
      assert.equal(sent.entry.recipientAccepted, false);
      assert.equal(sent.entry.relayObservation?.receipt.state, "stored");
      assert.deepEqual([...f.outgoing.values()][0]!.envelope, f.sealed);
      const opened = await f.f.open(f.sealed);
      assert.equal(
        opened.type,
        incoming ? "conversation.received" : "conversation.message",
      );
      assert.doesNotMatch(
        JSON.stringify({ review, sent }),
        /PRIVATE_NEVER_IN_OFFER|SYNTHETIC_INCOMING_CONTENT|ciphertext|privateKey|"credential":/,
      );
      assert.deepEqual(f.e.controls.conversationPermissionStatus(), before);
      await assert.rejects(f.confirmContent(review.id), /DENIED/);
    } finally {
      f.close();
    }
  }
});

test("lost content upload response survives reopen and explicit retry keeps original ciphertext and sequence", async () => {
  const f = await fixture();
  try {
    const review = await f.prepareContent(),
      stale = f.contentInput();
    f.control.loseSubmit = true;
    await assert.rejects(f.confirmContent(review.id));
    assert.equal(f.outgoing.size, 1);
    assert.equal(f.status().relayAttempts, 1);
    assert.equal(f.status().relayObservation, null);
    const wire = structuredClone([...f.outgoing.values()][0]);
    f.reopen();
    f.control.loseSubmit = false;
    await assert.rejects(f.prepareContent(stale), /CONFLICT/);
    const result = await f.confirmContent((await f.prepareContent()).id);
    assert.ok("transport" in result);
    assert.equal(result.transport.duplicate, true);
    assert.equal(result.entry.relayAttempts, 2);
    assert.deepEqual([...f.outgoing.values()][0], wire);
    assert.equal(f.outgoing.size, 1);
  } finally {
    f.close();
  }
});

test("content review binds destination, connection, original revision and expiry without extending ciphertext", async () => {
  const f = await fixture();
  try {
    const before = f.status();
    f.control.recipientExpiresAt = before.expiresAt - 1;
    await assert.rejects(f.prepareContent(), /DENIED/);
    f.control.recipientExpiresAt = f.f.clock() + 1800000;
    const review = await f.prepareContent();
    f.control.recipientExpiresAt -= 1;
    await assert.rejects(f.confirmContent(review.id), /CONFLICT/);
    assert.deepEqual(f.status(), before);
    assert.equal(f.outgoing.size, 0);
    const again = await f.prepareContent();
    f.f.advance(60000);
    await assert.rejects(f.confirmContent(again.id), /DENIED/);
    assert.equal(f.status().relayAttempts, 0);
  } finally {
    f.close();
  }
});

test("cancelled or revoked content reviews cannot upload and stopping remains local", async () => {
  const f = await fixture();
  try {
    const review = await f.prepareContent();
    f.e.controls.invalidate();
    await assert.rejects(f.confirmContent(review.id), /DENIED/);
    const grant = await f.e.controls.prepareConversationPermission({
      action: "revoke",
      expectedRevision: f.consent.revision,
      permissionId: f.permissionId,
    });
    await f.e.controls.confirmConversationPermission({
      reviewId: grant.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(f.prepareContent(), /DENIED/);
    const calls = f.control.calls.length;
    const stop = await f.prepareContent({
      action: "stop",
      id: f.id,
      permissionId: f.permissionId,
      expectedRevision: f.status().revision,
    });
    const stopped = await f.confirmContent(stop.id);
    assert.equal(stopped.entry.relayStopped, true);
    assert.equal(f.control.calls.length, calls);
    assert.equal(f.outgoing.size, 0);
    await assert.rejects(f.prepareContent(), /DENIED/);
  } finally {
    f.close();
  }
});

test("late logout, invalid observations and original deletion leave uncertain attempts without storage claims", async () => {
  for (const mode of ["logout", "wrong-receipt", "deleted-original"] as const) {
    const f = await fixture();
    try {
      const review = await f.prepareContent();
      f.control.afterSubmit = async () => {
        if (mode === "logout") f.e.controls.invalidate();
        if (mode === "wrong-receipt")
          [...f.outgoing.values()][0]!.receipt.envelopeHash = "a".repeat(64);
        if (mode === "deleted-original")
          f.e.store.db
            .prepare("DELETE FROM messages WHERE id=?")
            .run(f.status().localMessageId);
      };
      await assert.rejects(f.confirmContent(review.id));
      assert.equal(f.outgoing.size, 1);
      assert.equal(f.status().relayAttempts, 1);
      assert.equal(f.status().relayObservation, null);
      assert.equal(f.status().recipientAccepted, false);
      assert.deepEqual([...f.outgoing.values()][0]!.envelope, f.sealed);
    } finally {
      f.close();
    }
  }
});

test("expiry during durable attempt sealing rolls back before network upload", async () => {
  const f = await fixture(),
    original = f.e.vault.seal.bind(f.e.vault);
  try {
    const review = await f.prepareContent(),
      before = f.status();
    f.e.vault.seal = (value, aad) => {
      const sealed = original(value, aad);
      if ((value as any)?.relay?.attempts === 1) f.f.advance(60000);
      return sealed;
    };
    await assert.rejects(f.confirmContent(review.id));
    assert.deepEqual(f.status(), before);
    assert.equal(f.outgoing.size, 0);
  } finally {
    f.e.vault.seal = original;
    f.close();
  }
});

test("authenticated local content relay routes require separate review and reject injected envelope authority", async () => {
  const f = await fixture(),
    server = createServer(),
    token = randomBytes(32).toString("base64url");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: f.e.store,
      owner: f.e.owner,
      privateKeys: f.e.controls,
      privateRelay: f.relay,
      token,
      port,
    }),
  );
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(
      `http://127.0.0.1:${port}/v1/private-conversation-content/relay-${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      },
    );
  try {
    assert.equal(
      (
        await post("review", f.contentInput(), {
          Authorization: "Bearer wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("review", f.contentInput(), {
          Origin: "https://untrusted.invalid",
        })
      ).status,
      403,
    );
    const r = await post("review", f.contentInput());
    assert.equal(r.status, 200);
    const review = await r.json();
    assert.equal(f.outgoing.size, 0);
    assert.equal(
      (
        await post("confirm", {
          reviewId: review.id,
          confirmed: true,
          acknowledged: true,
          envelope: f.sealed,
        })
      ).status,
      400,
    );
    const next = await (await post("review", f.contentInput())).json();
    const sent = await post("confirm", {
      reviewId: next.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).transport.transportOnly, true);
    assert.equal(
      [...f.outgoing.values()][0]!.receipt.envelopeHash,
      await privateRelayEnvelopeHash(f.sealed),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("source loss during asynchronous upload hashing prevents the network submission", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  try {
    const review = await f.prepareContent();
    let removed = false;
    crypto.subtle.digest = async (
      ...args: Parameters<SubtleCrypto["digest"]>
    ) => {
      if (!removed && f.status().relayAttempts === 1) {
        removed = true;
        f.e.store.db
          .prepare("DELETE FROM messages WHERE id=?")
          .run(f.status().localMessageId);
      }
      return digest(...args);
    };
    await assert.rejects(f.confirmContent(review.id));
    assert.equal(removed, true);
    assert.equal(f.outgoing.size, 0);
    assert.equal(f.status().relayAttempts, 1);
    assert.equal(f.status().relayObservation, null);
  } finally {
    crypto.subtle.digest = digest;
    f.close();
  }
});
