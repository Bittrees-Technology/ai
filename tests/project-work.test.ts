import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { ProjectWork } from "../modules/research/project-work.js";
import { LocalModelTurns } from "../modules/models/local-turns.js";
import { Vault } from "../modules/storage/vault.js";
async function fixture(
  mode: "plan" | "work",
  outcome:
    | "ok"
    | "refuse"
    | "conflict"
    | "verbose"
    | "alwaysVerbose"
    | "unlinked"
    | "review"
    | "inventedReview",
) {
  const dir = mkdtempSync(join(tmpdir(), "project-work-"));
  const projectId = randomUUID(),
    datasetId = randomUUID();
  const personId = randomUUID(),
    organizationId = randomUUID();
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
            {
              id: personId,
              kind: "people",
              data: { name: "Selected subject", organizationId },
            },
            {
              id: organizationId,
              kind: "organizations",
              data: { name: "Linked firm" },
            },
            {
              id: randomUUID(),
              kind: "organizations",
              data: { name: "Custom Capital", address: "1200 Brickell Miami" },
            },
            {
              id: randomUUID(),
              kind: "people",
              data: {
                name: "Selected subject",
                description: "Unrelated name match from Chicago",
              },
            },
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
              personId: outcome === "unlinked" ? "" : personId,
              name: "Draft questions",
              description:
                outcome === "review" || outcome === "inventedReview"
                  ? "Saved source claim: Selected subject investment role"
                  : "Do not send them",
              category:
                outcome === "review" || outcome === "inventedReview"
                  ? "AI review"
                  : "AI draft",
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
      if (mode === "work") {
        assert.doesNotMatch(
          _prompt,
          /1200 Brickell|Custom Capital|Unrelated name match/,
        );
        assert.match(_prompt, /Private project reference/);
        if (outcome === "unlinked")
          assert.doesNotMatch(_prompt, /Selected subject|Linked firm/);
        else assert.match(_prompt, /Selected subject.*Linked firm/);
      }
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
          : outcome === "review" || outcome === "inventedReview"
            ? {
                canComplete: true,
                excerpts: [
                  {
                    sourceId: "task-1",
                    quote:
                      outcome === "review"
                        ? "Selected subject investment role"
                        : "Selected subject lives in Miami",
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

test("a legacy paused claim is replaced before generating while confirmed saves survive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-claim-"));
  const path = join(dir, "work.db"),
    vault = new Vault(randomBytes(32));
  const oldClaim = randomUUID(),
    jobId = randomUUID(),
    projectId = randomUUID(),
    datasetId = randomUUID();
  const seed = new Database(path);
  seed.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,payload BLOB NOT NULL)");
  seed.prepare("INSERT INTO jobs VALUES(?,?)").run(
    jobId,
    vault.seal(
      {
        id: jobId,
        datasetId,
        state: "paused",
        completed: 5,
        receipts: [{ noteId: "existing" }],
        pending: [],
        input: { mode: "work", projectId, profileId: "test" },
        claim: { runId: oldClaim },
        updatedAt: new Date().toISOString(),
      },
      "project-work:" + jobId,
    ),
  );
  seed.close();
  let claimed = "";
  const runner = new ProjectWork(
    path,
    vault,
    {
      project: async (name: string, args: any) => {
        assert.equal(name, "tasks.claim");
        claimed = args.runId;
        return { task: null };
      },
    } as any,
    { pin: async () => ({ digest: "same", profile: {} }) } as any,
    () => ({}),
    () => ({ reason: "ready", seconds: 600 }),
  );
  try {
    await runner.resume(jobId);
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    assert.notEqual(claimed, oldClaim);
    assert.ok(claimed);
    assert.equal(runner.status()[0].completed, 5);
    assert.deepEqual(runner.status()[0].receipts, [{ noteId: "existing" }]);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task generation excludes unrelated firm facts and same-name people", async () => {
  assert.equal((await fixture("work", "ok")).status.completed, 1);
  assert.equal((await fixture("work", "unlinked")).status.completed, 1);
});

test("review tasks save only validated excerpts and hold invented claims", async () => {
  const good = await fixture("work", "review");
  assert.equal(good.status.completed, 1);
  assert.match(
    good.calls.find((c) => c.name === "tasks.finish").args.result,
    /NOT INDEPENDENT VERIFICATION/,
  );
  const bad = await fixture("work", "inventedReview");
  assert.equal(bad.status.state, "needs_attention");
  assert.equal(bad.calls.filter((c) => c.name === "tasks.finish").length, 0);
});

test("additional approved projects share the worker and survive restart without replacing the first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-project-"));
  const path = join(dir, "work.db"),
    vault = new Vault(randomBytes(32));
  const first = randomUUID(),
    second = randomUUID(),
    forbidden = randomUUID(),
    datasetId = randomUUID();
  const available = new Set([first, second]);
  const finished: string[] = [];
  let admission = "paused";
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any) => {
      if (name === "projects.list")
        return { projects: [first, second].map((id) => ({ id, tasks: true })) };
      assert.ok([first, second].includes(args.projectId));
      if (name === "tasks.list")
        return {
          tasks: available.has(args.projectId) ? [{ status: "Open" }] : [],
        };
      if (name === "project.read") return { records: [] };
      if (name === "tasks.claim")
        return {
          task: available.has(args.projectId)
            ? {
                id: randomUUID(),
                version: 1,
                data: {
                  name: "Draft internal questions",
                  description: "Draft only; do not send.",
                  category: "AI draft",
                },
              }
            : null,
        };
      if (name === "tasks.finish") {
        available.delete(args.projectId);
        finished.push(args.projectId);
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
      JSON.stringify({ canComplete: true, result: "Draft internal questions" }),
  };
  const make = () =>
    new ProjectWork(
      path,
      vault,
      connector,
      runtime,
      () => ({}),
      () => ({ reason: admission, seconds: 10 }),
    );
  let runner = make();
  try {
    await runner.configureAutomatic({
      enabled: true,
      confirmed: true,
      projectId: first,
      profileId: "local",
    });
    const original = runner.automaticStatus().jobId;
    await assert.rejects(
      runner.configureAutomatic({
        enabled: true,
        additional: true,
        confirmed: true,
        projectId: forbidden,
        profileId: "local",
      }),
      /permission/,
    );
    await runner.configureAutomatic({
      enabled: true,
      additional: true,
      confirmed: true,
      projectId: second,
      profileId: "local",
    });
    assert.equal(runner.automaticStatus().jobId, original);
    assert.equal(runner.automaticStatus().projects.length, 2);
    await runner.configureAutomatic({
      enabled: true,
      additional: true,
      confirmed: true,
      projectId: second,
      profileId: "local",
    });
    assert.equal(
      runner.status().length,
      2,
      "idempotent enable does not duplicate jobs",
    );
    await runner.close();
    runner = make();
    admission = "ready";
    for (let i = 0; i < 2; i++) {
      await runner.tickAutomatic();
      while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(new Set(finished), new Set([first, second]));
    assert.ok(runner.status().every((j) => j.state === "waiting"));
    await runner.configureAutomatic({ enabled: false });
    assert.ok(runner.status().every((j) => j.state === "paused"));
    assert.equal(runner.automaticStatus().enabled, false);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepared supplier child fetches its approved evidence and saves only the child result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supplier-child-"));
  const projectId = randomUUID(),
    datasetId = randomUUID(),
    childId = randomUUID();
  let claimed = false;
  const calls: string[] = [];
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any) => {
      calls.push(name);
      if (name === "projects.list")
        return { projects: [{ id: projectId, tasks: true }] };
      if (name === "tasks.claim") {
        if (claimed) return { task: null };
        claimed = true;
        return {
          task: {
            id: childId,
            version: 1,
            data: {
              name: "Supplier public evidence",
              description: "Research only. Parent confirmation stays open.",
              category: "AI review",
              supplierResearch: {
                version: 1,
                urls: ["https://supplier.example/terms"],
              },
            },
          },
        };
      }
      if (name === "tasks.finish") {
        assert.match(
          args.result,
          /Original supplier confirmation tasks remain open/,
        );
        assert.match(args.result, /Published warranty terms/);
        return { taskId: childId, noteId: randomUUID() };
      }
      throw Error("Unexpected operation " + name);
    },
  };
  const runtime: any = {
    pin: async () => ({
      digest: "same",
      profile: { contextTokens: 16384, maxOutputTokens: 3000 },
    }),
    generate: async () =>
      JSON.stringify({
        excerpts: [{ sourceId: "source-1", quote: "Published warranty terms" }],
      }),
  };
  const sources: any = {
    sources: async (_raw: unknown, scope: string) => {
      assert.equal(scope, JSON.stringify([datasetId, projectId]));
      return {
        sources: [
          {
            id: "source-1",
            url: "https://supplier.example/terms",
            text: "Published warranty terms",
            retrievedAt: new Date().toISOString(),
          },
        ],
        unavailable: [],
      };
    },
  };
  const runner = new ProjectWork(
    join(dir, "work.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    undefined,
    sources,
  );
  try {
    await runner.create({
      confirmed: true,
      projectId,
      profileId: "test",
      mode: "work",
    });
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    assert.equal(runner.status()[0].state, "complete");
    assert.equal(runner.status()[0].receipts[0].taskId, childId);
    assert.deepEqual(calls, [
      "projects.list",
      "tasks.claim",
      "tasks.finish",
      "tasks.claim",
    ]);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an automatic supplier evidence failure leaves its task open and allows the next task to finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supplier-triage-"));
  const projectId = randomUUID(),
    datasetId = randomUUID();
  const blocked = randomUUID(),
    good = randomUUID();
  let claim = 0;
  const finished: string[] = [];
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any) => {
      if (name === "projects.list")
        return { projects: [{ id: projectId, tasks: true }] };
      if (name === "tasks.list") return { tasks: [{ status: "Open" }] };
      if (name === "tasks.claim") {
        claim++;
        return {
          task:
            claim <= 2
              ? {
                  id: claim === 1 ? blocked : good,
                  version: 1,
                  data: {
                    name:
                      claim === 1
                        ? "Unavailable supplier"
                        : "Readable supplier",
                    description: "Evidence only",
                    category: "AI review",
                    supplierResearch: {
                      version: 1,
                      urls: [`https://supplier.example/${claim}`],
                    },
                  },
                }
              : null,
        };
      }
      if (name === "tasks.finish") {
        finished.push(good);
        return { taskId: good, noteId: randomUUID() };
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
        excerpts: [{ sourceId: "source-1", quote: "Published terms" }],
      }),
  };
  const supplier: any = {
    sources: async (meta: any) => {
      if (meta.urls[0].endsWith("/1"))
        throw Error("Supplier pages unavailable; research remains open.");
      return {
        sources: [
          {
            id: "source-1",
            url: meta.urls[0],
            text: "Published terms",
            retrievedAt: new Date().toISOString(),
          },
        ],
        unavailable: [],
      };
    },
  };
  const runner = new ProjectWork(
    join(dir, "work.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    undefined,
    supplier,
  );
  try {
    await runner.configureAutomatic({
      enabled: true,
      confirmed: true,
      projectId,
      profileId: "test",
    });
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    assert.equal(runner.status()[0].state, "waiting");
    assert.deepEqual(finished, [good]);
    assert.equal(runner.status()[0].supplierIssues[0].taskId, blocked);
    assert.equal(runner.status()[0].completed, 1);
  } finally {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
