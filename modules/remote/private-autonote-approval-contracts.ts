import { z } from "zod";
import { autoNoteReceiptSchema } from "../connectors/autonote-review-contracts.js";
const uuid = z.uuid().regex(/^[a-f0-9-]+$/),
  integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const approvalDetailByteLimit = 2_000_000;
export const approvalChunkByteLimit = 16_384;
export const approvalChunkCountLimit = Math.ceil(
  approvalDetailByteLimit / approvalChunkByteLimit,
);
/** Framing only. Every packet requires an authenticated private envelope and fresh,
 * separate peer approval consent. IDs and successful parsing confer no authority. */
export const autoNoteApprovalManifestSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("autonote.approval.offer"),
    offerId: uuid,
    permissionId: uuid,
    sourceApprovalId: uuid,
    grantId: uuid,
    reviewId: uuid,
    operationId: uuid,
    meetingId: uuid,
    proposalDigest: hash,
    detailHash: hash,
    byteLength: integer.max(approvalDetailByteLimit),
    chunkCount: integer.max(approvalChunkCountLimit),
    issuedAt: integer,
    expiresAt: integer,
  })
  .refine(
    (v) =>
      v.expiresAt > v.issuedAt &&
      v.expiresAt - v.issuedAt <= 600000 &&
      v.chunkCount === Math.ceil(v.byteLength / approvalChunkByteLimit),
  );
export const autoNoteApprovalChunkSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("autonote.approval.chunk"),
  id: uuid,
  offerId: uuid,
  detailHash: hash,
  index: z
    .number()
    .int()
    .nonnegative()
    .max(approvalChunkCountLimit - 1),
  data: z
    .string()
    .min(1)
    .max(Math.ceil((approvalChunkByteLimit * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const autoNoteApprovalDecisionSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("autonote.approval.decision"),
  id: uuid,
  offerId: uuid,
  permissionId: uuid,
  detailHash: hash,
  proposalDigest: hash,
  decision: z.enum(["approve", "reject"]),
  confirmed: z.literal(true),
  issuedAt: integer,
});
export const autoNoteApprovalReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("autonote.approval.receipt"),
    decisionId: uuid,
    offerId: uuid,
    detailHash: hash,
    status: z.enum(["saved", "rejected", "uncertain"]),
    receipt: autoNoteReceiptSchema.nullable(),
  })
  .refine((v) => (v.status === "saved") === !!v.receipt);
export type AutoNoteApprovalManifest = z.infer<
  typeof autoNoteApprovalManifestSchema
>;
export type AutoNoteApprovalChunk = z.infer<typeof autoNoteApprovalChunkSchema>;
