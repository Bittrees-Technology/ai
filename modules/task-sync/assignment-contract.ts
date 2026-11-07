import { z } from "zod";
import { digest } from "./proof-contract.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const assignmentSchema = z.strictObject({
  assignmentId: z.uuid(),
  taskId: z.uuid(),
  taskRevision: z.int().positive(),
  projectId: z.uuid(),
  workflowId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  workflowRevision: z.int().positive(),
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
});
export const assignmentClaimSchema = z.strictObject({
  assignmentDigest: hex,
  runId: z.uuid(),
  leaseId: z.uuid(),
  expiresAt: z.int().positive(),
});
export const assignmentResultSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
});
export const assignmentValidatorSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  revision: hex,
});
export const assignmentValidationInput = z.strictObject({
  assignment: assignmentSchema,
  claim: assignmentClaimSchema,
  crmOperationId: z.uuid(),
  inputDigest: hex,
  resultDigest: hex,
  result: assignmentResultSchema,
});
export const assignmentValidationReceipt = z.strictObject({
  accepted: z.literal(true),
  validatorId: assignmentValidatorSchema.shape.id,
  validatorRevision: hex,
  assignmentDigest: hex,
  crmOperationId: z.uuid(),
  inputDigest: hex,
  resultDigest: hex,
  checkedAt: z.int(),
  expiresAt: z.int(),
});
export function checkAssignmentValidation(
  raw: unknown,
  input: z.infer<typeof assignmentValidationInput>,
  pin: z.infer<typeof assignmentValidatorSchema>,
  now = Date.now(),
) {
  const receipt = assignmentValidationReceipt.parse(raw);
  if (
    input.claim.assignmentDigest !== digest(input.assignment) ||
    digest(input.result) !== input.resultDigest ||
    receipt.validatorId !== pin.id ||
    receipt.validatorRevision !== pin.revision ||
    receipt.assignmentDigest !== digest(input.assignment) ||
    receipt.crmOperationId !== input.crmOperationId ||
    receipt.inputDigest !== input.inputDigest ||
    receipt.resultDigest !== input.resultDigest ||
    input.claim.expiresAt <= now ||
    receipt.expiresAt > input.claim.expiresAt ||
    receipt.checkedAt > now + 1000 ||
    receipt.checkedAt < now - 30000 ||
    receipt.expiresAt <= now ||
    receipt.expiresAt <= receipt.checkedAt ||
    receipt.expiresAt - receipt.checkedAt > 30000
  )
    throw Error("Assignment validation binding or freshness rejected");
  return receipt;
}
