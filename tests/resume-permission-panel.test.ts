import test from "node:test";
import assert from "node:assert/strict";
import {
  ResumePermissionPanelState,
  type ResumeTaskScope,
} from "../apps/dashboard/resume-permission-state.js";
const scope = { taskId: "task", taskRevision: 7, status: "paused" };
const form = { peerId: "browser", minutes: 15 as const };
const choices = {
  taskId: "task",
  taskRevision: 7,
  peerId: "browser",
  peerKeyEpoch: 2,
  modelDigest: "a".repeat(64),
  expiresAt: 901000,
};
const saved = {
  available: true,
  canSetup: true,
  revision: 1,
  keyRevision: 2,
  peerRevision: 3,
  needsFreshPairing: false,
  hasSelectedKey: true,
  peers: [{ peerId: "browser", keyEpoch: 2, fingerprint: "f" }],
  grants: [{ id: "permission", choices, state: "saved" }],
};
const prepared = {
  id: "review",
  action: "grant",
  expiresAt: 301000,
  peerId: "browser",
  permissionId: null as string | null,
  choices,
  binding: { ownerId: "owner", deviceId: "mac" },
  fingerprint: "f",
};
function setup(s: ResumeTaskScope = scope) {
  const calls: any[] = [];
  let wall = 1000,
    mono = 0;
  const state = {
    saved: structuredClone(saved),
    review: structuredClone(prepared),
    lose: false,
  };
  const c = new ResumePermissionPanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      if (path.endsWith("confirm") && state.lose) throw Error("lost response");
      return structuredClone(
        path.endsWith("prepare") ? state.review : state.saved,
      );
    },
    s,
    () => {},
    () => wall,
    () => mono,
  );
  return {
    c,
    calls,
    state,
    clock: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
test("resume review binds exact task, key and peer revisions; confirms once only after acknowledgement and focus", async () => {
  const original = { ...scope },
    { c, calls } = setup(original);
  original.taskRevision++;
  await c.refresh();
  await c.prepare(form);
  assert.deepEqual(calls[1], {
    path: "/v1/private-resume/prepare",
    method: "POST",
    body: {
      action: "grant",
      expectedRevision: 1,
      expectedKeyRevision: 2,
      expectedPeerRevision: 3,
      peerId: "browser",
      peerKeyEpoch: 2,
      taskId: "task",
      taskRevision: 7,
      minutes: 15,
    },
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
  assert.match(c.notice, /nothing was sent/);
});
test("resume grant rejects mismatched task, revision, peer, epoch, action and model identity", async () => {
  for (const patch of [
    { taskId: "another" },
    { taskRevision: 8 },
    { peerId: "another" },
    { peerKeyEpoch: 3 },
    { modelDigest: "model-name" },
  ]) {
    const { c, state } = setup();
    Object.assign(state.review.choices, patch);
    await c.refresh();
    await c.prepare(form);
    assert.equal(c.review, null);
  }
  const { c, state } = setup();
  state.review.action = "revoke";
  await c.refresh();
  await c.prepare(form);
  assert.equal(c.review, null);
});
test("new permissions require a paused task and current pairing; revocation remains available offline after task changes", async () => {
  for (const patch of [
    { canSetup: false },
    { available: false },
    { hasSelectedKey: false },
    { needsFreshPairing: true },
  ]) {
    const { c, state, calls } = setup();
    Object.assign(state.saved, patch);
    await c.refresh();
    await c.prepare(form);
    assert.equal(calls.length, 1);
  }
  const { c, state, calls } = setup({
    ...scope,
    taskRevision: 8,
    status: "completed",
  });
  state.saved.canSetup = false;
  state.review.action = "revoke";
  state.review.permissionId = "permission";
  await c.refresh();
  await c.prepare(form);
  assert.equal(calls.length, 1);
  await c.revoke("permission");
  assert.equal(c.review?.action, "revoke");
  await c.confirm(true, () => true);
  assert.match(c.notice, /revoked/);
});
test("resume review expires on monotonic deadline, wall rollback, and form invalidation", async () => {
  for (const [wall, mono] of [
    [1001, 300000],
    [999, 1],
    [301000, 1],
  ]) {
    const { c, clock, calls } = setup();
    await c.refresh();
    await c.prepare(form);
    clock(wall!, mono!);
    await c.confirm(true, () => true);
    assert.equal(c.review, null);
    assert.equal(calls.length, 2);
  }
  const { c, calls } = setup();
  await c.refresh();
  await c.prepare(form);
  c.invalidateReview();
  await c.confirm(true, () => true);
  assert.equal(calls.length, 2);
});
test("hidden and disposed resume panels drop late reviews; parallel actions do not send twice", async () => {
  for (const dispose of [false, true]) {
    let release!: (v: unknown) => void;
    let prepares = 0;
    const c = new ResumePermissionPanelState(
      async (path) =>
        path.endsWith("prepare")
          ? (prepares++,
            new Promise((r) => {
              release = r;
            }))
          : saved,
      scope,
      () => {},
      () => 1000,
      () => 0,
    );
    await c.refresh();
    const pending = c.prepare(form);
    await c.prepare(form);
    if (dispose) c.dispose();
    else c.hide();
    release(prepared);
    await pending;
    assert.equal(c.review, null);
    assert.equal(c.status, null);
    assert.equal(prepares, 1);
  }
});
test("uncertain confirmation clears review and status without automatic retry", async () => {
  const { c, calls, state } = setup();
  await c.refresh();
  await c.prepare(form);
  state.lose = true;
  await c.confirm(true, () => true);
  await c.confirm(true, () => true);
  assert.equal(calls.length, 3);
  assert.equal(c.review, null);
  assert.equal(c.status, null);
  assert.match(c.error, /No automatic retry/);
});
