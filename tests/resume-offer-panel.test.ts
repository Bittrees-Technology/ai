import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResumeOfferPanelState } from "../apps/dashboard/resume-offer-state.js";
import { privateEnvelopeSuite } from "../modules/remote/private-envelope.js";
const scope = { taskId: randomUUID(), taskRevision: 3, status: "paused" },
  peerId = randomUUID(),
  permissionId = randomUUID(),
  id = randomUUID();
const choices = {
  taskId: scope.taskId,
  taskRevision: scope.taskRevision,
  modelDigest: "a".repeat(64),
  peerId,
  peerKeyEpoch: 1,
  expiresAt: 900000,
};
const permissions = {
  available: true,
  canSetup: true,
  revision: 2,
  keyRevision: 1,
  peerRevision: 1,
  needsFreshPairing: false,
  hasSelectedKey: true,
  peers: [],
  grants: [{ id: permissionId, choices, state: "saved" }],
};
const entry = {
  id,
  revision: 2,
  permissionId,
  choices,
  fingerprint: "f",
  createdAt: 1000,
  expiresAt: 300000,
  state: "ready",
};
const status = { available: true, canSetup: true, offers: [entry] };
const review = {
  id: randomUUID(),
  action: "create" as const,
  expiresAt: 121000,
  offerId: null,
  offerExpiresAt: 300000,
  permissionId,
  choices,
  fingerprint: "f",
  binding: { ownerId: randomUUID(), deviceId: randomUUID() },
};
const wire = {
  header: {
    version: 1 as const,
    suite: privateEnvelopeSuite,
    ownerId: review.binding.ownerId,
    senderId: review.binding.deviceId,
    recipientId: peerId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: id,
    sequence: 1,
    issuedAt: 1000,
    expiresAt: 300000,
  },
  enc: "synthetic",
  ciphertext: "synthetic",
};
test("offer panel binds exact selected permission and downloads only once after acknowledgement", async () => {
  const calls: any[] = [],
    downloads: any[] = [];
  const c = new ResumeOfferPanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      return structuredClone(
        path.endsWith("prepare")
          ? review
          : path.endsWith("confirm")
            ? { offer: entry, envelope: wire }
            : status,
      );
    },
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await c.refresh();
  await c.create(permissionId, permissions);
  assert.deepEqual(calls[1].body, {
    action: "create",
    permissionId,
    expectedConsentRevision: 2,
  });
  await c.confirm(
    false,
    () => true,
    (w) => downloads.push(w),
  );
  await c.confirm(
    true,
    () => false,
    (w) => downloads.push(w),
  );
  assert.equal(calls.length, 2);
  await c.confirm(
    true,
    () => true,
    (w) => downloads.push(w),
  );
  await c.confirm(
    true,
    () => true,
    (w) => downloads.push(w),
  );
  assert.deepEqual(downloads, [wire]);
  assert.equal(calls.length, 3);
  assert.match(
    c.notice,
    /Browser import and resume controls are not available yet/,
  );
  assert.equal(JSON.stringify(c).includes('"ciphertext"'), false);
});
test("late and lost offer confirmations never trigger downloads or automatic retries", async () => {
  for (const mode of ["hide", "dispose", "expiry", "lost"] as const) {
    let resolve!: (v: any) => void,
      reject!: (e: Error) => void,
      now = 1000,
      calls = 0,
      downloads = 0;
    const c = new ResumeOfferPanelState(
      async (path) => {
        if (path.endsWith("confirm")) {
          calls++;
          return new Promise((a, b) => {
            resolve = a;
            reject = b;
          });
        }
        return structuredClone(path.endsWith("prepare") ? review : status);
      },
      scope,
      () => {},
      () => now,
      () => 0,
    );
    await c.refresh();
    await c.create(permissionId, permissions);
    const pending = c.confirm(
      true,
      () => true,
      () => downloads++,
    );
    if (mode === "hide") c.hide();
    else if (mode === "dispose") c.dispose();
    else if (mode === "expiry") now = review.expiresAt;
    if (mode === "lost") reject(Error("lost"));
    else resolve({ offer: entry, envelope: wire });
    await pending;
    await c.confirm(
      true,
      () => true,
      () => downloads++,
    );
    assert.equal(downloads, 0);
    assert.equal(calls, 1);
    assert.equal(c.review, null);
    if (mode === "lost") assert.match(c.error, /No automatic retry/);
  }
});
test("cross-task, changed destination and expired offers cannot be reviewed or downloaded", async () => {
  let mode = "scope";
  const c = new ResumeOfferPanelState(
    async (path) => {
      if (path.endsWith("prepare"))
        return mode === "scope"
          ? { ...review, choices: { ...choices, taskId: "wrong" } }
          : structuredClone(review);
      if (path.endsWith("confirm"))
        return {
          offer: entry,
          envelope: {
            ...wire,
            header: { ...wire.header, recipientId: randomUUID() },
          },
        };
      return structuredClone(status);
    },
    scope,
    () => {},
    () => 1000,
    () => 0,
  );
  await c.refresh();
  await c.create(permissionId, permissions);
  assert.equal(c.review, null);
  assert.ok(c.error);
  mode = "destination";
  await c.refresh();
  await c.create(permissionId, permissions);
  let downloads = 0;
  await c.confirm(
    true,
    () => true,
    () => downloads++,
  );
  assert.equal(downloads, 0);
  assert.ok(c.error);
  await c.refresh();
  c.status!.offers[0]!.expiresAt = 1000;
  await c.prepare(id, "reveal");
  assert.equal(c.review, null);
});
test("offer reviews expire with monotonic time and stopping remains available offline", async () => {
  let mono = 0,
    action = "create";
  const c = new ResumeOfferPanelState(
    async (path, _method, body: any) => {
      if (path.endsWith("prepare")) {
        action = body.action;
        return { ...review, action, offerId: body.id ?? null };
      }
      if (path.endsWith("confirm"))
        return { offer: { ...entry, state: "stopped" }, envelope: null };
      return structuredClone(status);
    },
    scope,
    () => {},
    () => 1000,
    () => mono,
  );
  await c.refresh();
  await c.create(permissionId, permissions);
  mono = 120000;
  c.expire();
  assert.equal(c.review, null);
  assert.match(c.notice, /expired/);
  c.status!.canSetup = false;
  await c.prepare(id, "reveal");
  assert.equal(c.review, null);
  await c.prepare(id, "stop");
  assert.equal(c.review!.action, "stop");
  await c.confirm(
    true,
    () => true,
    () => {
      throw Error("must not download");
    },
  );
  assert.equal(c.status!.offers[0]!.state, "stopped");
  assert.match(c.notice, /Downloaded copies remain/);
});

