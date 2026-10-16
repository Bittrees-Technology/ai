import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ProjectWork } from "../modules/research/project-work.js";
import { LocalModelTurns } from "../modules/models/local-turns.js";
import { Vault } from "../modules/storage/vault.js";
async function fixture(
  mode: "plan" | "work",
  outcome: "ok" | "refuse" | "conflict" | "verbose" | "alwaysVerbose",
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
  let generations = 0;
  const runtime: any = {
    pin: async () => ({
      digest: "pinned",
      profile: { contextTokens: 16384, maxOutputTokens: 3000 },
    }),
    generate: async (
      _model: any,
      _prompt: string,
      _signal: any,
      format: any,
    ) => {
      assert.ok(
        !JSON.stringify(format).includes("maxLength"),
        "large string bounds are validated after generation, not compiled into Ollama grammar",
      );
      generations++;
      return JSON.stringify(
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
                outcome === "alwaysVerbose" ||
                (outcome === "verbose" && generations === 1)
                  ? "Long result. ".repeat(400)
                  : outcome === "refuse"
                    ? "This task requires sending a message."
                    : "Draft: Which geographies do you invest in?",
            },
      );
    },
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
    if (runner.isRunning) {
      const before = calls.filter((c) => c.name === "projects.list").length;
      await runner.projects();
      assert.equal(
        calls.filter((c) => c.name === "projects.list").length,
        before + 1,
        "project refresh remains available during model work",
      );
    }
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    return { calls, generations, status: runner.status()[0] };
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

test("task CRUD remains available during research", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-refresh-"));
  const calls: string[] = [];
  const projectId = randomUUID();
  const runner = new ProjectWork(
    join(dir, "work.db"),
    new Vault(randomBytes(32)),
    {
      status: async () => ({ datasetId: randomUUID() }),
      project: async (name: string) => {
        calls.push(name);
        return { projects: [], tasks: [] };
      },
    } as any,
    {} as any,
    () => ({}),
    () => ({ reason: "investor research running", seconds: 60 }),
  );
  try {
    await runner.tasks(projectId);
    await runner.projects();
    const draft = {
      projectId,
      operationId: randomUUID(),
      name: "Research follow-up",
      description: "Review findings",
      mode: "AI review",
      dueDate: "",
      status: "Open",
    };
    await runner.saveTask(draft);
    await runner.saveTask({ ...draft, taskId: randomUUID(), version: 1 });
    assert.deepEqual(calls, [
      "tasks.list",
      "projects.list",
      "tasks.create",
      "tasks.update",
    ]);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic CRM worker completes real results, resumes watching after restart, and honors disable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-project-")),
    path = join(dir, "work.db"),
    vault = new Vault(randomBytes(32));
  const projectId = randomUUID(),
    datasetId = randomUUID();
  let available = true,
    claims = 0,
    finishes = 0;
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any) => {
      if (name === "projects.list")
        return { projects: [{ id: projectId, tasks: true }] };
      if (name === "project.read") return { records: [] };
      if (name === "tasks.list")
        return { tasks: available ? [{ status: "Open" }] : [] };
      if (name === "tasks.claim") {
        claims++;
        return {
          task: available
            ? {
                id: randomUUID(),
                version: 1,
                data: {
                  name: "Draft questions",
                  description: "Draft only",
                  category: "AI draft",
                },
              }
            : null,
        };
      }
      if (name === "tasks.finish") {
        assert.match(args.result, /Actual draft/);
        finishes++;
        available = false;
        return { taskId: randomUUID(), noteId: randomUUID() };
      }
      throw Error(name);
    },
  };
  const runtime: any = {
    pin: async () => ({
      digest: "same",
      profile: { contextTokens: 16384, maxOutputTokens: 3000 },
    }),
    generate: async () =>
      JSON.stringify({
        canComplete: true,
        result: "Actual draft: What is your investment mandate?",
      }),
  };
  const turns = new LocalModelTurns();
  let releaseResearch!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseResearch = resolve;
  });
  const research = turns.run(new AbortController().signal, () => held);
  const make = () =>
    new ProjectWork(
      path,
      vault,
      connector,
      runtime,
      () => ({}),
      () => ({ reason: "ready", seconds: 5 }),
      turns.run,
    );
  let runner = make();
  try {
    await runner.create({
      confirmed: true,
      projectId,
      profileId: "test",
      mode: "work",
    });
    await runner.pause();
    const manualId = runner.status()[0].id;
    await runner.configureAutomatic({
      enabled: true,
      confirmed: true,
      projectId,
      profileId: "test",
    });
    assert.equal(
      runner.automaticStatus().jobId,
      manualId,
      "continues the existing paused run",
    );
    assert.equal(runner.status().length, 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      claims,
      0,
      "CRM waits before claiming while research owns the model",
    );
    await runner.close();
    runner = make();
    assert.equal(runner.automaticStatus().enabled, true);
    await runner.tickAutomatic();
    releaseResearch();
    await research;
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    assert.equal(finishes, 1);
    assert.equal(runner.status()[0].state, "waiting");
    const before = claims;
    await runner.tickAutomatic();
    assert.equal(claims, before, "idle polling is paced");
    await runner.close();
    runner = make();
    assert.equal(runner.automaticStatus().enabled, true);
    await runner.configureAutomatic({ enabled: false });
    await runner.tickAutomatic();
    assert.equal(claims, before);
    assert.equal(runner.automaticStatus().enabled, false);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversized result gets one bounded repair before its CRM save", async () => {
  const { status, generations, calls } = await fixture("work", "verbose");
  assert.equal(status.state, "complete");
  assert.equal(generations, 2);
  assert.equal(calls.filter((c) => c.name === "tasks.finish").length, 1);
});

test("repeated oversized output is not truncated or marked complete", async () => {
  const { status, generations, calls } = await fixture("work", "alwaysVerbose");
  assert.equal(status.state, "needs_attention");
  assert.equal(generations, 2);
  assert.equal(calls.filter((c) => c.name === "tasks.finish").length, 0);
});
