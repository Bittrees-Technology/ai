import { z } from "zod";

// Roles is deliberately absent: source-private material must not enter role tasks.
export const memoryAppSchema = z.enum(["local", "crm", "autonote", "mail"]);
export type MemoryApp = z.infer<typeof memoryAppSchema>;
export const memoryUseAppsSchema = z
  .array(memoryAppSchema)
  .max(4)
  .refine((apps) => new Set(apps).size === apps.length);
