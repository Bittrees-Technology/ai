import { z } from "zod";
import { templateApprovalSchema } from "./template-contracts.js";
import { remoteTemplateSchema } from "./status.js";
import type { Store } from "../storage/store.js";
export const shareTemplateSchema = z.strictObject({
  templateId: z.uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRuns: z.number().int().min(1).max(20),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  confirmed: z.literal(true),
});
export const templateClientStateSchema = z.strictObject({
  approval: templateApprovalSchema,
  approvedAt: z.number().int().positive(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  mode: z.enum(["publication_pending", "active", "revoke_pending"]),
  pendingCommand: remoteTemplateSchema.optional(),
});
export const templateMetadataSchema = z.strictObject({
  permissionId: z.uuid(),
  deviceId: z.uuid(),
  templateId: z.uuid(),
  templateRevision: z.number().int().positive(),
  approvedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  maxRuns: z.number().int().min(1).max(20),
  submittedRuns: z.number().int().min(0).max(20),
});
export type TemplateClientState = z.infer<typeof templateClientStateSchema>;
export interface RemoteTemplateExecutor {
  approve(raw: unknown): ReturnType<Store["remoteTemplates"]["approve"]>;
  allowed(raw: unknown): boolean;
  revoke(deviceId: string, templateId?: string): void;
  execute(
    identity: unknown,
    command: unknown,
  ): ReturnType<Store["remoteTemplates"]["execute"]>;
}
