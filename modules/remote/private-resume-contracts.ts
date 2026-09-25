import { z } from "zod";
import {
  resumeCommandSchema,
  resumeReceiptSchema,
} from "./resume-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Only an encrypted offer: identifiers alone confer no authority. Browser
 * consent and atomic replay admission remain mandatory at the receiving host. */
export const privateResumeOfferSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("task.resume.offer"),
    permissionId: z.uuid(),
    taskId: z.uuid(),
    taskRevision: positive,
    modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: positive,
    expiresAt: positive,
  })
  .refine(
    (v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 86400000,
  );
export const privateResumeCommandSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("task.resume"),
  command: resumeCommandSchema,
});
export const privateResumeReceiptSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("task.resumed"),
  receipt: resumeReceiptSchema,
});
