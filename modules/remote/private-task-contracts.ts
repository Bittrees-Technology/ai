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

// Only source-free terminal task output is eligible; no raw errors or model metadata.
export const privateResultPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("task.result"),
    receipt: privateTaskReceiptSchema,
    task: z.strictObject({
      id: z.uuid(),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      status: z.enum(["completed", "failed", "cancelled", "expired"]),
      updatedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      output: z.string().max(65536).nullable(),
    }),
  })
  .refine(
    (p) =>
      p.task.id === p.receipt.taskId &&
      (p.task.status === "completed"
        ? p.task.output !== null
        : p.task.output === null),
  );
