import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { NativeInitialPairingReviewActions } from "../modules/task-sync/initial-pairing-native-review.js";
const pem = () =>
  generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
const identity = { principal: "agent:" + randomUUID(), publicKey: pem() },
  rolesPublicKey = pem(),
  now = Date.now();
const actions = new NativeInitialPairingReviewActions({
  identity,
  rolesPublicKey,
  now: () => now,
  admitSource: () => {
    throw Error("Fixture must not admit a source");
  },
  createSession: () => {
    throw Error("Fixture must not create a session");
  },
});
const proposal = actions.prepare();
function changed(updates: Record<string, unknown>) {
  const review = { ...proposal.review, ...updates };
  // Deliberately bypass the production safe-integer gate only in this fixture:
  // native validation must independently reject attacker-rehashed malformed types.
  const inner = createHash("sha256")
    .update(JSON.stringify(review, Object.keys(review).sort()))
    .digest("hex");
  return {
    review,
    digest: createHash("sha256")
      .update("Bittrees native initial pairing scope review v1\n" + inner)
      .digest("hex"),
  };
}
// Synthetic public keys and metadata only. Scope mutations are re-digested in
// Node; envelope/digest attacks are also included. Swift independently checks scope/types.
const invalid = [
  { name: "runtime enrollment", proposal: changed({ runtimeEnrolled: true }) },
  { name: "numeric false", proposal: changed({ permissionsGranted: 0 }) },
  { name: "boolean version", proposal: changed({ version: true }) },
  {
    name: "wallet approval",
    proposal: changed({ walletOrSafeApproval: true }),
  },
  { name: "new owner ID", proposal: changed({ ownerProfile: randomUUID() }) },
  {
    name: "other endpoint",
    proposal: changed({
      startEndpoint: "https://roles.bittrees.org/api/other",
    }),
  },
  {
    name: "source already approved",
    proposal: changed({ sourceAdmission: "already approved" }),
  },
  { name: "increased calls", proposal: changed({ maximumCalls: 63 }) },
  {
    name: "increased duration",
    proposal: changed({ maximumDurationSeconds: 301 }),
  },
  {
    name: "positive spending",
    proposal: changed({ additionalSpendingUSD: 1 }),
  },
  {
    name: "fractional expiry",
    proposal: changed({ expiresAt: proposal.review.expiresAt + 0.5 }),
  },
  {
    name: "extended expiry",
    proposal: changed({ expiresAt: proposal.review.expiresAt + 1 }),
  },
  {
    name: "changed identity",
    proposal: changed({ principal: "agent:" + randomUUID() }),
  },
  {
    name: "changed local key",
    proposal: changed({ keyFingerprint: "a".repeat(64) }),
  },
  {
    name: "changed source key",
    proposal: changed({ rolesKeyFingerprint: "b".repeat(64) }),
  },
  { name: "wrong digest", proposal: { ...proposal, digest: "0".repeat(64) } },
  { name: "extra envelope", proposal: { ...proposal, approve: true } },
];
console.log(
  JSON.stringify({
    now,
    proposal,
    expected: {
      principal: identity.principal,
      keyFingerprint: createHash("sha256")
        .update(identity.publicKey)
        .digest("hex"),
      rolesKeyFingerprint: createHash("sha256")
        .update(rolesPublicKey)
        .digest("hex"),
    },
    invalid,
  }),
);
