import {
  prepareAgentWalletPolicyChange,
  agentWalletLifecycleView,
} from "./agent-wallet-policy.mjs";
// Presentation of an imported draft, never source/chain evidence or activation.
export function reviewNativeWalletDraft(input, now = Date.now()) {
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).sort().join("|") !== "current|proposed" ||
    Buffer.byteLength(JSON.stringify(input)) > 131072
  )
    throw Error("Expected current and proposed wallet policy documents");
  const review = prepareAgentWalletPolicyChange(input.current, input.proposed, {
    now,
  });
  const previous = review.current;
  return {
    schema: "bittrees.native.wallet-draft-review.v1",
    chain: "Ethereum mainnet",
    agentId: review.proposed.agentId,
    safe: review.proposed.safe,
    signer: review.proposed.signer,
    duration: review.proposed.duration,
    expectedRevision: review.expectedRevision,
    proposedRevision: review.proposed.revision,
    expectedPolicyDigest: review.expectedPolicyDigest,
    proposedPolicyDigest: review.proposedPolicyDigest,
    changedFields: review.changedFields,
    comparison: review.changedFields.map((field) => ({
      field,
      current: previous?.[field] ?? null,
      proposed: review.proposed[field],
    })),
    status: previous
      ? "Amendment draft — supplied current limits are not verified"
      : "Initial policy draft — no wallet connection verified",
    whilePending: previous
      ? "Existing confirmed limits continue until the amended policy is approved and confirmed. This imported document does not establish those current limits."
      : "No wallet authority is established by this review.",
    lifecycle: agentWalletLifecycleView({
      desired: "active",
      observed: "unverified",
      pendingChange: Boolean(previous),
    }),
    enforcementHolds: review.activationHolds,
    requiresSafeApproval: true,
    requiresNativeApproval: true,
    transactionKeyCreated: false,
    grantsAuthority: false,
    canActivate: false,
    sourceEvidence:
      "Imported draft only; agent binding, source approval, wallet ownership and chain enforcement are unverified.",
    amendmentBoundary:
      "An amendment does not recreate authority, reset usage counters, clear suspension or resume an expired policy.",
  };
}
