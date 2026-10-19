import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { runtimeEnrollmentSchema } from "./runtime-contract.js";
import type { EnrollmentReview } from "./enrollment-transport-plan.js";
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
const disclosure = Object.freeze({
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
  additionalSpendingUSD: 0,
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
  };
  private approved = false;
  constructor(
    private readonly trustedScope: () => unknown,
    private readonly costAllowed: () => boolean,
    private readonly onRevoke: () => void,
    private readonly now = Date.now,
  ) {}
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
    const scope = this.scope();
    const review = Object.freeze({
      ...scope,
      epoch: randomUUID(),
      expiresAt: now + 300000,
    });
    const digest = hash({ review, disclosure });
    this.pending = { review, digest, scopeDigest: hash(scope), issuedAt: now };
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
