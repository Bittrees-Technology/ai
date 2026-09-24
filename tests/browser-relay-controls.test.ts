import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserRelayControls } from "../apps/remote-web/browser-relay-state.js";
import type { PrivateRelayGrant } from "../modules/remote/private-relay-enrollment.js";
function fixture() {
  let now = 1900000000000,
    mono = 0;
  let context = { ownerId: randomUUID(), scope: "one" };
  const deviceId = randomUUID(),
    calls: { path: string; body: any }[] = [];
  let grant: PrivateRelayGrant | null = null;
  let lose = false,
    finish: (() => void) | null = null,
    held = false;
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (held)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    if (path.endsWith("registration/inspect"))
      return Response.json({
        version: 1,
        ownerId: context.ownerId,
        sessionExpiresAt: now + 600000,
        registration: {
          binding: {
            ownerId: context.ownerId,
            deviceId,
            credentialEpoch: 2,
            expiresAt: now + 1800000,
          },
          createdAt: now,
          revokedAt: null,
        },
      });
    if (path.endsWith("permissions/endpoint"))
      return Response.json({
        endpoint: {
          ownerId: context.ownerId,
          ...body,
          expiresAt: now + 1800000,
        },
        permission: grant,
      });
    if (path.endsWith("mac/approve") || path.endsWith("permission/enable")) {
      const mac = path.endsWith("mac/approve");
      grant = {
        id: randomUUID(),
        ownerId: context.ownerId,
        endpointKind: mac ? "mac" : "browser",
        endpointId: body.deviceId,
        credentialEpoch: body.credentialEpoch,
        operationId: body.operationId,
        revision: 1,
        state: mac ? "pending" : "active",
        createdAt: now,
        expiresAt: body.expiresAt,
        approvalExpiresAt: mac ? now + 120000 : null,
        revokedAt: null,
      };
      if (lose) throw Error("lost after commit");
      return Response.json(grant);
    }
    if (path.endsWith("permissions/revoke")) {
      grant = {
        ...grant!,
        state: "revoked",
        approvalExpiresAt: null,
        revokedAt: now,
        revision: body.expectedRevision + 1,
      };
      if (lose) throw Error("lost after revoke");
      return Response.json(grant);
    }
    if (path.endsWith("permissions/list"))
      return Response.json({ items: grant ? [grant] : [], nextCursor: null });
    return Response.json(grant);
  };
  const controls = new BrowserRelayControls(
    () => context,
    () => {},
    transport,
    () => now,
    () => mono,
  );
  return {
    controls,
    deviceId,
    calls,
    get grant() {
      return grant;
    },
    change() {
      context = { ownerId: randomUUID(), scope: "two" };
    },
    advance(ms: number) {
      now += ms;
      mono += ms;
    },
    rollback() {
      now--;
    },
    lose(value = true) {
      lose = value;
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      finish?.();
    },
    setGrant(value: PrivateRelayGrant) {
      grant = value;
    },
  };
}
test("browser connection review binds the inspected registration and consumes one acknowledged confirmation", async () => {
  const f = fixture();
  await f.controls.reviewBrowser();
  let review = f.controls.snapshot().review!;
  assert.equal(review.endpointId, f.deviceId);
  assert.equal(review.credentialEpoch, 2);
  assert.equal(review.expiresAt - review.started, 1800000);
  await f.controls.confirm(review.id, false);
  assert.equal(f.controls.snapshot().review, null);
  assert.equal(f.calls.filter((c) => c.path.endsWith("enable")).length, 0);
  await f.controls.reviewBrowser();
  review = f.controls.snapshot().review!;
  review.endpointId = randomUUID();
  review.expiresAt++;
  await f.controls.confirm(review.id, true);
  await f.controls.confirm(review.id, true);
  const calls = f.calls.filter((c) => c.path.endsWith("enable"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.deviceId, f.deviceId);
  assert.notEqual(calls[0]!.body.expiresAt, review.expiresAt);
  assert.equal(f.controls.snapshot().result?.state, "active");
});
test("Mac approval remains pending and lost replies are inspected by original operation without replay", async () => {
  const f = fixture();
  await f.controls.reviewMac(f.deviceId, 2);
  const review = f.controls.snapshot().review!;
  f.lose();
  await f.controls.confirm(review.id, true);
  assert.equal(
    f.controls.snapshot().uncertain?.operationId,
    review.operationId,
  );
  assert.match(f.controls.snapshot().error, /not been retried/);
  await f.controls.reviewMac(f.deviceId, 2);
  assert.equal(f.controls.snapshot().review, null);
  await f.controls.checkUncertain();
  assert.equal(f.controls.snapshot().result?.state, "pending");
  assert.equal(f.controls.snapshot().uncertain, null);
  assert.equal(f.calls.filter((c) => c.path.endsWith("mac/approve")).length, 1);
  assert.deepEqual(f.calls.at(-1)!.body, { operationId: review.operationId });
});
test("expired, rolled-back and account-switched reviews cannot issue a mutation", async () => {
  for (const mode of ["expire", "rollback", "account"] as const) {
    const f = fixture();
    await f.controls.reviewMac(f.deviceId, 2);
    const review = f.controls.snapshot().review!;
    if (mode === "expire") f.advance(120000);
    else if (mode === "rollback") f.rollback();
    else f.change();
    await f.controls.confirm(review.id, true);
    assert.equal(f.calls.filter((c) => c.path.endsWith("approve")).length, 0);
    assert.equal(f.controls.snapshot().review, null);
  }
});
test("hidden or superseded permission reviews discard late endpoint responses", async () => {
  const f = fixture();
  f.hold();
  const review = f.controls.reviewMac(f.deviceId, 2);
  f.controls.hide();
  f.release();
  await review;
  assert.equal(f.controls.snapshot().review, null);
  assert.equal(f.controls.snapshot().busy, false);
  assert.equal(f.calls.length, 1);
});
test("cancelled in-flight approval preserves uncertainty until explicit inspection", async () => {
  const f = fixture();
  await f.controls.reviewMac(f.deviceId, 2);
  const review = f.controls.snapshot().review!;
  f.hold();
  const pending = f.controls.confirm(review.id, true);
  f.controls.hide();
  f.release();
  await pending;
  assert.equal(f.controls.snapshot().result, null);
  assert.equal(
    f.controls.snapshot().uncertain?.operationId,
    review.operationId,
  );
  await f.controls.checkUncertain();
  assert.equal(f.controls.snapshot().result?.state, "pending");
  assert.equal(f.calls.filter((c) => c.path.endsWith("approve")).length, 1);
});
test("owner revocation uses a fresh revision and lost replies remain unconfirmed until inspection", async () => {
  const f = fixture();
  await f.controls.reviewMac(f.deviceId, 2);
  await f.controls.confirm(f.controls.snapshot().review!.id, true);
  const original = f.grant!;
  f.setGrant({
    ...original,
    state: "active",
    approvalExpiresAt: null,
    revision: 2,
  });
  await f.controls.load();
  await f.controls.reviewRevoke(original.id);
  const review = f.controls.snapshot().review!;
  assert.equal(review.current?.revision, 2);
  f.lose();
  await f.controls.confirm(review.id, true);
  assert.equal(f.controls.snapshot().result, null);
  assert.equal(f.controls.snapshot().uncertain?.permissionId, original.id);
  await f.controls.checkUncertain();
  assert.equal(f.controls.snapshot().result?.state, "revoked");
  assert.equal(f.calls.filter((c) => c.path.endsWith("revoke")).length, 1);
  assert.equal(
    f.calls.find((c) => c.path.endsWith("revoke"))!.body.expectedRevision,
    2,
  );
});

test("forgetting an uncertain reference requires acknowledgement and a new exact review without automatic mutation", async () => {
  const f = fixture();
  await f.controls.reviewMac(f.deviceId, 2);
  f.lose();
  await f.controls.confirm(f.controls.snapshot().review!.id, true);
  f.controls.forgetUncertain(false);
  assert.ok(f.controls.snapshot().uncertain);
  f.controls.forgetUncertain(true);
  assert.equal(f.controls.snapshot().uncertain, null);
  assert.equal(f.calls.filter((c) => c.path.endsWith("approve")).length, 1);
  await f.controls.reviewMac(f.deviceId, 2);
  assert.equal(f.controls.snapshot().review?.current?.id, f.grant!.id);
  assert.equal(f.calls.filter((c) => c.path.endsWith("approve")).length, 1);
});
