import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { TaskSyncRunner } from "../modules/task-sync/runner.js";
import { Vault } from "../modules/storage/vault.js";
import { digest, type SyncTask } from "../modules/task-sync/proof-contract.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  activationReceiptMessage,
  runtimeEnrollmentMessage,
} from "../modules/task-sync/runtime-contract.js";
import Database from "better-sqlite3";
function fixture(
  limits: { maxWorkAttempts?: number; maxRequests?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "task-sync-")),
    path = join(dir, "runner.sqlite"),
    vault = new Vault(randomBytes(32));
  const issuedAt = Date.now(),
    runId = randomUUID();
  let now = issuedAt,
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
    if (mode === "source-lost" && String(url).includes("tasks.json"))
      throw Error("source unavailable");
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
  const create = (
    attest?: ConstructorParameters<typeof TaskSyncRunner>[5],
    host?: ConstructorParameters<typeof TaskSyncRunner>[8],
  ) =>
    new TaskSyncRunner(
      path,
      vault,
      async (x) => x,
      request,
      () => now,
      attest,
      undefined,
      undefined,
      host,
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
    savedApproval: () => {
      const db = new Database(path, { readonly: true });
      try {
        const row = db
          .prepare("SELECT value FROM state WHERE key='approval'")
          .get() as { value: Buffer };
        return vault.open(row.value, "task-sync:approval");
      } finally {
        db.close();
      }
    },
    approval: (r: TaskSyncRunner) => {
      const a = approval(r);
      delete (a.identity as any).publicKey;
      r.configureExecutionBudget({
        version: 1,
        confirmed: true,
        runId,
        scopeDigest: digest({
          principal: a.identity.principal,
          sourceWorkspace: a.identity.sourceWorkspace,
          revision: a.revision,
          tasks: a.tasks,
          mappings: a.mappings,
        }),
        issuedAt,
        expiresAt: issuedAt + 3600000,
        maxWorkAttempts: limits.maxWorkAttempts ?? 100,
        maxRequests: limits.maxRequests ?? 100,
        maxRequestBytes: 1000000,
        maxResponseBytes: 1000000,
        requestsByKind: {
          source: 100,
          connect: 100,
          execute: 100,
          preview: 3,
          owner: 100,
          attestation: 100,
          status: 0,
        },
      });
      return a;
    },
    setMode: (v: string) => (mode = v),
    advance: () => (now += 3600001),
    calls: () => calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("protected activation and imports keep the gateway bearer out of runner state", async () => {
  const f = fixture();
  const keys = generateKeyPairSync("ed25519");
  const token = "synthetic-native-host-bearer";
  const calls: string[] = [];
  const taskId = randomUUID();
  let approval: ReturnType<typeof f.approval>;
  const runner = f.create(undefined, {
    authorize: ({ kind }) => calls.push(kind),
    credential: () => {
      throw Error("Unexpected credential lookup");
    },
    request: async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(url).endsWith("/v1/task-sync/connect")) {
        assert.equal(auth, null);
        return Response.json({
          identity: approval.identity,
          token,
          projectIds: ["crm", "agent"],
          permissions: ["catalog:read", "task-sync:read", "task-sync:write"],
        });
      }
      if (String(url).endsWith("/tasks.json")) {
        assert.equal(auth, null);
        return Response.json({
          data: {
            schema: "agent.bittrees.task-feed.v1",
            source: "https://agent.bittrees.org",
            revision: approval.revision,
            tombstones: [],
            projects: [
              {
                projectId: "agent",
                siteUrl: null,
                tasks: [approval.tasks[0]!.content],
              },
            ],
          },
        });
      }
      assert.equal(auth, "Bearer " + token);
      const rpc = JSON.parse(String(init?.body));
      return Response.json({
        id: rpc.id,
        result: {
          structuredContent:
            rpc.params.name === "task_sync_preview"
              ? {
                  revision: approval.revision,
                  tasks: approval.tasks.map((t) => ({
                    ...t,
                    sourceId: t.content.sourceId,
                  })),
                }
              : { state: "accepted", taskId, version: 1 },
        },
      });
    },
  });
  try {
    approval = f.approval(runner);
    const { identity, revision, tasks, mappings } = approval;
    const { activatedAt, expiresAt, subject, ...binding } = identity;
    runner.configureReview({
      revision,
      tasks,
      mappings,
      sourceWorkspace: identity.sourceWorkspace,
    });
    const policyDigest = "c".repeat(64);
    const receipt = {
      ...binding,
      policyDigest,
      version: 1 as const,
      issuer: "https://roles.bittrees.org" as const,
      audience: "https://mcp.bittrees.org" as const,
      activatedAt: new Date(activatedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      renewable: false as const,
    };
    await runner.activateReceipt(
      {
        receipt,
        signature: sign(
          null,
          Buffer.from(activationReceiptMessage(receipt)),
          keys.privateKey,
        ).toString("base64"),
      },
      { ...binding, subject, policyDigest, projectIds: ["crm", "agent"] },
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      { revision, tasks, mappings } as Parameters<
        TaskSyncRunner["activateReceipt"]
      >[3],
    );
    assert.deepEqual(f.savedApproval(), {
      identity,
      revision,
      tasks,
      mappings,
      transport: "native",
    });
    await runner.tick();
    assert.equal(runner.status().completedImports, 1);
    assert.deepEqual(calls, ["connect", "preview", "source", "execute"]);
    assert.equal(f.calls(), 0);
  } finally {
    f.cleanup();
  }
});

