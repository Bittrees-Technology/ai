import { z } from "zod";
import { remoteStatusSchema } from "../contracts/index.js";
import type { Task } from "../storage/store.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Routing IDs are generated opaque IDs, never user labels or source IDs. */
export const remoteControlSchema = z.strictObject({
  id: z.uuid(),
  deviceId: z.uuid(),
  taskId: z.uuid(),
  command: z.enum(["pause", "cancel"]),
  expectedRevision: revision,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const remoteTemplateSchema = z.strictObject({
  id: z.uuid(),
  deviceId: z.uuid(),
  templateId: z.uuid(),
  templateRevision: revision,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const remoteReceiptSchema = z.strictObject({
  id: z.uuid(),
  deviceId: z.uuid(),
  outcome: z.enum(["applied", "conflict", "expired", "denied", "cancelled"]),
  completedAt: z.iso.datetime(),
});
export const statusBatchSchema = z
  .strictObject({
    sequence: revision,
    items: z.array(remoteStatusSchema).max(100),
  })
  .refine((b) => new Set(b.items.map((i) => i.id)).size === b.items.length);
/** Only this projection may leave the device in status mode. Never spread Task. */
export function projectRemoteStatus(task: Task, deviceId: string) {
  return remoteStatusSchema.parse({
    id: task.id,
    deviceId,
    status: task.status,
    revision: task.revision,
    updatedAt: new Date(task.updatedAt).toISOString(),
  });
}
/** Reject stale/future commands before processing. Does not authenticate or grant authority. */
export function parseRemoteControl(raw: unknown, now: number) {
  const command = remoteControlSchema.parse(raw);
  const issued = Date.parse(command.issuedAt),
    expires = Date.parse(command.expiresAt);
  if (
    !Number.isFinite(now) ||
    issued > now + 30000 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 5 * 60000
  )
    throw new Error("EXPIRED");
  return command;
}
