import { z } from "zod";
import { remoteTemplateSchema } from "./status.js";
const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mcpActorSchema = z.strictObject({
  tenant: identity,
  subject: identity,
  actorId: z.string().regex(/^[a-f0-9]{64}$/),
});
export const mcpDelegationRequestSchema = z.strictObject({
  id: z.uuid(),
  actor: mcpActorSchema,
  challenge: opaque,
  approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const mcpDelegationApprovalSchema = z.strictObject({
  id: z.uuid(),
  approvalCode: opaque,
  permissionId: z.uuid(),
  expectedTemplateRevision: positive,
  maxRuns: z.number().int().min(1).max(20),
  expiresAt: positive,
  confirmed: z.literal(true),
});
export const mcpDelegationRedeemSchema = z.strictObject({
  id: z.uuid(),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  expectedOwnerId: z.uuid(),
  actor: mcpActorSchema,
  confirmed: z.literal(true),
});

export const mcpDispatchSchema = z.strictObject({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  automationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  ...mcpActorSchema.shape,
  grantId: z.uuid(),
  permissionId: z.uuid(),
  command: remoteTemplateSchema,
});
