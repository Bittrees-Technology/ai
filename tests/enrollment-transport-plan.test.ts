import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  EnrollmentTransportPlan,
  type EnrollmentReview,
} from "../modules/task-sync/enrollment-transport-plan.js";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture() {
  let now = 100000;
  let current: EnrollmentReview | null = {
    epoch: "review-one",
    expiresAt: now + 300000,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey: "fixture",
    ownerWallet: "0x" + "a".repeat(40),
    requestId: randomUUID(),
    pollSecretHash: hash("b".repeat(64)),
  };
  const plan = new EnrollmentTransportPlan(
    () => current,
    () => now,
  );
  return {
    plan,
    get review() {
      return current!;
    },
    set: (r: EnrollmentReview | null) => {
      current = r;
    },
    advance: (n: number) => {
      now += n;
    },
    request: () => ({
      version: 1,
      audience: "https://mcp.bittrees.org",
      kind: "enroll",
      authorityId: current!.authorityId,
      deviceId: current!.deviceId,
      sourceWorkspace: current!.sourceWorkspace,
      principal: current!.principal,
      publicKey: current!.publicKey,
      ownerWallet: current!.ownerWallet,
      issuedAt: now,
      nonce: randomUUID(),
    }),
  };
}
test("offline enrollment planner rejects catalogue, activation and URL/header injection", () => {
  const f = fixture();
  for (const raw of [
    { operation: "catalogue" },
    { operation: "heartbeat", url: "http://127.0.0.1" },
    { operation: "heartbeat", headers: { authorization: "secret" } },
    {
      operation: "start",
      request: { ...f.request(), kind: "activate" },
      signature: "fixture",
    },
  ])
    assert.throws(() => f.plan.prepare(raw));
  const request = f.plan.prepare({ operation: "heartbeat" });
  assert.equal(request.url, "https://ai.bittrees.org/api/workflows");
  assert.equal(request.redirect, "error");
  assert.equal(request.timeoutMs, 15000);
});
test("planner binds device, scope, epoch and session deadline", () => {
  for (const change of ["revoke", "epoch", "device", "expiry"]) {
    const f = fixture();
    if (change === "revoke") f.set(null);
    if (change === "epoch") f.set({ ...f.review, epoch: "other" });
    if (change === "device") f.set({ ...f.review, deviceId: randomUUID() });
    if (change === "expiry") f.advance(300000);
    assert.throws(() => f.plan.prepare({ operation: "heartbeat" }));
  }
  const f = fixture();
  assert.throws(() =>
    f.plan.prepare({
      operation: "start",
      request: { ...f.request(), deviceId: randomUUID() },
      signature: "fixture",
    }),
  );
});
test("ambiguous start is not replayed; polls bind request and enforce spacing", () => {
  const f = fixture();
  const start = {
    operation: "start",
    request: f.request(),
    signature: "fixture",
  };
  f.plan.prepare(start);
  assert.throws(() => f.plan.prepare(start));
  const poll = {
    operation: "poll",
    id: f.review.requestId,
    pollSecret: "b".repeat(64),
  };
  assert.throws(() => f.plan.prepare({ ...poll, id: randomUUID() }));
  f.plan.prepare(poll);
  assert.throws(() => f.plan.prepare(poll));
  f.advance(3000);
  f.plan.prepare(poll);
});
