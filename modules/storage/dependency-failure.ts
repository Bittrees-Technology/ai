import { z } from "zod";
/** Local encrypted result metadata; never a remote-status projection. */
export const dependencyFailureSchema = z.strictObject({
  kind: z.literal("dependency_failure"),
  prerequisites: z
    .array(
      z.strictObject({
        taskId: z.uuid(),
        status: z.enum(["failed", "cancelled", "expired"]),
      }),
    )
    .min(1)
    .max(32),
});
export type DependencyFailure = z.infer<typeof dependencyFailureSchema>;
