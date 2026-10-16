import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ProjectWork } from "../modules/research/project-work.js";
import { Vault } from "../modules/storage/vault.js";
async function fixture(
  mode: "plan" | "work",
  outcome: "ok" | "refuse" | "conflict",
) {
  const dir = mkdtempSync(join(tmpdir(), "project-work-"));
  const projectId = randomUUID(),
    datasetId = randomUUID();
  const calls: any[] = [];
  let claimed = false;
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any, dataset: string) => {
      assert.equal(dataset, datasetId);
      calls.push({ name, args });
      if (name === "projects.list")
        return { projects: [{ id: projectId, tasks: true }] };
      if (name === "project.read")
        return {
          records: [
            { id: projectId, data: { name: "Private project reference" } },
          ],
        };
      if (name === "tasks.create") return { id: randomUUID(), version: 1 };
      if (name === "tasks.claim") {
        if (claimed) return { task: null };
        claimed = true;
        return {
          task: {
            id: randomUUID(),
            version: 1,
            data: {
              name: "Draft questions",
              description: "Do not send them",
              category: "AI draft",
            },
          },
        };
      }
      if (name === "tasks.finish") {
        if (outcome === "conflict") throw Error("SOURCE_CONFLICT");
        return { taskId: randomUUID(), noteId: randomUUID() };
      }
      throw Error("Unexpected tool");
    },
  };
  const runtime: any = {
    pin: async () => ({
      digest: "pinned",
      profile: { contextTokens: 16384, maxOutputTokens: 3000 },
    }),
    generate: async () =>
      JSON.stringify(
        mode === "plan"
          ? {
              tasks: [
                {
                  name: "Draft questions",
                  description: "Prepare qualification questions only.",
                  mode: "AI draft",
                },
              ],
            }
          : {
              canComplete: outcome !== "refuse",
              result:
                outcome === "refuse"
                  ? "This task requires sending a message."
                  : "Draft: Which geographies do you invest in?",
            },
      ),
  };
  const runner = new ProjectWork(
    join(dir, "jobs.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
  );
  try {
    await runner.create({
      confirmed: true,
      projectId,
      profileId: "test",
      mode,
      prompt: "Plan qualification tasks.",
    });
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    return { calls, status: runner.status()[0] };
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("local model creates bounded CRM tasks through the scoped dataset connector", async () => {
  const { calls, status } = await fixture("plan", "ok");
  assert.equal(status.state, "complete");
  assert.equal(calls.filter((c) => c.name === "tasks.create").length, 1);
  assert.equal(calls.filter((c) => c.name === "tasks.finish").length, 0);
});
test("local task work saves actual result and a source receipt", async () => {
  const { calls, status } = await fixture("work", "ok");
  assert.equal(status.state, "complete");
  assert.equal(status.completed, 1);
  assert.match(
    calls.find((c) => c.name === "tasks.finish").args.result,
    /Which geographies/,
  );
});
test("outside actions are not marked completed", async () => {
  const { calls, status } = await fixture("work", "refuse");
  assert.equal(status.state, "needs_attention");
  assert.equal(calls.filter((c) => c.name === "tasks.finish").length, 0);
});
test("a changed source preserves the pending result and pauses", async () => {
  const { status } = await fixture("work", "conflict");
  assert.equal(status.state, "needs_attention");
  assert.equal(status.pendingSaves, 1);
  assert.match(status.pendingResults[0], /Which geographies/);
  assert.equal(status.completed, 0);
});
