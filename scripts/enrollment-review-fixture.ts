import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EnrollmentConsent } from "../modules/task-sync/enrollment-consent.js";
const scope = {
  principal: "agent:" + randomUUID(),
  publicKey: generateKeyPairSync("ed25519")
    .publicKey.export({ format: "pem", type: "spki" })
    .toString(),
  authorityId: randomUUID(),
  deviceId: randomUUID(),
  sourceWorkspace: randomUUID(),
  ownerWallet: "0x" + "a".repeat(40),
};
const now = Date.now();
const cost = process.argv.includes("--paid")
  ? {
      approvalId: randomUUID(),
      reference: "synthetic-owner-approval-not-live",
      pricingReference: "synthetic-price-evidence",
      authorizedAt: now - 1000,
      authorizationExpiresAt: now + 60000,
      approvedAt: now - 1000,
      expiresAt: now + 60000,
      providers: ["neon", "vercel"],
      maximumMicroUSD: 1000000,
      maximumAttempts: 108,
      ceilings: {
        enrollment: 10000,
        central: 10000,
        assignment: 10000,
        attestation: 10000,
      },
    }
  : null;
// Ephemeral public identity only. No real owner, keychain, transport or grant.
console.log(
  JSON.stringify(
    new EnrollmentConsent(
      () => scope,
      () => true,
      () => {},
      Date.now,
      () => {},
      () => cost,
      process.argv.includes("--central") ? "central-workflows" : "task-sync",
    ).propose(),
  ),
);
