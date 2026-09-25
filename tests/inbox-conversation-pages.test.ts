import { InboxMessageController } from "../apps/dashboard/inbox-message-state.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
import { InboxConversationController } from "../apps/dashboard/inbox-conversation-state.js";
const owner = { userId: "alice", tenantId: "personal" };
function inbox(store: Store, id = "personal", who = owner) {
  store.createInbox(who, {
    id,
    tenantId: who.tenantId,
    ownerId: who.userId,
    ownerType: "user",
    memberUserIds: [who.userId],
  });
}
function add(
  store: Store,
  conversationId: string,
  key: string,
  recipientInboxId = "personal",
) {
  return store.appendMessage(
    owner,
    { conversationId, recipientInboxId, content: key, type: "query" },
    key,
  );
}
test("stable conversation pages retain older results while new messages arrive and scope cursors to owner/inbox", () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)), () => 1000);
  try {
    inbox(store);
    inbox(store, "other");
    for (let i = 0; i < 205; i++) add(store, `c${i}`, `message${i}`);
    const first = store.inboxConversationPage(owner, "personal");
    assert.equal(first.items.length, 100);
    assert.equal(first.items[0]!.id, "c204");
    add(store, "c0", "newest-update");
    add(store, "new", "brand-new");
    const second = store.inboxConversationPage(
      owner,
      "personal",
      first.nextCursor!,
    );
    const third = store.inboxConversationPage(
      owner,
      "personal",
      second.nextCursor!,
    );
    const items = [...first.items, ...second.items, ...third.items];
    assert.equal(items.length, 205);
    assert.equal(new Set(items.map((i) => i.id)).size, 205);
    assert.equal(third.nextCursor, null);
    assert.equal(items.at(-1)!.preview, "message0");
    assert.equal(
      store.inboxConversationPage(owner, "personal").items[0]!.id,
      "new",
    );
    assert.throws(
      () => store.inboxConversationPage(owner, "other", first.nextCursor!),
      /INVALID_INPUT/,
    );
    assert.throws(
      () =>
        store.inboxConversationPage(
          { ...owner, userId: "bob" },
          "personal",
          first.nextCursor!,
        ),
      /INVALID_INPUT/,
    );
    assert.throws(
      () =>
        store.inboxConversationPage(
          { ...owner, tenantId: "elsewhere" },
          "personal",
          first.nextCursor!,
        ),
      /INVALID_INPUT/,
    );
    assert.throws(
      () => store.inboxConversationPage(owner, "personal", "broken"),
      /INVALID_INPUT/,
    );
    const lastPosition = (
      store.db
        .prepare("SELECT max(position) AS n FROM message_positions")
        .get() as any
    ).n;
    store.deleteAll(owner);
    inbox(store);
    add(store, "replacement", "replacement");
    assert.ok(
      (
        store.db
          .prepare("SELECT max(position) AS n FROM message_positions")
          .get() as any
      ).n > lastPosition,
    );
    assert.equal(
      store.inboxConversationPage(owner, "personal", first.nextCursor!).items
        .length,
      0,
    );
  } finally {
    store.close();
  }
});
test("schema eleven migration indexes existing messages and preserves positions after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-pages-")),
    path = join(dir, "store.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault);
  try {
    inbox(store);
    add(store, "first", "first");
    add(store, "second", "second");
    store.db.exec("DROP TABLE message_positions; PRAGMA user_version=11");
    store.close();
    store = new Store(path, vault);
    assert.equal(store.db.pragma("user_version", { simple: true }), 36);
    assert.deepEqual(
      store.inboxConversationPage(owner, "personal").items.map((i) => i.id),
      ["second", "first"],
    );
    const before = store.db
      .prepare("SELECT * FROM message_positions ORDER BY position")
      .all();
    store.close();
    store = new Store(path, vault);
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM message_positions ORDER BY position")
        .all(),
      before,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("conversation controller suppresses old inbox responses and permits retry of a failed earlier page", async () => {
  let resolve!: (page: any) => void;
  let reject!: (error: Error) => void;
  const paths: string[] = [];
  const c = new InboxConversationController(async (path) => {
    paths.push(path);
    return new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
  });
  const old = c.refresh("old");
  const finishOld = resolve;
  const current = c.refresh("new");
  finishOld({ items: [{ id: "secret-old" }], nextCursor: null });
  await old;
  assert.deepEqual(c.items, []);
  assert.equal(c.busy, true);
  resolve({ items: [{ id: "new", preview: "new" }], nextCursor: "cursor" });
  await current;
  const more = c.more();
  await c.more();
  assert.equal(paths.length, 3);
  reject(Error("UNAVAILABLE"));
  await assert.rejects(more, /UNAVAILABLE/);
  assert.equal(c.nextCursor, "cursor");
  assert.equal(c.items.length, 1);
  const retry = c.more();
  resolve({ items: [{ id: "older", preview: "older" }], nextCursor: null });
  await retry;
  assert.equal(paths[2], paths[3]);
  assert.equal(c.items.length, 2);
  const late = c.refresh("late");
  c.clear();
  reject(Error("hidden-error"));
  await late;
  assert.deepEqual(c.items, []);
});
test("actual authenticated conversation endpoint drives controller through all pages and rejects malformed cursors", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  inbox(store);
  for (let i = 0; i < 102; i++) add(store, `c${i}`, `m${i}`);
  const server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, owner, port, token }));
  const get = (path: string, auth = true) =>
    fetch(`http://127.0.0.1:${port}` + path, {
      headers: auth ? { Authorization: "Bearer " + token } : {},
    });
  try {
    const c = new InboxConversationController(async (path) => {
      const r = await get(path);
      assert.equal(r.status, 200);
      return r.json();
    });
    await c.refresh("personal");
    assert.equal(c.items.length, 100);
    await c.more();
    assert.equal(c.items.length, 102);
    assert.equal(c.nextCursor, null);
    for (let i = 0; i < 205; i++) add(store, "long", `long${i}`);
    const messages = new InboxMessageController(async (path) => {
      const response = await get(path);
      assert.equal(response.status, 200);
      return response.json();
    });
    messages.select("personal", "long");
    await messages.load();
    await messages.load(true);
    await messages.load(true);
    assert.equal(messages.messages.length, 205);
    assert.equal(new Set(messages.messages.map((m) => m.id)).size, 205);
    assert.equal(messages.more, false);
    assert.equal(messages.messages.at(-1)!.input.content, "long204");
    assert.equal(
      (await get("/v1/inboxes/personal/conversations", false)).status,
      401,
    );
    assert.equal(
      (await get("/v1/inboxes/personal/conversations?cursor=x&cursor=y"))
        .status,
      400,
    );
    assert.equal(
      (await get("/v1/inboxes/personal/conversations?cursor=broken")).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
