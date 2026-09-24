import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conversationCopyId } from "../apps/dashboard/conversation-content-state.js";
import { macConversationDeliveryFixture } from "./helpers/mac-conversation-delivery-ui.js";
const sendReview = async (
  g: Awaited<ReturnType<typeof macConversationDeliveryFixture>>,
  c: ReturnType<typeof g.controller>,
) => {
  await c.refreshConnections();
  const e = c.items()[0]!;
  await c.relay(e.id, e.permissionId, "send", g.input().connection.id);
};
test("Mac delivery panel prepares from fresh HTTP source then separately uploads and stops the exact copy", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    const c = g.controller();
    await c.refresh();
    await c.prepare(g.message.id, g.permissionId);
    assert.equal(c.review?.message?.input.content, "PRIVATE_NEVER_IN_OFFER");
    assert.equal(g.outgoing.size, 0);
    assert.equal(g.e.controls.conversationContentStatus().items.length, 0);
    await c.confirm(false, () => true);
    assert.ok(c.review);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.match(c.notice, /prepared/);
    assert.equal(g.outgoing.size, 0);
    assert.equal(c.items()[0]!.state, "ready");
    const original = g.e.store.exportPrivateConversationContent(g.e.owner)[0]!
      .value.envelope;
    await sendReview(g, c);
    assert.equal(c.review?.action, "send");
    assert.equal(g.outgoing.size, 0);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(c.items()[0]!.relayAttempts, 1);
    assert.equal(c.items()[0]!.recipientAccepted, false);
    assert.deepEqual([...g.outgoing.values()][0]!.envelope, original);
    const e = c.items()[0]!;
    g.e.deny();
    await c.relay(e.id, e.permissionId, "stop");
    assert.equal(c.review?.action, "stop");
    await c.confirm(true, () => true);
    assert.equal(c.items()[0]!.relayStopped, true);
    assert.equal(g.outgoing.size, 1);
  } finally {
    await g.close();
  }
});
test("uncertain preparation is inspected and resumed with the original identity; fresh controller derives same ID", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    let lose = true;
    const c = g.controller(async (p, m, b) => {
      const result = await g.api(p, m, b);
      if (p.endsWith("/prepare") && lose) {
        lose = false;
        throw Error("lost");
      }
      return result;
    });
    await g.prepare(c);
    assert.match(c.error, /No automatic retry/);
    assert.equal(g.calls.filter((v) => v.path.endsWith("/envelope")).length, 0);
    const original = g.e.controls.conversationContentStatus().items[0]!;
    assert.equal(original.state, "preparing");
    assert.equal(
      original.id,
      await conversationCopyId(g.permissionId, g.message.id),
    );
    const reopened = g.controller();
    await reopened.refresh();
    await reopened.prepare(g.message.id, g.permissionId);
    assert.match(reopened.notice, /already retained/);
    assert.equal(Boolean(reopened.review), false);
    await reopened.prepare(g.message.id, g.permissionId, original.id);
    assert.equal(reopened.review?.action, "seal");
    await reopened.confirm(true, () => true);
    assert.equal(reopened.error, "");
    assert.equal(reopened.items()[0]!.id, original.id);
    assert.equal(reopened.items()[0]!.state, "ready");
  } finally {
    await g.close();
  }
});
test("lost relay response retains one upload; explicit retry reuses ciphertext without recipient acceptance", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    const c = g.controller();
    await g.prepare(c);
    await sendReview(g, c);
    g.control.loseSubmit = true;
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(g.outgoing.size, 1);
    const wire = [...g.outgoing.values()][0]!.envelope;
    g.control.loseSubmit = false;
    await c.refresh();
    assert.equal(c.items()[0]!.relayAttempts, 1);
    assert.equal(c.items()[0]!.relayObservation, null);
    await sendReview(g, c);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(c.items()[0]!.relayAttempts, 2);
    assert.equal(c.items()[0]!.recipientAccepted, false);
    assert.deepEqual([...g.outgoing.values()][0]!.envelope, wire);
    assert.equal(g.outgoing.size, 1);
  } finally {
    await g.close();
  }
});
test("focus loss or selected scope loss suppresses a late source review and all preparation effects", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    let release!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const c = g.controller(async (p, m, b) => {
      const v = await g.api(p, m, b);
      if (p === "/v1/messages/" + g.message.id) {
        started();
        await gate;
      }
      return v;
    });
    await c.refresh();
    const pending = c.prepare(g.message.id, g.permissionId);
    await began;
    c.hide();
    release();
    await pending;
    assert.equal(c.review, null);
    assert.equal(c.status, null);
    assert.equal(g.e.controls.conversationContentStatus().items.length, 0);
  } finally {
    await g.close();
  }
});
test("source changes or failed access between preview and confirmation cannot prepare a copy", async () => {
  for (const mode of ["changed", "unavailable"]) {
    const g = await macConversationDeliveryFixture();
    try {
      let reads = 0;
      const c = g.controller(async (p, m, b) => {
        const v: any = await g.api(p, m, b);
        if (p === "/v1/messages/" + g.message.id && ++reads === 2) {
          if (mode === "changed") v.input.content = "CHANGED";
          else v.taskAccess = "unavailable";
        }
        return v;
      });
      await g.prepare(c);
      assert.match(c.error, /could not be confirmed/);
      assert.equal(g.e.controls.conversationContentStatus().items.length, 0);
    } finally {
      await g.close();
    }
  }
});
test("monotonic expiry and backwards wall clock remove review and block preparation", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    let now = Date.now(),
      mono = 100;
    const c = g.controller(
      undefined,
      () => now,
      () => mono,
    );
    await c.refresh();
    await c.prepare(g.message.id, g.permissionId);
    assert.ok(c.review);
    mono += 15001;
    await c.confirm(true, () => true);
    assert.equal(c.review, null);
    assert.equal(g.e.controls.conversationContentStatus().items.length, 0);
    mono = 20000;
    await c.prepare(g.message.id, g.permissionId);
    assert.ok(c.review);
    now -= 1;
    c.expire();
    assert.equal(c.review, null);
  } finally {
    await g.close();
  }
});
test("changed relay recipient or fabricated acceptance result cannot display confirmed upload", async () => {
  for (const mode of ["recipient", "acceptance"]) {
    const g = await macConversationDeliveryFixture();
    try {
      const c = g.controller(async (p, m, b) => {
        const v: any = await g.api(p, m, b);
        if (mode === "recipient" && p.endsWith("/relay-review"))
          v.relayRecipient.endpointId = randomUUID();
        if (mode === "acceptance" && p.endsWith("/relay-confirm"))
          v.entry.recipientAccepted = true;
        return v;
      });
      await g.prepare(c);
      await sendReview(g, c);
      if (mode === "recipient") {
        assert.equal(c.review, null);
        assert.equal(g.outgoing.size, 0);
      } else await c.confirm(true, () => true);
      assert.match(c.error, /could not be confirmed/);
      assert.equal(c.status, null);
    } finally {
      await g.close();
    }
  }
});
test("reply preparation requires a retained parent and preserves exact parent identity", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    const reply = g.e.store.appendMessage(
      g.e.owner,
      {
        conversationId: g.conversationId,
        recipientInboxId: g.inbox.id,
        type: "reply",
        content: "SYNTHETIC_REPLY",
        replyToId: g.message.id,
      },
      randomUUID(),
    );
    const c = g.controller();
    await c.refresh();
    await c.prepare(reply.id, g.permissionId);
    assert.match(c.error, /could not be confirmed/);
    assert.equal(g.e.controls.conversationContentStatus().items.length, 0);
    await g.prepare(c);
    const parent = c.items()[0]!;
    await c.prepare(reply.id, g.permissionId);
    assert.equal(c.review?.request?.parentId, parent.id);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(c.items().length, 2);
  } finally {
    await g.close();
  }
});
test("real worker question review preserves exact wait and cannot run or answer work", async () => {
  const g = await macConversationDeliveryFixture(true);
  try {
    const { task, wait } = await g.question();
    const c = g.controller();
    await c.refresh();
    await c.prepare(wait.questionId, g.permissionId);
    assert.equal(c.error, "");
    assert.equal(c.review?.question?.taskId, task.id);
    assert.equal(c.review?.request?.kind, "question");
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(c.items()[0]!.kind, "conversation.question");
    assert.equal(g.e.store.get(g.e.owner, task.id).status, "awaiting_input");
    assert.equal(
      g.e.store.inputWaitHistory(g.e.owner, task.id)[0]!.replyId,
      null,
    );
  } finally {
    await g.close();
  }
});

test("incoming history uploads only the prepared original receipt and preserves local content", async () => {
  const g = await macConversationDeliveryFixture();
  try {
    const receipt = await g.incomingReceipt(),
      before = g.e.store.messages(g.e.owner, g.inbox.id, g.conversationId);
    const c = g.controller();
    await c.refresh();
    assert.equal(c.items()[0]!.direction, "incoming");
    assert.equal(c.items()[0]!.receiptPrepared, true);
    await sendReview(g, c);
    assert.equal(c.review?.entry?.direction, "incoming");
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.deepEqual([...g.outgoing.values()][0]!.envelope, receipt.envelope);
    assert.deepEqual(
      g.e.store.messages(g.e.owner, g.inbox.id, g.conversationId),
      before,
    );
    assert.equal(c.items()[0]!.recipientAccepted, false);
  } finally {
    await g.close();
  }
});
