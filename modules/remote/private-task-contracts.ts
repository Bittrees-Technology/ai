import { z } from "zod";
import { privateHeaderSchema } from "./private-envelope.js";

// A deliberately narrow first task type. Models, memories, source grants, existing
// conversations, approvals, tools and priorities cannot be selected by the sender.
export const privateTaskPayloadSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("task.submit"),
  kind: z.enum(["query", "summarize", "draft"]),
  prompt: z.string().min(1).max(32000),
});
export const privateTaskReceiptSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  taskId: z.uuid(),
  status: z.literal("accepted"),
  acceptedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  header: privateHeaderSchema,
  permissionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type PrivateTaskReceipt = z.infer<typeof privateTaskReceiptSchema>;

export const privateAcceptedPayloadSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("task.accepted"),
  receipt: privateTaskReceiptSchema,
});