test("native preview signs only projects.list and continues once", async () => {
  const f = fixture();
  const runner = f.create(async () => ({ synthetic: true }));
  try {
    const approval = f.approval(runner);
    await runner.activate(approval);
    const { identity, tasks } = approval;
    const task = tasks[0] as SyncTask;
    const parameters = { tool: "projects.list", arguments: {} };
    const challenge = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: randomUUID(),
      issuedAt: identity.activatedAt,
      parametersDigest: digest(parameters),
      principal: identity.principal,
      credentialId: identity.credentialId,
      tenant: identity.tenant,
      workspace: identity.workspace,
      leaseId: identity.leaseId,
      runtimeBindingDigest: identity.runtimeBindingDigest,
      delegationId: null,
      project: "crm",
      resource: "workspace:projects",
      action: "task:read",
      stage: "execute",
    };
    for (const mode of ["success", "repeat", "mismatch"]) {
      let count = 0;
      let id: string;
      const run = runner.previewNative(
        {
          async execute(op) {
            assert.equal(op.kind, "preview");
            if (op.kind !== "preview") throw Error("Unexpected operation");
            if (++count === 1) {
              id = op.id;
              assert.equal(op.proof, undefined);
            } else {
              assert.equal(op.id, id!);
              const {
                proofs: [proof],
              } = JSON.parse(Buffer.from(op.proof!, "base64url").toString());
              assert.notEqual(proof.request.requestId, challenge.requestId);
              assert.equal(proof.request.operationId, challenge.operationId);
              assert.deepEqual(proof.attestation, { synthetic: true });
              assert.ok(
                verify(
                  null,
                  Buffer.from(
                    "Bittrees MCP authority request v1\n" +
                      canonical(proof.request),
                  ),
                  runner.device().publicKey,
                  Buffer.from(proof.signature, "base64"),
                ),
              );
              if (mode === "success")
                return Response.json({
                  id: op.id,
                  result: { structuredContent: { projects: [] } },
                });
            }
            return Response.json(
              {
                id: op.id,
                error: {
                  data: {
                    type: "roles-proof-required",
                    parameters,
                    request:
                      mode === "mismatch"
                        ? { ...challenge, workspace: "other" }
                        : challenge,
                  },
                },
              },
              { status: 428 },
            );
          },
        },
        identity,
        task,
        new AbortController().signal,
      );
      if (mode === "success") assert.deepEqual(await run, { projects: [] });
      else
        await assert.rejects(
          run,
          mode === "repeat" ? /repeated/ : /approved device/,
        );
      assert.equal(count, mode === "mismatch" ? 1 : 2);
    }
  } finally {
    f.cleanup();
  }
});
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
    assert.equal(f.calls(), 2);
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

test("source failures consume the durable run budget before dispatch and cannot reset on restart", async () => {
  const f = fixture({ maxWorkAttempts: 2 });
  let r = f.create();
  try {
    await r.activate(f.approval(r));
    f.setMode("source-lost");
    for (let n = 0; n < 2; n++) {
      await r.tick();
      await r.close();
      r = f.create();
    }
    await r.tick();
    assert.equal(f.calls(), 2);
    assert.equal(r.status().budget?.attempts, 2);
    assert.equal(r.status().progress.state, "held");
    assert.equal(r.status().enabled, false);
    assert.throws(() => r.resume(), /stopped run/);
    assert.throws(
      () =>
        r.configureExecutionBudget({
          ...r.status().budget?.review,
          runId: randomUUID(),
        }),
      /cannot be replaced/,
    );
    await r.tick();
    assert.equal(f.calls(), 2);
  } finally {
    await r.close();
    f.cleanup();
  }
});
