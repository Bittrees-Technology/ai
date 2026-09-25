import { z } from "zod";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Separate identity from status publication, pause/cancel and task submission. */
export const resumeIdentitySchema = z.strictObject({
  scope: z.literal("tasks:resume"),
  remoteOwnerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  permissionId: z.uuid(),
});
export const resumeApprovalSchema = z.strictObject({
  identity: resumeIdentitySchema,
  taskId: z.uuid(),
  taskRevision: positive,
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: positive,
  confirmed: z.literal(true),
});
export const resumeCommandSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  deviceId: z.uuid(),
  permissionId: z.uuid(),
  taskId: z.uuid(),
  expectedRevision: positive,
  command: z.literal("resume"),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const resumeReceiptSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  deviceId: z.uuid(),
  permissionId: z.uuid(),
  taskId: z.uuid(),
  taskRevision: positive,
  outcome: z.enum(["queued", "awaiting_input"]),
  completedAt: z.iso.datetime(),
});
