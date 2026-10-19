import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EnrollmentConsent } from "../modules/task-sync/enrollment-consent.js";
function fixture() {
  let now = 100000,
    allowed = true,
    revoked = 0;
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
    ),
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
