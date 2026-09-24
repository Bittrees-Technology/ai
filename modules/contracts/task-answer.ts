import { z } from "zod";
import { id, taskStatus } from "./index.js";
export const taskQuestionViewSchema = z.strictObject({
  taskId: z.uuid(),
  questionId: z.uuid(),
  inboxId: id,
  conversationId: id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: taskStatus,
  question: z.string().min(1).max(32000),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  replyId: z.uuid().nullable(),
  canAnswer: z.boolean(),
});
export type TaskQuestionView = z.infer<typeof taskQuestionViewSchema>;
export const taskAnswerInputSchema = z.strictObject({
  questionId: z.uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  content: z.string().min(1).max(32000),
  confirmed: z.literal(true),
});
export const taskAnswerReceiptSchema = z.strictObject({
  taskId: z.uuid(),
  questionId: z.uuid(),
  replyId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: taskQuestionViewSchema.shape.status,
  duplicate: z.boolean(),
});
