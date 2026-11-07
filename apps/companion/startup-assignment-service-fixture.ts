import { z } from "zod";
import { modelProfileSchema } from "../../modules/contracts/index.js";
import type { AssignmentService } from "../../modules/task-sync/assignment-service.js";

export const assignmentServiceFixtureSchema = z.strictObject({
  profile: modelProfileSchema,
  finalPhase: z.string(),
  modelGenerations: z.int().min(0).max(1),
  natural: z.boolean().default(false),
  expectedAssignments: z.int().min(1).max(60).default(1),
  phases: z
    .array(z.enum(["held", "idle"]))
    .min(0)
    .max(3),
});
export async function observeNaturalAssignmentFixture(
  service: AssignmentService,
  fixture: z.infer<typeof assignmentServiceFixtureSchema>,
) {
  if (!fixture.natural) throw Error("Natural fixture mode required");
  await new Promise<void>((resolve, reject) => {
    let previous = "";
    const finish = (error?: Error) => {
      clearInterval(timer);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    const timer = setInterval(() => {
      const state = service.status();
      const current = JSON.stringify(state);
      if (current !== previous) {
        previous = current;
        console.error("ASSIGNMENT_NATURAL_STATUS", current);
      }
      if (state.assignments.length > fixture.expectedAssignments)
        return finish(Error("Natural fixture scope expanded"));
      if (
        state.assignments.length === fixture.expectedAssignments &&
        state.assignments.every(
          (item) =>
            item.phase === "completed" &&
            item.validation &&
            item.modelGenerations === fixture.modelGenerations,
        )
      ) {
        console.error(
          "ASSIGNMENT_NATURAL_FIXTURE_PASSED",
          JSON.stringify(state),
        );
        finish();
      }
    }, 1000);
    const deadline = setTimeout(
      () =>
        finish(
          Error(
            "Natural assignment fixture did not complete within its observation window: " +
              JSON.stringify(service.status()),
          ),
        ),
      105000,
    );
  });
}
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
