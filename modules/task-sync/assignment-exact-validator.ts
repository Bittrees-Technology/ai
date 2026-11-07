import { z } from "zod";
import { digest } from "./proof-contract.js";
import { assignmentValidationInput } from "./assignment-contract.js";

export const exactOutcomeValidator = Object.freeze({
  id: "owner-pinned-outcome-v1",
  revision: digest({
    version: 1,
    rule: "Exact reviewed assignment, source instruction and expected result digests; no model judgment or inference of external effects",
  }),
});
export const exactOutcomeCriteria = z
  .array(
    z.strictObject({
      assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
      resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceReference: z.string().min(1).max(1024),
      reviewedAt: z.int().positive(),
    }),
  )
  .min(1)
  .max(60)
  .refine(
    (rows) => new Set(rows.map((r) => r.assignmentDigest)).size === rows.length,
  );
export function exactOutcomeValidatorPin(raw: unknown) {
  const criteria = exactOutcomeCriteria.parse(raw);
  return {
    id: exactOutcomeValidator.id,
    revision: digest({ algorithm: exactOutcomeValidator.revision, criteria }),
  };
}
/** Independent exact-outcome acceptance only. The owner must establish the
 * expected outcome from authoritative evidence before approval. This cannot
 * validate unknown facts, arbitrary research or a claimed external action.
 * Unsupported work remains held; model output never supplies these criteria. */
export function validateExactOutcome(
  raw: unknown,
  criteria: z.infer<typeof exactOutcomeCriteria>,
  approvedAt: number,
  expiresAt: number,
  now = Date.now(),
) {
  const input = assignmentValidationInput.parse(raw),
    row = criteria.find((c) => c.assignmentDigest === digest(input.assignment));
  if (
    !row ||
    row.reviewedAt > approvedAt ||
    approvedAt > now ||
    expiresAt <= now ||
    row.inputDigest !== input.inputDigest ||
    row.resultDigest !== input.resultDigest ||
    digest(input.result) !== input.resultDigest ||
    input.claim.assignmentDigest !== row.assignmentDigest ||
    input.claim.expiresAt <= now
  )
    throw Error("Independent reviewed outcome was not established");
  return {
    accepted: true as const,
    validatorId: exactOutcomeValidator.id,
    validatorRevision: exactOutcomeValidatorPin(criteria).revision,
    assignmentDigest: row.assignmentDigest,
    crmOperationId: input.crmOperationId,
    inputDigest: input.inputDigest,
    resultDigest: input.resultDigest,
    checkedAt: now,
    expiresAt: Math.min(now + 30000, expiresAt, input.claim.expiresAt),
  };
}
