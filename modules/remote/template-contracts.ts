import { z } from "zod";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const templateIdentitySchema = z.strictObject({
  scope: z.literal("templates:run"),
  remoteOwnerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  permissionId: z.uuid(),
});
export const templateApprovalSchema = z.strictObject({
  identity: templateIdentitySchema,
  templateId: z.uuid(),
  templateRevision: positive,
  maxRuns: z.number().int().min(1).max(20),
  expiresAt: positive,
  confirmed: z.literal(true),
});
export const templateReceiptSchema = z
  .strictObject({
    id: z.uuid(),
    deviceId: z.uuid(),
    outcome: z.enum(["queued", "expired", "denied", "capacity"]),
    taskId: z.uuid().optional(),
    completedAt: z.iso.datetime(),
  })
  .refine((value) => (value.outcome === "queued") === !!value.taskId);