test("changed task revision or running task prevents create and reveal but allows stopping old offers", async () => {
  for (const changedScope of [
    { ...scope, taskRevision: scope.taskRevision + 1 },
    { ...scope, status: "running" },
  ]) {
    const calls: any[] = [];
    const c = new ResumeOfferPanelState(
      async (path, _method, body: any) => {
        calls.push({ path, body });
        if (path.endsWith("prepare"))
          return { ...review, action: body.action, offerId: body.id };
        return structuredClone(status);
      },
      changedScope,
      () => {},
      () => 1000,
      () => 0,
    );
    await c.refresh();
    await c.create(permissionId, permissions);
    await c.prepare(id, "reveal");
    assert.equal(calls.length, 1);
    assert.equal(c.review, null);
    await c.prepare(id, "stop");
    assert.equal(calls.length, 2);
    assert.equal(c.review!.action, "stop");
    assert.deepEqual(calls[1].body, {
      action: "stop",
      id,
      expectedRevision: entry.revision,
    });
  }
});

test("changed model or task in either review or confirmation cannot produce a download", async () => {
  for (const stage of ["prepare", "confirm"]) {
    for (const change of [
      { modelDigest: "b".repeat(64) },
      { taskRevision: scope.taskRevision + 1 },
    ]) {
      let downloads = 0;
      const c = new ResumeOfferPanelState(
        async (path) => {
          if (path.endsWith("prepare"))
            return structuredClone(
              stage === "prepare"
                ? { ...review, choices: { ...choices, ...change } }
                : review,
            );
          if (path.endsWith("confirm"))
            return {
              offer: { ...entry, choices: { ...choices, ...change } },
              envelope: wire,
            };
          return structuredClone(status);
        },
        scope,
        () => {},
        () => 1000,
        () => 0,
      );
      await c.refresh();
      await c.create(permissionId, permissions);
      await c.confirm(
        true,
        () => true,
        () => downloads++,
      );
      assert.equal(downloads, 0);
      assert.equal(c.review, null);
      assert.ok(c.error);
    }
  }
});
