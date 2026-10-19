import test from "node:test";
import { canonical } from "../modules/contracts/canonical-json.js";
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

test("non-finite review deadlines fail closed", () => {
  const f = fixture();
  for (const expiresAt of [NaN, Infinity, -Infinity, 100000.5])
    assert.throws(
      () =>
        new EnrollmentTransportPlan(
          () => ({ ...f.review, expiresAt }),
          () => 100000,
        ),
    );
});
test("response-release guard detects revocation after request planning", () => {
  const f = fixture();
  f.plan.prepare({ operation: "heartbeat" });
  f.set(null);
  assert.throws(() => f.plan.assertCurrent());
});
test("review binding includes all identity fields and prevents extending session", () => {
  for (const field of [
    "authorityId",
    "sourceWorkspace",
    "principal",
    "publicKey",
    "ownerWallet",
    "expiresAt",
  ] as const) {
    const f = fixture();
    f.set({ ...f.review, [field]: field === "expiresAt" ? 400001 : "changed" });
    assert.throws(() => f.plan.assertCurrent());
  }
});
test("stale signed requests and oversized envelopes fail before planning", () => {
  const f = fixture();
  assert.throws(() =>
    f.plan.prepare({
      operation: "start",
      request: { ...f.request(), issuedAt: 1 },
      signature: "fixture",
    }),
  );
  assert.throws(() =>
    f.plan.prepare({ operation: "heartbeat", padding: "x".repeat(16001) }),
  );
  assert.equal(
    f.plan.prepare({ operation: "heartbeat" }).maximumResponseBytes,
    64000,
  );
});
test("total calls are bounded independently from owner review freshness", () => {
  const f = fixture();
  for (let i = 0; i < 108; i++) f.plan.prepare({ operation: "heartbeat" });
  assert.throws(() => f.plan.prepare({ operation: "heartbeat" }));
});

function completionFixture() {
  const f = fixture();
  const { kind, ownerWallet, ...identity } = f.request();
  const request = { ...identity, profileId: randomUUID() };
  const digest = createHash("sha256").update(canonical(request)).digest("hex");
  f.set({ ...f.review, enrollmentRequestDigest: digest });
  const complete = {
    operation: "complete",
    id: f.review.requestId,
    pollSecret: "b".repeat(64),
    proof: {
      request,
      signature: "synthetic",
      attestation: {
        signature: "synthetic",
        request: {
          version: 1,
          issuer: "https://ai.bittrees.org",
          audience: "https://roles.bittrees.org",
          purpose: "enroll",
          requestDigest: digest,
          authorityId: request.authorityId,
          deviceId: request.deviceId,
          ownerWallet,
          principal: request.principal,
          credentialId: "c".repeat(64),
          sourceWorkspace: request.sourceWorkspace,
          issuedAt: request.issuedAt,
          expiresAt: request.issuedAt + 60000,
          nonce: randomUUID(),
        },
      },
    },
  };
  return { f, complete };
}
test("completion permits only two identical plans and never another proof", () => {
  const { f, complete } = completionFixture();
  f.plan.prepare(complete);
  assert.throws(() =>
    f.plan.prepare({
      ...complete,
      proof: { ...complete.proof, signature: "changed" },
    }),
  );
  f.plan.prepare(complete);
  assert.throws(() => f.plan.prepare(complete));
});
test("attestation and completion require the reviewed owner challenge", () => {
  for (const operation of ["attest", "complete"]) {
    const { f, complete } = completionFixture();
    f.set({ ...f.review, enrollmentRequestDigest: "f".repeat(64) });
    const raw =
      operation === "complete"
        ? complete
        : {
            operation,
            request: complete.proof.request,
            signature: "synthetic",
          };
    assert.throws(() => f.plan.prepare(raw), /challenge binding/);
  }
});
test("completion rejects substituted scope, expired and future attestations", () => {
  for (const field of [
    "purpose",
    "deviceId",
    "requestDigest",
    "issuedAt",
    "expiresAt",
  ]) {
    const { f, complete } = completionFixture();
    const changes: Record<string, unknown> = {
      purpose: "activate",
      deviceId: randomUUID(),
      requestDigest: "f".repeat(64),
      issuedAt: 100001,
      expiresAt: 99999,
    };
    const raw = structuredClone(complete);
    Object.assign(raw.proof.attestation.request, { [field]: changes[field] });
    assert.throws(() => f.plan.prepare(raw));
  }
});
