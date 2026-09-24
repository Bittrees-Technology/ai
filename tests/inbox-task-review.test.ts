import test from "node:test";
import assert from "node:assert/strict";
import { InboxTaskReview } from "../apps/dashboard/inbox-task-review-state.js";
import {
  InboxMessageController,
  type InboxMessage,
} from "../apps/dashboard/inbox-message-state.js";
const message: InboxMessage = {
  id: "question",
  sequence: 1,
  createdAt: 1000,
  receipts: [],
  input: {
    conversationId: "thread",
    recipientInboxId: "personal",
    requestId: "task",
    content: "SOURCE_SENTINEL",
    replyExpected: true,
  },
};
test("incremental inbox paging never retains task-linked plaintext", async () => {
  let calls = 0;
  const c = new InboxMessageController(async (path) =>
    path === "/v1/checkins"
      ? { items: [] }
      : { items: ++calls === 1 ? [message] : [] },
  );
  c.select("personal", "thread");
  await c.load();
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0]!.input.content, "Task-linked message");
  await c.load();
  assert.doesNotMatch(JSON.stringify(c.messages), /SOURCE_SENTINEL/);
  c.saved({ ...message, id: "reply" });
  assert.doesNotMatch(JSON.stringify(c.messages), /SOURCE_SENTINEL/);
});
test("task text opens only from a fresh exact-message read and expires on both clocks", async () => {
  let wall = 1000,
    mono = 10,
    calls = 0;
  const r = new InboxTaskReview(
    async (path) => {
      assert.equal(path, "/v1/messages/question");
      calls++;
      return message;
    },
    () => {},
    () => wall,
    () => mono,
  );
  await r.read(message, () => true);
  assert.equal(r.content, "SOURCE_SENTINEL");
  mono += 15000;
  r.expire();
  assert.equal(r.content, null);
  await r.read(message, () => true);
  wall--;
  r.expire();
  assert.equal(r.content, null);
  await r.read(message, () => true);
  wall += 15000;
  r.expire();
  assert.equal(r.content, null);
  assert.equal(calls, 3);
});
test("blur, conversation disposal and expiry discard late source text and denied reads clear prior content", async () => {
  let resolve!: (m: InboxMessage) => void;
  const r = new InboxTaskReview(
    () =>
      new Promise((res) => {
        resolve = res;
      }),
  );
  const pending = r.read(message, () => true);
  r.clear();
  resolve(message);
  await pending;
  assert.equal(r.content, null);
  let allow = true;
  const r2 = new InboxTaskReview(async () => {
    if (!allow) throw Error("PRIVATE_ERROR");
    return message;
  });
  await r2.read(message, () => true);
  assert.equal(r2.content, "SOURCE_SENTINEL");
  allow = false;
  await assert.rejects(
    r2.read(message, () => true),
    /Task message could not be opened/,
  );
  assert.equal(r2.content, null);
  let now = 1000;
  const r3 = new InboxTaskReview(
    () =>
      new Promise((res) => {
        resolve = res;
      }),
    () => {},
    () => now,
    () => now,
  );
  const late = r3.read(message, () => true);
  now += 15000;
  resolve(message);
  await late;
  assert.equal(r3.content, null);
});
test("mismatched identity, unavailable task and lost focus never publish text", async () => {
  for (const changed of [
    { id: "other" },
    { input: { ...message.input, requestId: "other" } },
    { input: { ...message.input, conversationId: "other" } },
    { input: { ...message.input, recipientInboxId: "other" } },
    { taskAccess: "unavailable" as const },
  ]) {
    const r = new InboxTaskReview(async () => ({ ...message, ...changed }));
    await assert.rejects(r.read(message, () => true));
    assert.equal(r.content, null);
  }
  let focused = true;
  const r = new InboxTaskReview(async () => {
    focused = false;
    return message;
  });
  await r.read(message, () => focused);
  assert.equal(r.content, null);
});
