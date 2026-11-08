import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { runtimeEnrollmentSchema } from "./runtime-contract.js";
import type { EnrollmentReview } from "./enrollment-transport-plan.js";
import { nativeRuntimeCostApproval } from "./native-runtime-cost.js";
const scopeSchema = runtimeEnrollmentSchema
  .pick({
    principal: true,
    publicKey: true,
    authorityId: true,
    deviceId: true,
    sourceWorkspace: true,
  })
  .extend({ ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/) })
  .strict();
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const baseDisclosure = Object.freeze({
  purpose: "Enroll this Mac in Roles; no workflow execution permission",
  hosts: Object.freeze(["ai.bittrees.org", "roles.bittrees.org"]),
  operations: Object.freeze([
    "heartbeat",
    "start",
    "poll",
    "attest",
    "complete",
  ]),
  maximumDurationSeconds: 300,
  maximumCalls: 108,
  maximumPolls: 100,
  grantsWorkflowAuthority: false,
});
/** Inactive native consent state. Only the separately authenticated native owner
 * surface may call propose/approve. Never expose these through model/core IPC.
 * Approval permits only the reviewed transport; Roles/wallet approval stays separate.
 */
export class EnrollmentConsent {
  private pending?: {
    review: EnrollmentReview;
    digest: string;
    scopeDigest: string;
    issuedAt: number;
    disclosureDigest: string;
  };
  private approved = false;
  constructor(
    private readonly trustedScope: () => unknown,
    private readonly costAllowed: () => boolean,
    private readonly onRevoke: () => void,
    private readonly now = Date.now,
    private readonly onApprove: (review: EnrollmentReview) => void = () => {},
    private readonly costReview: () => unknown | null = () => null,
    private readonly identityPurpose:
      "task-sync" | "central-workflows" = "task-sync",
  ) {}
  private disclosure() {
    const raw = this.costReview();
    const base = {
      ...baseDisclosure,
      purpose:
        this.identityPurpose === "central-workflows"
          ? "Enroll this Mac's central Workflows identity in Roles; no workflow execution permission"
          : baseDisclosure.purpose,
    };
    if (raw === null)
      return Object.freeze({ ...base, additionalSpendingUSD: 0 });
    const approval = nativeRuntimeCostApproval.parse(raw),
      now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      now < approval.approvedAt ||
      now >= approval.expiresAt
    )
      throw Error("Current explicit enrollment cost approval required");
    return Object.freeze({
      ...base,
      costBasis: "explicit-one-time-approval" as const,
      maximumAdditionalMicroUSD: approval.maximumMicroUSD,
      maximumAggregateAttempts: approval.maximumAttempts,
      approvalId: approval.approvalId,
      approvalReference: approval.reference,
      approvalDigest: hash(approval),
      approvalExpiresAt: approval.expiresAt,
      limitScope: "shared-native-runtime" as const,
    });
  }
  private scope() {
    const scope = scopeSchema.parse(this.trustedScope());
    const key = createPublicKey(scope.publicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      key.export({ format: "pem", type: "spki" }).toString() !== scope.publicKey
    )
      throw Error("Canonical Ed25519 device identity required");
    return scope;
  }
  propose() {
    if (this.pending)
      throw Error("Resolve existing native enrollment review first");
    const now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now + 300000) ||
      !this.costAllowed()
    )
      throw Error("Enrollment cost scope unavailable");
    const scope = this.scope(),
      disclosure = this.disclosure();
    const review = Object.freeze({
      ...scope,
      epoch: randomUUID(),
      expiresAt: Math.min(
        now + 300000,
        "approvalExpiresAt" in disclosure
          ? disclosure.approvalExpiresAt
          : Infinity,
      ),
    });
    const digest = hash({ review, disclosure });
    this.pending = {
      review,
      digest,
      scopeDigest: hash(scope),
      issuedAt: now,
      disclosureDigest: hash(disclosure),
    };
    return Object.freeze({ review, disclosure, digest });
  }
  private valid() {
    const p = this.pending;
    if (!p) return false;
    try {
      const now = this.now();
      if (
        !Number.isSafeInteger(now) ||
        now < p.issuedAt ||
        now >= p.review.expiresAt ||
        !this.costAllowed() ||
        hash(this.disclosure()) !== p.disclosureDigest ||
        hash(this.scope()) !== p.scopeDigest
      )
        throw Error("Native enrollment scope changed");
      return true;
    } catch {
      this.revoke();
      return false;
    }
  }
  approve(digest: string) {
    if (this.approved) throw Error("Enrollment consent already used");
    if (!this.valid() || digest !== this.pending?.digest)
      throw Error("Exact current native review required");
    this.approved = true;
    try {
      this.onApprove(this.pending!.review);
    } catch (error) {
      this.revoke();
      throw error;
    }
    return this.pending!.review;
  }
  current(): EnrollmentReview | null {
    return this.approved && this.valid() ? this.pending!.review : null;
  }
  revoke() {
    const existed = !!this.pending;
    this.pending = undefined;
    this.approved = false;
    if (existed) this.onRevoke();
  }
}
