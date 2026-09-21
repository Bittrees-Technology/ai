import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const owner = { userId: "alice", tenantId: "home" };
const message = {
  conversationId: "c",
  recipientInboxId: "assistant",
  type: "query",
  content: "PRIVATE message",
  replyExpected: true,
  replyDueAt: "2026-09-21T00:01:00Z",
};
test("messages share conversation order; reading does not complete a task or check-in", () => {
  let now = Date.parse("2026-09-21T00:00:00Z");
  const store = new Store(":memory:", new Vault(randomBytes(32)), () => now);
  try {
    store.createInbox(owner, {
      id: "assistant",
      tenantId: "home",
      ownerType: "agent",
      ownerId: "helper",
      memberUserIds: ["alice"],
    });
    const t = store.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "hello",
        modelProfileId: "m",
      },
      "task",
    );
    const m = store.appendMessage(
      owner,
      { ...message, requestId: t.id },
      "msg",
    );
    assert.equal(m.sequence, t.sequence + 1);
    assert.equal(
      store.appendMessage(owner, { ...message, requestId: t.id }, "msg").id,
      m.id,
    );
    assert.throws(
      () =>
        store.appendMessage(owner, { ...message, content: "changed" }, "msg"),
      /CONFLICT/,
    );
    store.receipt(owner, m.id, "read");
    assert.equal(store.get(owner, t.id).status, "queued");
    assert.equal(
      (store.checkins(owner)[0] as { status: string }).status,
      "open",
    );
    now += 61000;
    assert.equal(
      (store.checkins(owner)[0] as { status: string }).status,
      "overdue",
    );
    store.appendMessage(
      owner,
      { ...message, type: "reply", replyToId: m.id, replyExpected: false },
      "reply",
    );
    assert.equal(
      (store.checkins(owner)[0] as { status: string }).status,
      "closed",
    );
    assert.equal(store.messages(owner, "assistant", "c", m.sequence).length, 1);
    assert.throws(
      () => store.message({ ...owner, userId: "bob" }, m.id),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        store.createInbox(owner, {
          id: "team",
          tenantId: "home",
          ownerType: "manager",
          ownerId: "manager",
          memberUserIds: ["alice", "bob"],
        }),
      /INVALID_INPUT/,
    );
    assert.equal(store.exportMessages(owner).length, 2);
    store.deleteAll(owner);
    assert.equal(store.exportMessages(owner).length, 0);
  } finally {
    store.close();
  }
});
test("messages reject wrong conversation request links and cross-conversation replies", () => {
  const s = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    s.createInbox(owner, {
      id: "assistant",
      tenantId: "home",
      ownerType: "user",
      ownerId: "alice",
      memberUserIds: ["alice"],
    });
    const t = s.create(
      owner,
      {
        conversationId: "other",
        kind: "query",
        prompt: "hello",
        modelProfileId: "m",
      },
      "task",
    );
    assert.throws(
      () => s.appendMessage(owner, { ...message, requestId: t.id }, "msg"),
      /INVALID_INPUT/,
    );
    const first = s.appendMessage(owner, message, "first");
    assert.throws(
      () =>
        s.appendMessage(
          owner,
          { ...message, conversationId: "other", replyToId: first.id },
          "reply",
        ),
      /INVALID_INPUT/,
    );
  } finally {
    s.close();
  }
});

test("inbox discovery, conversation previews and paginated messages stay owner-scoped", () => {
  const s = new Store(":memory:", new Vault(randomBytes(32))),
    other = { ...owner, userId: "bob" };
  try {
    for (const o of [owner, other])
      s.createInbox(o, {
        id: "personal",
        tenantId: o.tenantId,
        ownerType: "user",
        ownerId: o.userId,
        memberUserIds: [o.userId],
      });
    s.appendMessage(
      other,
      {
        ...message,
        recipientInboxId: "personal",
        content: "OTHER_USER_SENTINEL",
      },
      "other",
    );
    for (let i = 0; i < 101; i++)
      s.appendMessage(
        owner,
        {
          ...message,
          recipientInboxId: "personal",
          content: "Message " + i,
          replyExpected: false,
        },
        "m" + i,
      );
    assert.equal(s.inboxes(owner)[0]!.ownerId, "alice");
    assert.equal(
      s.inboxConversations(owner, "personal")[0]!.preview,
      "Message 100",
    );
    assert.equal(
      JSON.stringify(s.inboxConversations(owner, "personal")).includes(
        "OTHER_USER_SENTINEL",
      ),
      false,
    );
    const first = s.messages(owner, "personal", "c");
    assert.equal(first.length, 100);
    const next = s.messages(owner, "personal", "c", first.at(-1)!.sequence);
    assert.equal(next.length, 1);
    s.receipt(owner, next[0]!.id, "acknowledged");
    assert.deepEqual(
      s.message(owner, next[0]!.id).receipts.map((r) => r.kind),
      ["acknowledged"],
    );
    assert.throws(() => s.receipt(other, next[0]!.id, "read"), /NOT_FOUND/);
    assert.equal(
      s.exportMessages(owner).find((m) => m.id === next[0]!.id)!.receipts[0]
        ?.kind,
      "acknowledged",
    );
  } finally {
    s.close();
  }
});
