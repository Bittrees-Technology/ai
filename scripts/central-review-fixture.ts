import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { CentralNativeService } from "../modules/workflows/central-native-service.js";
import type { CentralNativeReview } from "../modules/workflows/central-native-owner.js";
const pair = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const time = Date.now(),
  period = {
    epoch: randomUUID(),
    approvedAt: time - 1000,
    expiresAt: time + 120000,
  };
const review: CentralNativeReview = {
  ownerWallet: "0x" + "a".repeat(40),
  scope: {
    ...period,
    principal: "agent:" + randomUUID(),
    publicKey: pair.publicKey,
    credentialId: createHash("sha256").update(pair.publicKey).digest("hex"),
    delegationId: randomUUID(),
    tenant: "synthetic/ação",
    workspace: "synthetic-workspace",
    workflowId: "synthetic/workflow",
    connectionId: randomUUID(),
  },
  budget: {
    ...period,
    costBasis: "verified-included-usage",
    maximumAttempts: 3,
    maximumMicroUSD: 0,
    attemptCeilingMicroUSD: 0,
    evidenceId: "synthetic-included-proof",
  },
};
const proposals = [];
for (const budget of [
  review.budget,
  {
    ...period,
    costBasis: "explicit-one-time-approval" as const,
    maximumAttempts: 3,
    maximumMicroUSD: 1000000,
    attemptCeilingMicroUSD: 50000,
    evidenceId: "synthetic-price-ceiling",
  },
]) {
  const service = new CentralNativeService(
    () => ({ ...review, budget }),
    () => true,
    () => {
      throw Error("Fixture must never open a session");
    },
  );
  proposals.push(service.propose());
  await service.close();
}
process.stdout.write(JSON.stringify(proposals));
