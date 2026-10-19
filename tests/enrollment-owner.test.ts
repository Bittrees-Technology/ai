import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EnrollmentOwner } from "../modules/task-sync/enrollment-owner.js";
const token = "a".repeat(64);
const review = () => ({
  epoch: randomUUID(),
  expiresAt: Date.now() + 30000,
  authorityId: randomUUID(),
  deviceId: randomUUID(),
  sourceWorkspace: randomUUID(),
  principal: "agent:" + randomUUID(),
  publicKey: "fixture",
  ownerWallet: "0x" + "a".repeat(40),
});
const send = (url: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: '{"operation":"heartbeat"}',
  });

test("owner rejects mismatched authority before creating a session", () => {
  const r = review();
  let created = false;
  assert.throws(
    () =>
      new EnrollmentOwner(
        r,
        () => ({ ...r, deviceId: randomUUID() }),
        token,
        () => {
          created = true;
          return { execute: async () => null, close() {} };
        },
      ),
    /authority/,
  );
  assert.equal(created, false);
});
test("revocation cancels active work and drains it before closing storage", async () => {
  const r = review();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finished = false,
    closed = 0;
  const owner = new EnrollmentOwner(
    r,
    () => r,
    token,
    () => ({
      execute: async (_raw, signal) => {
        entered();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        finished = true;
        return { secret: "must-discard" };
      },
      close() {
        assert.equal(finished, true);
        closed++;
      },
    }),
  );
  const url = await owner.listen();
  const response = send(url).then(
    (r) => r.text(),
    () => "disconnected",
  );
  await started;
  owner.revoke();
  await Promise.all([owner.close(), owner.close()]);
  assert.equal(closed, 1);
  assert.ok(!(await response).includes("must-discard"));
  await assert.rejects(owner.listen(), /closed/);
});
test("expiry and changed owner scope deny requests without running a task", async () => {
  for (const change of ["deadline", "scope"]) {
    const r = review();
    let now = Date.now();
    let current = r;
    let calls = 0,
      closed = false;
    const owner = new EnrollmentOwner(
      r,
      () => current,
      token,
      () => ({
        execute: async () => {
          calls++;
          return {};
        },
        close() {
          closed = true;
        },
      }),
      () => now,
    );
    const url = await owner.listen();
    if (change === "deadline") now = r.expiresAt;
    else current = { ...r, sourceWorkspace: randomUUID() };
    try {
      assert.equal((await send(url)).status, 403);
      assert.equal(calls, 0);
    } finally {
      await owner.close();
    }
    assert.equal(closed, true);
  }
});
