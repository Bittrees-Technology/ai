import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { macConversationDeliveryFixture as fixture } from "./helpers/mac-conversation-delivery-ui.js";
const ackCount = (g: Awaited<ReturnType<typeof fixture>>) =>
  g.control.calls.filter((x) => x === "relay/messages/acknowledge").length;
async function inspect(
  g: Awaited<ReturnType<typeof fixture>>,
  c = g.controller(),
) {
  await c.refresh();
  await c.refreshConnections();
  await c.inspectIncoming(g.input().connection.id);
  assert.equal(c.error, "");
  return c;
}
test("Mac incoming controls inspect metadata and explicitly save one authenticated message before separate receipt upload", async () => {
  const g = await fixture();
  try {
    const wire = await g.envelope(g.incomingMessage());
    await g.queueEnvelope(wire);
    const c = await inspect(g);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
    assert.ok(
      !JSON.stringify(c.queue).includes("SYNTHETIC_RELAY_CONVERSATION"),
    );
    await c.reviewIncoming(g.permissionId);
    assert.equal(c.review?.action, "receive");
    assert.equal(g.messages().length, 1);
    await c.confirm(false, () => true);
    assert.equal(ackCount(g), 0);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.match(c.notice, /saved on this Mac/);
    assert.equal(g.messages().length, 2);
    assert.equal(ackCount(g), 1);
    assert.equal(g.outgoing.size, 0);
    const item = c.items()[0]!;
    await c.prepareReceipt(item.id, g.permissionId);
    assert.equal(c.review?.action, "receipt");
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(c.items()[0]!.receiptPrepared, true);
    assert.equal(g.outgoing.size, 0);
    await c.refreshConnections();
    await c.relay(item.id, g.permissionId, "send", g.input().connection.id);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(g.outgoing.size, 1);
    assert.notDeepEqual([...g.outgoing.values()][0]!.envelope, wire);
    assert.equal(c.items()[0]!.direction, "incoming");
    assert.equal(c.items()[0]!.localMessageId, g.messages()[1]!.id);
  } finally {
    await g.close();
  }
});
test("Mac incoming controls recover a lost acknowledgement through a new review without duplicate content", async () => {
  for (const afterSave of [false, true]) {
    const g = await fixture();
    try {
      await g.queueEnvelope(await g.envelope(g.incomingMessage()));
      let c = await inspect(g);
      await c.reviewIncoming(g.permissionId);
      g.control.loseAck = true;
      g.control.ackAfterSave = afterSave;
      await c.confirm(true, () => true);
      assert.match(c.error, /No automatic retry/);
      assert.equal(g.messages().length, 2);
      assert.equal(c.review, null);
      g.control.loseAck = false;
      c.dispose();
      c = await inspect(g);
      assert.equal(c.items().length, 1);
      if (afterSave) assert.equal(c.queue?.item, null);
      else {
        await c.reviewIncoming(g.permissionId);
        await c.confirm(true, () => true);
        assert.equal(c.error, "");
      }
      assert.equal(g.messages().length, 2);
      assert.equal(g.outgoing.size, 0);
    } finally {
      await g.close();
    }
  }
});
test("Mac incoming controls leave missing parents queued and allow explicit navigation and later receipt", async () => {
  const g = await fixture();
  try {
    const parent = g.incomingMessage(),
      child = g.incomingMessage(parent.id),
      wire = await g.envelope(child);
    await g.queueEnvelope(wire);
    const c = await inspect(g);
    await c.reviewIncoming(g.permissionId);
    await c.confirm(true, () => true);
    assert.match(c.error, /earlier message first/);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
    await inspect(g, c);
    await c.inspectIncoming(g.input().connection.id, true);
    assert.equal(c.queue?.item, null);
    assert.equal(ackCount(g), 0);
    await g.queueEnvelope(await g.envelope(parent));
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    await g.queueEnvelope(wire);
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(g.messages().length, 3);
    assert.equal(g.messages()[2]!.input.replyToId, g.messages()[1]!.id);
  } finally {
    await g.close();
  }
});
test("Mac browser receipt review selects the exact outgoing original and retries durable lost acknowledgement", async () => {
  const g = await fixture();
  try {
    const c = g.controller();
    await g.prepare(c);
    const first = c.items()[0]!;
    const second = g.e.store.appendMessage(
      g.e.owner,
      { ...g.message.input, content: "SECOND_COPY" },
      randomUUID(),
    );
    await g.prepare(c, second.id);
    const secondCopy = c.items().find((e) => e.localMessageId === second.id)!;
    const receipt = await g.envelope({
      version: 1,
      type: "conversation.received",
      scope: g.scope,
      operationId: first.id,
      acceptedId: first.id,
      acceptedType: first.kind,
      acceptedAt: g.f.clock(),
    });
    await g.queueEnvelope(receipt);
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId, secondCopy.id);
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(ackCount(g), 0);
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId, first.id);
    assert.equal(c.review?.message?.input.content, g.message.input.content);
    g.control.loseAck = true;
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(g.messages().length, 2);
    g.control.loseAck = false;
    await inspect(g, c);
    assert.equal(
      c.items().find((e) => e.id === first.id)?.recipientAccepted,
      true,
    );
    await c.reviewIncoming(g.permissionId, first.id);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.match(c.notice, /Browser storage receipt authenticated/);
    assert.equal(g.messages().length, 2);
  } finally {
    await g.close();
  }
});
test("Mac incoming review rechecks authority, clears on focus loss and refuses an expired confirmation", async () => {
  const g = await fixture();
  try {
    await g.queueEnvelope(await g.envelope(g.incomingMessage()));
    let wall = Date.now(),
      mono = 0;
    const c = g.controller(
      undefined,
      () => wall,
      () => mono,
    );
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    c.hide();
    await c.confirm(true, () => true);
    assert.equal(g.messages().length, 1);
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    mono = 120001;
    c.expire();
    assert.equal(c.review, null);
    await c.confirm(true, () => true);
    assert.equal(ackCount(g), 0);
    mono = 0;
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    g.e.deny();
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
  } finally {
    await g.close();
  }
});
test("Mac incoming selection cannot be silently replaced between inspection and confirmation", async () => {
  const g = await fixture();
  try {
    await g.queueEnvelope(await g.envelope(g.incomingMessage()));
    const c = await inspect(g);
    await c.reviewIncoming(g.permissionId);
    await g.queueEnvelope(await g.envelope(g.incomingMessage()));
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
  } finally {
    await g.close();
  }
});
test("Mac incoming answer controls use an actual worker question and resume once while ordinary replies leave it waiting", async () => {
  const g = await fixture(true);
  try {
    const q = await g.question(),
      c = g.controller();
    await g.prepare(c, q.wait.questionId);
    const copy = c.items()[0]!;
    await g.queueEnvelope(await g.envelope(g.incomingMessage(copy.id)));
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(g.e.store.get(g.e.owner, q.task.id).status, "awaiting_input");
    const content = g.e.store
      .exportPrivateConversationContent(g.e.owner)
      .find((e) => e.value.content.id === copy.id)!.value.content;
    if (content.type !== "conversation.question")
      throw Error("Expected question");
    await g.queueEnvelope(
      await g.envelope({
        version: 1,
        type: "conversation.answer",
        scope: g.scope,
        id: randomUUID(),
        taskId: q.task.id,
        questionId: copy.id,
        expectedRevision: content.taskRevision,
        content: "Lisbon",
        confirmed: true,
      }),
    );
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId);
    await c.confirm(true, () => true);
    assert.equal(c.error, "");
    assert.equal(g.e.store.get(g.e.owner, q.task.id).status, "queued");
    await q.run();
    assert.equal(g.e.store.get(g.e.owner, q.task.id).status, "completed");
    assert.equal(q.calls(), 3);
    await q.run();
    assert.equal(q.calls(), 3);
  } finally {
    await g.close();
  }
});

