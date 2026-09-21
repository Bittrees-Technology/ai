import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const crmProposalSchema = z.strictObject({
  operationId: z.uuid(),
  targetId: z.uuid(),
  kind: z.enum(["notes", "tasks"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  dueDate: z.union([z.iso.date(), z.literal("")]),
  sources: z
    .array(
      z.strictObject({ id: z.uuid(), version: z.number().int().positive() }),
    )
    .min(1)
    .max(100)
    .refine((v) => new Set(v.map((r) => r.id)).size === v.length),
  projectionHash: digest,
});
export const crmWriteStatusSchema = z.strictObject({
  grantId: z.uuid(),
  epoch: z.uuid(),
  targetId: z.uuid(),
  targetName: z.string().min(1).max(200),
  kinds: z
    .array(z.enum(["notes", "tasks"]))
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  expiresAt: z.iso.datetime(),
});
export const crmPreparedSchema = z.strictObject({
  reviewId: z.uuid(),
  digest,
  expiresAt: z.iso.datetime(),
});
export const crmDecisionSchema = z.strictObject({ reviewId: z.uuid(), digest });
export const crmReceiptSchema = z.strictObject({
  recordId: z.uuid(),
  state: z.enum(["published", "deleted"]),
  existing: z.boolean(),
});
export type CrmProposal = z.infer<typeof crmProposalSchema>;
export type CrmPrepared = z.infer<typeof crmPreparedSchema>;
export type CrmReceipt = z.infer<typeof crmReceiptSchema>;
