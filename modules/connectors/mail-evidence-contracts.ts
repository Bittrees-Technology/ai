import { z } from "zod";
const citation = z.object({
  messageId: z.string().min(1),
  version: z.string().min(1),
  sectionId: z.string().min(1).max(40),
  attachmentId: z.string().optional(),
});
const claim = z.object({
  text: z.string().min(1).max(8000),
  citations: z.array(citation).min(1).max(30),
});
export const mailReviewSchema = z.object({
  messageId: z.string(),
  version: z.string(),
  projectionHash: z.string(),
  mode: z.enum(["metadata", "plain", "attachment-text"]),
  attachment: z.object({ id: z.string() }).optional(),
  summary: z.array(claim).min(1).max(20),
  reply: claim.nullable(),
  partSummaries: z
    .array(z.array(claim).min(1).max(5))
    .min(1)
    .max(128)
    .optional(),
  coverage: z
    .object({
      strategy: z.literal("sequential-parts"),
      parts: z.number().int().positive().max(128),
      sourceBytes: z.number().int().nonnegative(),
      allPartsProcessed: z.literal(true),
    })
    .optional(),
});
export type MailReview = z.infer<typeof mailReviewSchema>;
export const mailEvidenceRequest = z.strictObject({
  expectedRevision: z.number().int().positive(),
  sectionId: z.string().min(1).max(40),
});
export const mailEvidenceResponse = z.strictObject({
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  sectionId: z.string().min(1).max(40),
  text: z.string().max(32000),
  mode: z.enum(["metadata", "plain", "attachment-text"]),
  incomplete: z.boolean(),
});
export type MailEvidence = z.infer<typeof mailEvidenceResponse>;
export function mailSectionLabel(id: string, mail: MailReview) {
  if (id === "from") return "Sender";
  if (id === "subject") return "Subject";
  if (id === "date") return "Date";
  if (id === "attachment-name") return "File name";
  if (/^body-\d+$/.test(id)) return "Message passage " + id.slice(5);
  if (/^attachment-\d+$/.test(id)) return "File passage " + id.slice(11);
  const index = mail.partSummaries?.findIndex((group) =>
    group.some((c) => c.citations.some((ref) => ref.sectionId === id)),
  );
  return index !== undefined && index >= 0
    ? "File part " + (index + 1)
    : "Source passage";
}
