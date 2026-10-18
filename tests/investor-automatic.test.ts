import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { InvestorResearch } from "../modules/research/investors.js";

function fixture(state = "sources_exhausted", enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "investor-automatic-"));
  const path = join(dir, "research.db"),
    vault = new Vault(randomBytes(32));
  const id = randomUUID(),
    projectId = randomUUID(),
    datasetId = randomUUID();
  const db = new Database(path);
  db.exec(
    "CREATE TABLE research_jobs(id TEXT PRIMARY KEY,payload BLOB NOT NULL)",
  );
  const job = {
    id,
    datasetId,
    state,
    input: {
      confirmed: true,
      profileId: "local",
      brief: "Research current investment decision makers",
      target: 1,
      urls: ["https://example.org/team"],
    },
    queue: state === "running" ? ["https://example.org/team"] : [],
    done: [],
    added: 0,
    skipped: 0,
    failures: [],
    version: 1,
    updatedAt: new Date().toISOString(),
    automatic: { enabled, projectId, phase: "waiting", attempts: 0 },
  };
  db.prepare("INSERT INTO research_jobs VALUES (?,?)").run(
    id,
    vault.seal(job, "investor-research:" + id),
  );
  db.close();
  let authorized = true,
    loseResponse = false,
    modelRuns = 0,
    creates = 0;
  const operations = new Map<string, any>();
  const calls: any[] = [];
  let completion: any;
  const connector: any = {
    read: async () => ({ id: datasetId, version: 1, entries: [] }),
    project: async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === "projects.list")
        return { projects: [{ id: projectId, tasks: authorized }] };
      assert.equal(tool, "tasks.create");
      assert.equal(authorized, true);
      if (!operations.has(args.operationId)) {
        creates++;
        operations.set(args.operationId, { id: randomUUID(), version: 1 });
      }
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("Unavailable"), {
          code: "SOURCE_UNAVAILABLE",
        });
      }
      return operations.get(args.operationId);
    },
  };
  const open = () =>
    new InvestorResearch(
      path,
      vault,
      connector,
      {
        pin: async () => ({
          digest: "fixed",
          profile: { contextTokens: 16000, maxOutputTokens: 3000 },
        }),
        generate: async () => {
          modelRuns++;
          return JSON.stringify({
            organization: "Example",
            geographyEvidence: "",
            people: [],
          });
        },
      } as any,
      () => ({}),
      () => ({ reason: "ready", seconds: 10 }),
      async (url) => ({ url, text: "Example investment team", links: [] }),
      undefined,
      () => completion,
    );
  return {
    open,
    id,
    projectId,
    calls,
    operations,
    complete: (taskId: string) => {
      completion = { taskId, noteId: randomUUID() };
    },
    lose: () => {
      loseResponse = true;
    },
    revoke: () => {
      authorized = false;
    },
    counts: () => ({ modelRuns, creates }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("restart triggers local research, then emits one confirmed MCP evidence-review task", async () => {
  const f = fixture("running");
  const runner = f.open();
  try {
    assert.equal(runner.status()[0]!.state, "waiting");
    await Promise.all([runner.tickAutomatic(), runner.tickAutomatic()]);
    while (runner.isRunning) await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.counts().modelRuns, 1);
    await runner.tickAutomatic();
    await runner.tickAutomatic();
    assert.equal(f.counts().creates, 1);
    assert.equal(runner.status()[0]!.automatic?.phase, "waiting_for_sources");
    assert.ok(runner.status()[0]!.automatic?.receipt?.id);
    assert.match(
      f.calls.find((c) => c.tool === "tasks.create").args.description,
      /does not complete the investor goal/,
    );
    assert.equal(runner.status()[0]!.state, "sources_exhausted");
    f.complete(runner.status()[0]!.automatic!.receipt!.id);
    await runner.tickAutomatic();
    assert.ok(runner.status()[0]!.automatic!.completion?.noteId);
    assert.equal(
      runner.status()[0]!.automatic!.phase,
      "review_completed_waiting_for_sources",
    );
    assert.equal(runner.status()[0]!.state, "sources_exhausted");
  } finally {
    await runner.close();
    f.cleanup();
  }
});

test("lost MCP response survives restart and replays the identical operation without duplicates", async () => {
  const f = fixture();
  let runner = f.open();
  try {
    f.lose();
    await runner.tickAutomatic();
    const pending = runner.status()[0]!.automatic!.pending;
    assert.ok(pending);
    await runner.close();
    runner = f.open();
    await runner.configureAutomatic({
      confirmed: true,
      id: f.id,
      enabled: true,
      projectId: f.projectId,
    });
    await runner.tickAutomatic();
    assert.equal(f.counts().creates, 1);
    const writes = f.calls.filter((c) => c.tool === "tasks.create");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].args, writes[1].args);
    assert.equal(runner.status()[0]!.automatic!.pending, undefined);
    assert.ok(runner.status()[0]!.automatic!.receipt);
  } finally {
    await runner.close();
    f.cleanup();
  }
});

test("explicit pause survives restart and revoked task authority blocks outbound triggers", async () => {
  const f = fixture();
  let runner = f.open();
  try {
    await runner.pause();
    await runner.close();
    runner = f.open();
    await runner.tickAutomatic();
    assert.equal(f.counts().creates, 0);
    await runner.configureAutomatic({
      confirmed: true,
      id: f.id,
      enabled: true,
      projectId: f.projectId,
    });
    f.revoke();
    await runner.tickAutomatic();
    assert.equal(f.counts().creates, 0);
    assert.equal(runner.status()[0]!.automatic!.enabled, false);
    assert.equal(runner.status()[0]!.automatic!.phase, "needs_attention");
  } finally {
    await runner.close();
    f.cleanup();
  }
});

test("legacy interrupted runs stay paused without automatic opt-in", async () => {
  const f = fixture("running", false);
  const runner = f.open();
  try {
    await runner.tickAutomatic();
    assert.equal(runner.status()[0]!.state, "paused");
    assert.equal(f.counts().modelRuns, 0);
  } finally {
    await runner.close();
    f.cleanup();
  }
});
