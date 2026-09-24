import test from "node:test";
import assert from "node:assert/strict";
import { TaskAnswerController } from "../apps/dashboard/task-answer-state.js";
import type { InboxMessage } from "../apps/dashboard/inbox-message-state.js";
const taskId = "00000000-0000-4000-8000-000000000001",
  questionId = "00000000-0000-4000-8000-000000000002",
  replyId = "00000000-0000-4000-8000-000000000003";
const message = {
  id: questionId,
  input: {
    requestId: taskId,
    recipientInboxId: "personal",
    conversationId: "thread",
  },
} as InboxMessage;
const q = {
  taskId,
  questionId,
  inboxId: "personal",
  conversationId: "thread",
  revision: 3,
  status: "awaiting_input",
  question: "Which scope?",
  deadline: 999999,
  replyId: null,
  canAnswer: true,
};
const receipt = {
  taskId,
  questionId,
  replyId,
  revision: 4,
  status: "queued",
  duplicate: false,
};
const yes = () => true;
function fixture() {
  let wall = 1000,
    mono = 0,
    next: any = q;
  const posts: any[] = [];
  const c = new TaskAnswerController(
    async (path, method, body, headers) => {
      if (method === "POST") {
        posts.push({ path, body, headers });
        if (next === "lost") throw Error("PRIVATE");
        return next === q ? receipt : next;
      }
      if (next === "denied") throw Error("PRIVATE");
      return next;
    },
    () => {},
    () => wall,
    () => mono,
    () => replyId,
  );
  return {
    c,
    posts,
    next: (v: any) => (next = v),
    wall: (v: number) => (wall = v),
    mono: (v: number) => (mono = v),
  };
}
async function review(c: TaskAnswerController) {
  await c.open(message, yes);
  c.edit("Selected scope only");
  await c.prepare(message, yes);
}
test("answer requires exact fresh review and unchecked confirmation; consumed once before POST", async () => {
  const f = fixture();
  await review(f.c);
  assert.ok(f.c.review);
  assert.equal(f.c.confirmed, false);
  await f.c.save(yes);
  assert.equal(f.posts.length, 0);
  f.c.acknowledge(true);
  await Promise.all([f.c.save(yes), f.c.save(yes)]);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0], {
    path: `/v1/messages/${questionId}/task-answer`,
    body: {
      questionId,
      expectedRevision: 3,
      content: "Selected scope only",
      confirmed: true,
    },
    headers: { "Idempotency-Key": replyId },
  });
  assert.match(f.c.notice, /Answer saved/);
  assert.equal(f.c.draft, "");
  assert.equal(f.c.question, null);
});
test("changed question, access, revision, state, deadline or identity invalidates the answer review", async () => {
  for (const next of [
    "denied",
    { ...q, revision: 4 },
    { ...q, question: "Changed" },
    { ...q, status: "paused" },
    { ...q, replyId },
    { ...q, deadline: 999998 },
    { ...q, taskId: replyId },
    { ...q, inboxId: "other" },
    { ...q, conversationId: "other" },
    { ...q, canAnswer: false },
  ]) {
    const f = fixture();
    await f.c.open(message, yes);
    f.c.edit("Answer");
    f.next(next);
    await f.c.prepare(message, yes);
    assert.equal(f.c.review, null);
    assert.equal(f.c.question, null);
    assert.equal(f.c.draft, "");
    assert.equal(f.posts.length, 0);
  }
});
test("wall and monotonic expiry, backward clocks, lost focus and clear prevent dispatch", async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.wall(121000),
    (f: ReturnType<typeof fixture>) => f.wall(999),
    (f: ReturnType<typeof fixture>) => f.mono(120000),
    (f: ReturnType<typeof fixture>) => f.mono(-1),
    (f: ReturnType<typeof fixture>) => f.c.clear(),
  ]) {
    const f = fixture();
    await review(f.c);
    f.c.acknowledge(true);
    invalidate(f);
    await f.c.save(yes);
    assert.equal(f.posts.length, 0);
    assert.equal(f.c.draft, "");
  }
  const f = fixture();
  await review(f.c);
  f.c.acknowledge(true);
  await f.c.save(() => false);
  assert.equal(f.posts.length, 0);
});
test("uncertain or mismatched receipt does not auto retry; reopen discovers an already saved answer", async () => {
  for (const result of [
    "lost",
    { ...receipt, taskId: replyId },
    { ...receipt, revision: 3 },
    { ...receipt, status: "running" },
    { ...receipt, extra: "PRIVATE" },
  ]) {
    const f = fixture();
    await review(f.c);
    f.c.acknowledge(true);
    f.next(result);
    await f.c.save(yes);
    assert.match(f.c.notice, /could not be confirmed/);
    assert.doesNotMatch(f.c.notice, /PRIVATE/);
    await f.c.save(yes);
    assert.equal(f.posts.length, 1);
    f.next({ ...q, replyId, canAnswer: false });
    await f.c.open(message, yes);
    assert.match(f.c.notice, /already saved/);
    assert.equal(f.c.question, null);
    assert.equal(f.posts.length, 1);
  }
});
test("clearing a pending read or review never restores plaintext, and clearing a save cannot launch a second save", async () => {
  let resolve!: (v: unknown) => void,
    held = false,
    posts = 0;
  const c = new TaskAnswerController(
    async (_p, method) => {
      if (method === "POST") posts++;
      return held || method === "POST" ? new Promise((r) => (resolve = r)) : q;
    },
    () => {},
    () => 1000,
    () => 0,
    () => replyId,
  );
  held = true;
  const open = c.open(message, yes);
  c.clear();
  resolve(q);
  await open;
  assert.equal(c.question, null);
  held = false;
  await c.open(message, yes);
  c.edit("Answer");
  held = true;
  const preparing = c.prepare(message, yes);
  c.clear();
  resolve(q);
  await preparing;
  assert.equal(c.review, null);
  assert.equal(c.draft, "");
  held = false;
  await review(c);
  c.acknowledge(true);
  const save = c.save(yes);
  c.clear();
  await c.open(message, yes);
  await c.save(yes);
  assert.equal(posts, 1);
  assert.equal(c.question, null);
  resolve(receipt);
  await save;
  assert.doesNotMatch(c.notice, /^Answer saved/);
});
test("paused answer review keeps pause semantics and expiry cannot extend the question deadline", async () => {
  const f = fixture();
  f.next({ ...q, status: "paused", deadline: 2000 });
  await review(f.c);
  assert.equal(f.c.review!.question.status, "paused");
  f.c.acknowledge(true);
  f.next({ ...receipt, status: "paused" });
  await f.c.save(yes);
  assert.match(f.c.notice, /remains paused/);
  const g = fixture();
  g.next({ ...q, deadline: 2000 });
  await review(g.c);
  g.c.acknowledge(true);
  g.wall(2000);
  await g.c.save(yes);
  assert.equal(g.posts.length, 0);
});
