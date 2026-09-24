import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversationPermissionPanelState,
  emptyConversationForm,
} from "../apps/dashboard/conversation-permission-state.js";
const scope = { conversationId: "thread", inboxId: "personal" };
const form = {
  ...emptyConversationForm(),
  peerId: "peer",
  permissions: { ...emptyConversationForm().permissions, messagesToMac: true },
};
const choices = {
  ...scope,
  peerId: "peer",
  peerKeyEpoch: 1,
  permissions: form.permissions,
  expiresAt: 900000,
};
const status = {
  available: true,
  canSetup: true,
  revision: 1,
  keyRevision: 2,
  peerRevision: 3,
  needsFreshPairing: false,
  hasSelectedKey: true,
  peers: [{ peerId: "peer", keyEpoch: 1, fingerprint: "f" }],
  grants: [{ id: "grant", choices, state: "saved" }],
};
const review = {
  id: "review",
  action: "grant",
  expiresAt: 300000,
  peerId: "peer",
  permissionId: null,
  choices,
  binding: { ownerId: "owner", deviceId: "mac" },
  fingerprint: "f",
};
test("conversation review fixes the selected scope, separates acknowledgements and sends only once", async () => {
  const calls: any[] = [],
    originalScope = { ...scope };
  const c = new ConversationPermissionPanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      return structuredClone(path.endsWith("review") ? review : status);
    },
    originalScope,
    () => {},
    () => 1000,
    () => 0,
  );
  originalScope.conversationId = "changed";
  await c.refresh();
  await c.prepare(form);
  assert.deepEqual(calls[1].body, {
    action: "grant",
    expectedRevision: 1,
    expectedKeyRevision: 2,
    expectedPeerRevision: 3,
    peerId: "peer",
    peerKeyEpoch: 1,
    ...scope,
    minutes: 15,
    permissions: form.permissions,
  });
  await c.confirm(false, () => true);
  await c.confirm(true, () => false);
  assert.equal(calls.length, 2);
  await c.confirm(true, () => true);
  await c.confirm(true, () => true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, {
    reviewId: "review",
    confirmed: true,
    acknowledged: true,
  });
  assert.match(c.notice, /No messages were sent/);
  assert.ok(
    Object.values(emptyConversationForm().permissions).every(
      (v) => v === false,
    ),
  );
});
test("hidden or disposed panels discard late reviews and lost confirmations never retry", async () => {
  let release!: (v: unknown) => void;
  const c = new ConversationPermissionPanelState(
    async (path) =>
      path.endsWith("review")
        ? new Promise((r) => {
            release = r;
          })
        : status,
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await c.refresh();
  const pending = c.prepare(form);
  c.hide();
  release(review);
  await pending;
  assert.equal(c.review, null);
  assert.equal(c.status, null);
  await c.refresh();
  const next = c.prepare(form);
  c.dispose();
  release(review);
  await next;
  assert.equal(c.review, null);
  let confirms = 0;
  const uncertain = new ConversationPermissionPanelState(
    async (path) => {
      if (path.endsWith("confirm")) {
        confirms++;
        throw Error("response lost");
      }
      return path.endsWith("review") ? structuredClone(review) : status;
    },
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await uncertain.refresh();
  await uncertain.prepare(form);
  await uncertain.confirm(true, () => true);
  await uncertain.confirm(true, () => true);
  assert.equal(confirms, 1);
  assert.equal(uncertain.status, null);
  assert.match(uncertain.error, /No automatic retry/);
});
test("conversation reviews expire on either clock and returned cross-thread reviews cannot be confirmed", async () => {
  let wall = 1000,
    mono = 0;
  const c = new ConversationPermissionPanelState(
    async (path) =>
      path.endsWith("review") ? structuredClone(review) : status,
    scope,
    () => {},
    () => wall,
    () => mono,
  );
  await c.refresh();
  await c.prepare(form);
  mono = 299000;
  c.expire();
  assert.equal(c.review, null);
  await c.prepare(form);
  wall = 999;
  c.expire();
  assert.equal(c.review, null);
  const wrong = new ConversationPermissionPanelState(
    async (path) =>
      path.endsWith("review")
        ? { ...review, choices: { ...choices, conversationId: "other" } }
        : status,
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await wrong.refresh();
  await wrong.prepare(form);
  assert.equal(wrong.review, null);
});
test("offline revocation targets only an existing grant for this Inbox and thread", async () => {
  const calls: any[] = [];
  const c = new ConversationPermissionPanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      return path.endsWith("review")
        ? { ...review, action: "revoke", permissionId: "grant" }
        : { ...status, canSetup: false };
    },
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await c.refresh();
  await c.prepare(form);
  await c.revoke("other");
  assert.equal(calls.length, 1);
  await c.revoke("grant");
  assert.deepEqual(calls[1].body, {
    action: "revoke",
    permissionId: "grant",
    expectedRevision: 1,
  });
  await c.confirm(true, () => true);
  assert.match(
    c.notice,
    /Existing messages and previously shared copies remain/,
  );
});
