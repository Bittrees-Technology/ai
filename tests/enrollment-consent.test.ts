import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EnrollmentConsent } from "../modules/task-sync/enrollment-consent.js";
function fixture() {
  let now = 100000,
    allowed = true,
    revoked = 0;
  let cost: unknown | null = null;
  let scope = {
    principal: "agent:" + randomUUID(),
    publicKey: generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString(),
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
  };
  return {
    consent: new EnrollmentConsent(
      () => scope,
      () => allowed,
      () => {
        revoked++;
      },
      () => now,
      () => {},
      () => cost,
    ),
    setCost: (value: unknown | null) => {
      cost = value;
    },
    advance: () => {
      now += 300000;
    },
    deny: () => {
      allowed = false;
    },
    change: () => {
      scope = { ...scope, deviceId: randomUUID() };
    },
    revoked: () => revoked,
  };
}
test("native review requires exact explicit approval and cannot extend its deadline", () => {
  const f = fixture();
  const proposal = f.consent.propose();
  assert.equal(f.consent.current(), null);
  assert.equal(proposal.disclosure.grantsWorkflowAuthority, false);
  assert.throws(() => f.consent.approve("wrong"));
  const review = f.consent.approve(proposal.digest);
  assert.equal(review.expiresAt, 400000);
  assert.equal(f.consent.current(), review);
  assert.throws(() => f.consent.propose());
  assert.throws(() => f.consent.approve(proposal.digest));
  f.advance();
  assert.equal(f.consent.current(), null);
  assert.equal(f.revoked(), 1);
  assert.throws(() => f.consent.approve(proposal.digest));
});
for (const gate of ["deny", "change"] as const)
  test(gate + " invalidates pending and approved consent", () => {
    for (const approved of [false, true]) {
      const f = fixture();
      const proposal = f.consent.propose();
      if (approved) f.consent.approve(proposal.digest);
      f[gate]();
      if (approved) assert.equal(f.consent.current(), null);
      else assert.throws(() => f.consent.approve(proposal.digest));
      assert.equal(f.revoked(), 1);
    }
  });
test("revocation invalidates old approval even when a new native proposal is prepared", () => {
  const f = fixture();
  const old = f.consent.propose();
  f.consent.approve(old.digest);
  f.consent.revoke();
  const next = f.consent.propose();
  assert.notEqual(next.review.epoch, old.review.epoch);
  assert.throws(() => f.consent.approve(old.digest));
  assert.equal(f.consent.current(), null);
});

test("paid native consent discloses one shared limit and revokes when any funded scope changes", () => {
  const cost = {
    approvalId: randomUUID(),
    reference: "synthetic-owner-approval",
    pricingReference: "synthetic-price-evidence",
    authorizedAt: 90000,
    authorizationExpiresAt: 200000,
    approvedAt: 90000,
    expiresAt: 200000,
    providers: ["neon", "vercel"],
    maximumMicroUSD: 1000000,
    maximumAttempts: 108,
    ceilings: {
      enrollment: 10000,
      central: 10000,
      assignment: 10000,
      attestation: 10000,
    },
  };
  for (const approved of [false, true]) {
    const f = fixture();
    f.setCost(cost);
    const p = f.consent.propose();
    assert.equal(p.review.expiresAt, cost.expiresAt);
    assert.equal("additionalSpendingUSD" in p.disclosure, false);
    assert.equal(
      "maximumAdditionalMicroUSD" in p.disclosure &&
        p.disclosure.maximumAdditionalMicroUSD,
      1000000,
    );
    assert.equal(
      "limitScope" in p.disclosure && p.disclosure.limitScope,
      "shared-native-runtime",
    );
    if (approved) f.consent.approve(p.digest);
    f.setCost({ ...cost, pricingReference: "changed-price-evidence" });
    if (approved) assert.equal(f.consent.current(), null);
    else assert.throws(() => f.consent.approve(p.digest));
    assert.equal(f.revoked(), 1);
  }
  const f = fixture();
  f.setCost({ ...cost, maximumMicroUSD: 10000001 });
  assert.throws(() => f.consent.propose());
});
