import { z } from "zod";
import { id, requestSchema } from "../contracts/index.js";
export const templateDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  kind: requestSchema.shape.kind,
  prompt: requestSchema.shape.prompt,
  modelProfileId: id,
});
export const templateSaveSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  definition: templateDefinitionSchema,
  confirmed: z.literal(true),
});
export const templateActionSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  confirmed: z.literal(true),
});
export const templateRunSchema = templateActionSchema.extend({
  invocationId: z.uuid(),
});
export type LocalTemplate = {
  id: string;
  revision: number;
  definition: z.infer<typeof templateDefinitionSchema>;
};
