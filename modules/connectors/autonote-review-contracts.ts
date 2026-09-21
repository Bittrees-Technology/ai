import { z } from "zod";
const evidence = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(30)
  .refine((ids) => new Set(ids).size === ids.length);
export const autoNoteProposalSchema = z.strictObject({
  operationId: z.uuid(),
  meetingId: z.uuid(),
  version: z.number().int().positive(),
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z
    .array(
      z.strictObject({ text: z.string().trim().min(1).max(4000), evidence }),
    )
    .min(1)
    .max(20),
  actions: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(4000),
        evidence,
        owner: z.string().max(150).nullable(),
        dueDate: z.iso.date().nullable(),
      }),
    )
    .max(30),
});
export const autoNoteReceiptSchema = z.strictObject({
  meetingId: z.uuid(),
  version: z.number().int().positive(),
  operationId: z.uuid(),
});
export const autoNotePreparedSchema = z.strictObject({
  reviewId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  receipt: autoNoteReceiptSchema.nullable(),
});
export const autoNoteReviewStatusSchema = z.strictObject({
  grantId: z.uuid(),
  meetingId: z.uuid(),
  enabled: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export const autoNoteReconciledSchema = autoNotePreparedSchema
  .extend({ deleted: z.boolean() })
  .refine((v) => !(v.deleted && v.receipt));
export type AutoNoteProposal = z.infer<typeof autoNoteProposalSchema>;
