import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { NativeInitialPairingReviewActions } from "../modules/task-sync/initial-pairing-native-review.js";
import type { InitialPairingConsent } from "../modules/task-sync/initial-pairing.js";
function fixture() {
  const pem = () =>
    generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
  const state = {
    now: 100000,
    admitted: true,
    admissions: 0,
    created: 0,
    starts: 0,
    polls: 0,
    closed: 0,
    unknown: false,
    wrongSource: false,
    delay: undefined as Promise<void> | undefined,
    consent: undefined as undefined | (() => InitialPairingConsent | null),
  };
  const options = {
    identity: { principal: "agent:" + randomUUID(), publicKey: pem() },
    rolesPublicKey: pem(),
    now: () => state.now,
    admitSource: () => {
      state.admissions++;
      if (!state.admitted) throw Error("source purpose unavailable");
    },
    createSession: (consent: () => InitialPairingConsent | null) => {
      state.created++;
      state.consent = consent;
      return {
        reviewBinding() {
          return {
            principal: options.identity.principal,
            keyFingerprint: createHash("sha256")
              .update(options.identity.publicKey)
              .digest("hex"),
            rolesKeyFingerprint: state.wrongSource
              ? "f".repeat(64)
              : createHash("sha256")
                  .update(options.rolesPublicKey)
                  .digest("hex"),
          };
        },
        async start() {
          state.starts++;
          if (state.unknown) throw Error("unknown synthetic start");
          const expiresAt = consent()!.expiresAt;
          await state.delay;
          return {
            status: "pending",
            reviewUrl: "https://roles.bittrees.org/profile",
            expiresAt,
            permissionsGranted: false,
          };
        },
        async poll() {
          state.polls++;
          return {
            status: "pending" as const,
            expiresAt: consent()!.expiresAt,
            permissionsGranted: false as const,
          };
        },
        async close() {
          state.closed++;
        },
      };
    },
  };
  return { state, actions: new NativeInitialPairingReviewActions(options) };
}
test("preparing exact metadata scope creates no session, source action or authority", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  assert.equal(f.state.created, 0);
  assert.equal(f.state.admissions, 0);
  assert.equal(p.review.permissionsGranted, false);
  assert.equal(p.review.runtimeEnrolled, false);
  assert.equal(p.review.walletOrSafeApproval, false);
  assert.equal(p.review.expiresAt, 400000);
  assert.equal(
    p.review.startEndpoint,
    "https://roles.bittrees.org/api/mcp/pairing/start",
  );
  p.review.principal = "agent:" + randomUUID();
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: "f".repeat(64) }),
  );
  assert.equal(f.state.created, 0);
  await f.actions.close();
});
test("stale/replaced review, changed digest and scope expansion deny before session creation", async () => {
  const f = fixture(),
    old = f.actions.prepare(),
    p = f.actions.prepare();
  await assert.rejects(
    f.actions.approve({ reviewId: old.review.reviewId, digest: old.digest }),
  );
  await assert.rejects(
    f.actions.approve({
      reviewId: p.review.reviewId,
      digest: p.digest,
      permissionsGranted: true,
    }),
  );
  assert.equal(f.state.created, 0);
  await f.actions.close();
});
test("exact native confirmation is single-use and never extends the reviewed expiry", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  f.state.now += 120000;
  const result = await f.actions.approve({
    reviewId: p.review.reviewId,
    digest: p.digest,
  });
  assert.equal(result.permissionsGranted, false);
  assert.equal(f.state.consent!()!.expiresAt, p.review.expiresAt);
  assert.equal(f.state.starts, 1);
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
    /single-use/,
  );
  await f.actions.poll();
  assert.equal(f.state.polls, 1);
  await f.actions.close();
  assert.equal(f.state.consent!(), null);
  await assert.rejects(f.actions.poll());
});
test("expired confirmation cannot start; source denial consumes approval without creating a session", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  f.state.now = p.review.expiresAt;
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
  );
  assert.equal(f.state.created, 0);
  const g = fixture(),
    q = g.actions.prepare();
  g.state.admitted = false;
  await assert.rejects(
    g.actions.approve({ reviewId: q.review.reviewId, digest: q.digest }),
    /source purpose/,
  );
  g.state.admitted = true;
  await assert.rejects(
    g.actions.approve({ reviewId: q.review.reviewId, digest: q.digest }),
    /single-use/,
  );
  assert.equal(g.state.created, 0);
  await f.actions.close();
  await g.actions.close();
});
test("unknown start clears consent and drains session; approval replay cannot retry", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  f.state.unknown = true;
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
    /unknown/,
  );
  assert.equal(f.state.consent!(), null);
  assert.equal(f.state.closed, 1);
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
  );
  assert.equal(f.state.starts, 1);
  await f.actions.close();
});
test("source revocation and consent expiry deny polling without another source session", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  await f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest });
  f.state.admitted = false;
  await assert.rejects(f.actions.poll(), /source purpose/);
  assert.equal(f.state.polls, 0);
  f.state.admitted = true;
  f.state.now = p.review.expiresAt;
  await assert.rejects(f.actions.poll());
  assert.equal(f.state.polls, 0);
  await f.actions.close();
});
test("clock rollback cannot extend a review beyond five minutes", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  f.state.now -= 1;
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
  );
  assert.equal(f.state.created, 0);
  await f.actions.close();
});
test("cancellation rejects a late successful session result and clears consent", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  let release!: () => void;
  f.state.delay = new Promise<void>((resolve) => (release = resolve));
  const pending = f.actions.approve({
    reviewId: p.review.reviewId,
    digest: p.digest,
  });
  const denied = assert.rejects(pending, /cancelled/);
  assert.equal(f.state.starts, 1);
  await f.actions.close();
  assert.equal(f.state.consent!(), null);
  release();
  await denied;
  assert.equal(f.state.starts, 1);
});
test("a substituted session source key is denied before signing or transport starts", async () => {
  const f = fixture(),
    p = f.actions.prepare();
  f.state.wrongSource = true;
  await assert.rejects(
    f.actions.approve({ reviewId: p.review.reviewId, digest: p.digest }),
    /does not match reviewed/,
  );
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.consent!(), null);
  await f.actions.close();
});
