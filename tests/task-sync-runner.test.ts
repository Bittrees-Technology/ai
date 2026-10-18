import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, verify } from "node:crypto";
import { TaskSyncRunner } from "../modules/task-sync/runner.js";
import { Vault } from "../modules/storage/vault.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import { runtimeEnrollmentMessage } from "../modules/task-sync/runtime-contract.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "task-sync-")),
    path = join(dir, "runner.sqlite"),
    vault = new Vault(randomBytes(32));
  let now = Date.now(),
    calls = 0,
    mode = "success";
  const content = {
    sourceId: "agent-readiness:agent:review",
    projectId: "agent",
    title: "Review",
    description: "Description",
    status: "todo",
    priority: "P0",
    area: "docs",
    acceptanceCriteria: ["Evidence"],
    progressNote: "",
    sourceUrl: "https://agent.bittrees.org/readiness#review",
  };
  const workspace = randomUUID(),
    project = randomUUID(),
    revision = "a".repeat(64),
    taskId = randomUUID();
  const request = (async (url: any, init: any) => {
    calls++;
    if (String(url).includes("tasks.json"))
      return Response.json({
        data: {
          schema: "agent.bittrees.task-feed.v1",
          source: "https://agent.bittrees.org",
          revision: mode === "changed" ? "b".repeat(64) : revision,
          projects: [{ projectId: "agent", siteUrl: null, tasks: [content] }],
          tombstones: [],
        },
      });
    const body = JSON.parse(init.body);
    if (mode === "lost") throw new Error("reply lost");
    if (mode === "denied")
      return Response.json(
        { id: body.id, error: { message: "revoked" } },
        { status: 403 },
      );
    return Response.json({
      id: body.id,
      result: { structuredContent: { state: "accepted", taskId, version: 1 } },
    });
  }) as typeof fetch;
  const create = () =>
    new TaskSyncRunner(
      path,
      vault,
      async (x) => x,
      request,
      () => now,
    );
  const approval = (r: TaskSyncRunner) => {
    const d = r.device();
    return {
      identity: {
        ...d,
        publicKey: undefined,
        tenant: "roles:test",
        workspace: "crm:" + workspace,
        sourceWorkspace: workspace,
        subject: d.principal,
        leaseId: randomUUID(),
        runtimeBindingDigest: "b".repeat(64),
        activatedAt: now,
        expiresAt: now + 3600000,
      },
      token: "test-token-not-a-real-credential",
      revision,
      tasks: [
        {
          content,
          fingerprint: digest(content),
          destination: { projectId: project, workspaceId: workspace },
        },
      ],
      mappings: [
        {
          sourceProjectId: "agent",
          siteUrl: null,
          crmProjectId: project,
          workspaceId: workspace,
        },
      ],
    };
  };
  return {
    create,
    approval: (r: TaskSyncRunner) => {
      const a = approval(r);
      delete (a.identity as any).publicKey;
      return a;
    },
    setMode: (v: string) => (mode = v),
    advance: () => (now += 3600001),
    calls: () => calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("runner is inert before approval and retains encrypted device identity across restart", async () => {
  const f = fixture();
  let r = f.create();
  try {
    await r.tick();
    assert.equal(f.calls(), 0);
    const d = r.device();
    const proof = r.enrollment({
      profileId: randomUUID(),
      authorityId: randomUUID(),
      deviceId: randomUUID(),
      sourceWorkspace: randomUUID(),
    });
    assert.ok(
      verify(
        null,
        Buffer.from(runtimeEnrollmentMessage(proof.request)),
        d.publicKey,
        Buffer.from(proof.signature, "base64"),
      ),
    );
    await r.close();
    r = f.create();
    assert.deepEqual(r.device(), d);
  } finally {
    await r.close();
    f.cleanup();
  }
});
test("confirmed import persists across restart and is never sent again", async () => {
  const f = fixture();
  let r = f.create();
  try {
    await r.activate(f.approval(r));
    await r.tick();
    assert.equal(r.status().completedImports, 1);
    await r.close();
    r = f.create();
    await r.tick();
    assert.equal(r.status().progress.state, "finished");
    assert.equal(r.status().completedImports, 1);
    assert.equal(f.calls(), 3);
  } finally {
    await r.close();
    f.cleanup();
  }
});
test("lost replies have a durable retry bound across restarts", async () => {
  const f = fixture();
  let r = f.create();
  try {
    await r.activate(f.approval(r));
    f.setMode("lost");
    for (let n = 0; n < 3; n++) {
      await r.tick();
      await r.close();
      r = f.create();
    }
    await r.tick();
    assert.equal(r.status().progress.state, "held");
    assert.equal(r.status().enabled, false);
    assert.equal(r.status().completedImports, 0);
    assert.equal(f.calls(), 7);
  } finally {
    await r.close();
    f.cleanup();
  }
});
for (const mode of ["changed", "denied", "expired"])
  test(mode + " stops unattended imports", async () => {
    const f = fixture(),
      r = f.create();
    try {
      await r.activate(f.approval(r));
      f.setMode(mode);
      if (mode === "expired") f.advance();
      await r.tick();
      assert.equal(r.status().enabled, false);
      assert.equal(r.status().completedImports, 0);
      assert.equal(
        r.status().progress.state,
        mode === "expired" ? "expired" : "held",
      );
      if (mode === "expired") assert.equal(f.calls(), 0);
    } finally {
      await r.close();
      f.cleanup();
    }
  });
test("pause survives restart and cannot renew an expired lease", async () => {
  const f = fixture();
  let r = f.create();
  try {
    await r.activate(f.approval(r));
    await r.pause();
    await r.close();
    r = f.create();
    await r.tick();
    assert.equal(f.calls(), 0);
    f.advance();
    assert.throws(() => r.resume());
    await assert.rejects(() => r.activate(f.approval(r)));
  } finally {
    await r.close();
    f.cleanup();
  }
});
