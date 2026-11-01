import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  taskSyncNativeTransport,
  type TaskSyncNativeScope,
} from "../modules/task-sync/native-runtime-transport.js";
import { TaskSyncRunBudget } from "../modules/task-sync/run-budget.js";

function fixture() {
  let state: unknown = null,
    calls = 0,
    denied = false;
  const now = Date.now();
  const scope: TaskSyncNativeScope = {
    version: 1,
    scopeDigest: "a".repeat(64),
    principal: "agent:" + randomUUID(),
    credentialId: "b".repeat(64),
    tenant: "synthetic-only",
    workspace: "crm:synthetic",
    sourceWorkspace: randomUUID(),
    revision: "c".repeat(64),
    projects: ["agent"],
    tasks: [
      { sourceId: "agent-readiness:agent:test", fingerprint: "d".repeat(64) },
    ],
  };
  let current: TaskSyncNativeScope | null = scope;
  const budget = new TaskSyncRunBudget({
    read: () => state,
    write: (s) => (state = structuredClone(s)),
    atomic: (f) => f(),
  });
  budget.bind({
    version: 1,
    confirmed: true,
    runId: randomUUID(),
    scopeDigest: scope.scopeDigest,
    issuedAt: now,
    expiresAt: now + 30000,
    maxWorkAttempts: 3,
    maxRequests: 3,
    maxRequestBytes: 10000,
    maxResponseBytes: 10000,
    requestsByKind: {
      source: 3,
      execute: 3,
      preview: 3,
      connect: 0,
      owner: 0,
      attestation: 0,
      status: 0,
    },
  });
  let wire: { url: string; init?: RequestInit } | undefined;
  const options = {
    enabled: true,
    current: () => current,
    budget,
    authorize: () => {
      if (denied) throw Error("current source authorization denied");
    },
    credential: () => "synthetic-not-a-production-credential",
    request: (async (input, init) => {
      calls++;
      wire = { url: String(input), init };
      return Response.json({ synthetic: true });
    }) as typeof fetch,
  };
  return {
    options,
    scope,
    budget,
    calls: () => calls,
    wire: () => wire!,
    revoke: () => (current = null),
    deny: () => (denied = true),
  };
}
test("disabled native candidate touches no identity, credential, verifier or network", () => {
  const f = fixture();
  const fail = () => {
    throw Error("must remain untouched");
  };
  assert.equal(
    taskSyncNativeTransport({
      ...f.options,
      enabled: false,
      current: fail,
      credential: fail,
      authorize: fail,
      request: fail,
    }),
    null,
  );
  assert.equal(f.calls(), 0);
});
test("native candidate derives exact fixed gateway request and obtains credential only from native owner", async () => {
  const f = fixture(),
    native = taskSyncNativeTransport(f.options)!;
  const response = await native.execute({
    kind: "execute",
    id: randomUUID(),
    sourceId: f.scope.tasks[0]!.sourceId,
    expectedFingerprint: f.scope.tasks[0]!.fingerprint,
  });
  assert.deepEqual(await response.json(), { synthetic: true });
  const wire = f.wire();
  assert.equal(
    wire.url,
    "https://mcp.bittrees.org/mcp?mode=selected&projects=crm%2Cagent",
  );
  assert.equal(wire.init?.redirect, "error");
  assert.match(
    new Headers(wire.init?.headers).get("authorization")!,
    /^Bearer synthetic-/,
  );
  assert.equal(new Headers(wire.init?.headers).has("cookie"), false);
  assert.deepEqual(JSON.parse(wire.init?.body as string).params.arguments, {
    sourceId: f.scope.tasks[0]!.sourceId,
    expectedFingerprint: f.scope.tasks[0]!.fingerprint,
    confirmed: true,
  });
  assert.equal(f.budget.snapshot()?.requests, 1);
});
test("arbitrary URLs, headers, unreviewed tasks and denied authority never dispatch", async () => {
  const f = fixture(),
    native = taskSyncNativeTransport(f.options)!;
  for (const raw of [
    { kind: "source", url: "https://example.invalid" },
    {
      kind: "preview",
      id: randomUUID(),
      headers: { Authorization: "untrusted" },
    },
    {
      kind: "execute",
      id: randomUUID(),
      sourceId: "different",
      expectedFingerprint: "d".repeat(64),
    },
  ])
    await assert.rejects(() => native.execute(raw));
  f.deny();
  await assert.rejects(
    () => native.execute({ kind: "source" }),
    /authorization denied/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(f.budget.snapshot()?.requests, 0);
});
test("changed native scope is checked before dispatch and before releasing streamed content", async () => {
  const f = fixture(),
    native = taskSyncNativeTransport(f.options)!;
  const response = await native.execute({ kind: "source" });
  f.revoke();
  await assert.rejects(() => response.json());
  await assert.rejects(() => native.execute({ kind: "source" }));
  assert.equal(f.calls(), 1);
});