test("Mac incoming receipt review rejects a copy changed after review and hides cancelled late inspection", async () => {
  const g = await fixture();
  try {
    const c = g.controller();
    await g.prepare(c);
    const copy = c.items()[0]!;
    await g.queueEnvelope(
      await g.envelope({
        version: 1,
        type: "conversation.received",
        scope: g.scope,
        operationId: copy.id,
        acceptedId: copy.id,
        acceptedType: copy.kind,
        acceptedAt: g.f.clock(),
      }),
    );
    await inspect(g, c);
    await c.reviewIncoming(g.permissionId, copy.id);
    const stopped = await g.e.controls.prepareConversationRelay(
      {
        action: "stop",
        id: copy.id,
        permissionId: g.permissionId,
        expectedRevision: copy.revision,
      },
      g.relay,
    );
    await g.e.controls.confirmConversationRelay(
      { reviewId: stopped.id, confirmed: true, acknowledged: true },
      g.relay,
    );
    await c.confirm(true, () => true);
    assert.match(c.error, /No automatic retry/);
    assert.equal(ackCount(g), 0);
    await c.refresh();
    await c.refreshConnections();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (release = r));
    g.control.beforePoll = async () => {
      entered();
      await held;
    };
    const pending = c.inspectIncoming(g.input().connection.id);
    await started;
    c.hide();
    release();
    await pending;
    assert.equal(c.queue, null);
    assert.equal(c.review, null);
    assert.equal(c.status, null);
    assert.equal(ackCount(g), 0);
  } finally {
    await g.close();
  }
});
