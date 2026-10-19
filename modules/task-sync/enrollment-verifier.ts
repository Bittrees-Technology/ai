import { z } from "zod";
import type { EnrollmentReview } from "./enrollment-transport-plan.js";
import { enrollmentOperation } from "./enrollment-transport-plan.js";
import {
  validateEnrollmentStart,
  validateEnrollmentPoll,
  validateEnrollmentComplete,
  validateEnrollmentAttestation,
} from "./enrollment-response.js";
const time = z.iso.datetime({ offset: true });
const heartbeat = z.strictObject({
  grant: z.strictObject({
    id: z.uuid(),
    wallet_address: z.string(),
    device_label: z.string().max(1000),
    device_id: z.uuid(),
    model_label: z.string().max(1000),
    paused_at: time.nullable(),
    revoked_at: time.nullable(),
    signed_at: time.nullable(),
    require_wallet: z.boolean(),
    approval_expires_at: time.nullable(),
    last_seen_at: time.nullable(),
  }),
  activity: z.array(z.unknown()).max(25),
  runs: z.array(z.unknown()).max(30),
  approvalUrl: z.literal("https://ai.bittrees.org/workflows"),
});
/** Response validation for the inactive exchange. Context comes only from reviewed,
 * persisted owner state. A response cannot supply its own signer or grant context.
 * This does not dispatch, install a grant, or claim source execution authority.
 */
export class EnrollmentResponseVerifier {
  constructor(
    private current: () => EnrollmentReview | null,
    private challenge: () => unknown,
    private pinnedSigner: string,
    private now = Date.now,
  ) {}
  verify = (
    operation: z.infer<typeof enrollmentOperation>,
    raw: unknown,
  ): void => {
    const review = this.current(),
      now = this.now();
    if (!review || !Number.isSafeInteger(now) || review.expiresAt <= now)
      throw Error("Enrollment review unavailable");
    switch (operation.operation) {
      case "heartbeat": {
        const { grant } = heartbeat.parse(raw);
        if (
          grant.id !== review.authorityId ||
          grant.device_id !== review.deviceId ||
          grant.wallet_address !== review.ownerWallet ||
          !grant.signed_at ||
          Date.parse(grant.signed_at) > now ||
          grant.paused_at ||
          grant.revoked_at ||
          (grant.approval_expires_at &&
            Date.parse(grant.approval_expires_at) <= now)
        )
          throw Error("Current signed device authority required");
        return;
      }
      case "start":
        validateEnrollmentStart(raw, review, now);
        return;
      case "poll":
        if (z.object({ status: z.string() }).parse(raw).status === "complete")
          validateEnrollmentComplete(raw, review, this.challenge(), now);
        else validateEnrollmentPoll(raw, review, now);
        return;
      case "attest":
        validateEnrollmentAttestation(
          raw,
          review,
          operation.request,
          this.pinnedSigner,
          now,
        );
        return;
      case "complete":
        validateEnrollmentComplete(raw, review, operation.proof.request, now);
        return;
    }
  };
}
