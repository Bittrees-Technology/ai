import test from "node:test";
import assert from "node:assert/strict";
import {
  InboxMessageController,
  type InboxMessage,
} from "../apps/dashboard/inbox-message-state.js";
const message = (sequence: number, conversationId = "a"): InboxMessage => ({
  id: conversationId + sequence,
  sequence,
  createdAt: 1000,
  receipts: [],
  input: {
    recipientInboxId: "personal",
    conversationId,
    content: "synthetic " + sequence,
    replyExpected: false,
  },
});
test("manual message paging rejects delayed pages and errors after conversation changes", async () => {
  const pending: {
    path: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  const c = new InboxMessageController(
    (path) =>
      new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  );
  c.select("personal", "a");
  const first = c.load(true);
  c.select("personal", "b");
  const second = c.load();
  pending[0]!.resolve({ items: [message(1)] });
  pending[1]!.resolve({ items: [{ message_id: "a1", status: "open" }] });
  await first;
  assert.equal(c.messages.length, 0);
  assert.equal(c.busy, true);
  pending[2]!.resolve({ items: [message(1, "b")] });
  pending[3]!.resolve({ items: [] });
  await second;
  assert.deepEqual(
    c.messages.map((m) => m.id),
    ["b1"],
  );
  const late = c.load(true);
  c.select();
  pending[4]!.reject(Error("old private error"));
  pending[5]!.resolve({ items: [] });
  await late;
  assert.equal(c.messages.length, 0);
  assert.equal(c.more, false);
});
test("polling and manual paging share one cursor, preserve saved messages/receipts and keep check-ins current", async () => {
  let messageCalls = 0,
    checkCalls = 0,
    release!: () => void;
  const c = new InboxMessageController(async (path) => {
    if (path === "/v1/checkins") {
      checkCalls++;
      return { items: [{ message_id: "a1", status: "acknowledged" }] };
    }
    messageCalls++;
    if (messageCalls === 1) {
      await new Promise<void>((r) => (release = r));
      return { items: Array.from({ length: 100 }, (_, i) => message(i + 1)) };
    }
    assert.ok(path.endsWith("after=100"));
    return { items: [message(101)] };
  });
  c.select("personal", "a");
  const first = c.load();
  await c.load(true);
  assert.equal(messageCalls, 1);
  c.saved(message(101));
  c.receipt("a101", "read");
  release();
  await first;
  assert.equal(c.messages.length, 101);
  assert.equal(c.more, true);
  await c.load();
  assert.equal(messageCalls, 1);
  assert.equal(checkCalls, 2);
  assert.equal(c.checkins[0]!.status, "acknowledged");
  await c.load(true);
  assert.equal(c.messages.length, 101);
  assert.equal(c.more, false);
  assert.deepEqual(c.messages.at(-1)!.receipts, [{ kind: "read" }]);
  c.saved(message(9, "other"));
  assert.equal(c.messages.length, 101);
});
