import { join } from "node:path";
import {
  AssignmentRunner,
  assignmentSchema,
  type AssignmentBinding,
} from "../../modules/task-sync/assignment-runner.js";
import { nativeAssignmentRequest } from "../../modules/task-sync/assignment-native.js";
import type { NativeTaskSyncClient } from "../../modules/task-sync/native-loopback.js";
import { digest } from "../../modules/task-sync/proof-contract.js";
import type { Vault } from "../../modules/storage/vault.js";

export async function runStartupAssignmentFixture(
  client: NativeTaskSyncClient,
  raw: unknown,
  directory: string,
  vault: Vault,
) {
  const assignment = assignmentSchema.parse(raw);
  const signal = AbortSignal.timeout(60_000);
  const execute = (kind: "intake" | "task", actionSignal = signal) =>
    client.execute(
      {
        kind: "assignment",
        input: { kind, assignmentId: assignment.assignmentId },
      },
      actionSignal,
    );
  const intake = await execute("intake");
  if (!intake.ok) throw Error("Fixture assignment intake failed");
  const { runId } = await intake.json();
  const replay = await execute("intake");
  const replayReceipt = await replay.json();
  if (
    !replay.ok ||
    replayReceipt.runId !== runId ||
    replayReceipt.replayed !== true
  )
    throw Error("Fixture intake did not reconcile");

  let modelCalls = 0;
  const host = {
    async authorize(binding: AssignmentBinding, actionSignal: AbortSignal) {
      if (binding.action !== "infer") return;
      const task = await execute("task", actionSignal);
      if (!task.ok) throw Error("Fixture source authorization denied");
      const current = await task.json();
      if (
        digest(current.assignment) !== digest(assignment) ||
        digest(current.instruction) !== binding.inputDigest
      )
        throw Error("Fixture source changed before inference");
    },
    request: nativeAssignmentRequest(client),
    async generate() {
      modelCalls++;
      return { summary: "Fixture reviewed" };
    },
  };
  const path = join(directory, "assignment-fixture.sqlite");
  const first = new AssignmentRunner(path, vault, host);
  try {
    await first.run(assignment, signal);
    throw Error("Fixture did not observe the lost CRM response");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Assignment REST write failed (503)"
    )
      throw error;
  } finally {
    first.close();
  }
  const resumed = new AssignmentRunner(path, vault, host);
  try {
    const outcome = await resumed.run(assignment, signal);
    if (
      outcome.state !== "completed" ||
      outcome.runId !== runId ||
      modelCalls !== 1
    )
      throw Error("Fixture assignment reconciliation failed");
  } finally {
    resumed.close();
  }
}
