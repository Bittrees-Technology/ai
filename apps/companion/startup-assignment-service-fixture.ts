import { z } from "zod";
import { modelProfileSchema } from "../../modules/contracts/index.js";
import type { AssignmentService } from "../../modules/task-sync/assignment-service.js";

export const assignmentServiceFixtureSchema = z.strictObject({
  profile: modelProfileSchema,
  finalPhase: z.string(),
  modelGenerations: z.int().min(0).max(1),
  phases: z
    .array(z.enum(["held", "idle"]))
    .min(1)
    .max(3),
});
export async function runAssignmentServiceFixture(
  service: AssignmentService,
  fixture: z.infer<typeof assignmentServiceFixtureSchema>,
) {
  for (const expected of fixture.phases) {
    await service.tick();
    console.error(
      "ASSIGNMENT_FIXTURE_STATUS",
      JSON.stringify(service.status()),
    );
    if (service.status().phase !== expected)
      throw Error(
        `Normal assignment service fixture phase mismatch: expected ${expected}, status ${JSON.stringify(service.status())}`,
      );
  }
  if (
    service.status().assignments[0]?.phase !== fixture.finalPhase ||
    service.status().assignments[0]?.modelGenerations !==
      fixture.modelGenerations
  )
    throw Error("Normal assignment service fixture did not confirm completion");
}
