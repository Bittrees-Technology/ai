import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import { replyRequestSchema } from "./mail-auto-reply.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const mailDraftRequest = z.strictObject({
  contractVersion: z.literal("mail-draft-generation-v1"),
  operationId: hash,
  policy: z.strictObject({
    id: hash,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  sourceVersion: hash,
  deadline: z.number().int().max(Number.MAX_SAFE_INTEGER),
  mode: z.literal("draft"),
  input: replyRequestSchema,
});
export type MailDraftRequest = z.infer<typeof mailDraftRequest>;
export type MailDraftResult = {
  contractVersion: "mail-draft-generation-v1";
  operationId: string;
  requestDigest: string;
  status: "draft" | "needs-review" | "cancelled" | "failed";
  text: string;
  factIds: number[];
  evidence: { model: string; outputDigest: string };
};
export const mailDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
export const outputDigest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
