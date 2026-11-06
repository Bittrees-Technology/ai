import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { digest, type SyncTask } from "../modules/task-sync/proof-contract.js";
import { activationReceiptMessage } from "../modules/task-sync/runtime-contract.js";
import {
  taskSyncNativeTransport,
  type TaskSyncNativeScope,
} from "../modules/task-sync/native-runtime-transport.js";
import { TaskSyncRunBudget } from "../modules/task-sync/run-budget.js";

function fixture(connect = 0) {
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
      connect,
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

test("connection stays held before dispatch until native credential receiver is assembled", async () => {
  const f = fixture(),
    native = taskSyncNativeTransport(f.options)!;
  const at = Date.now();
  await assert.rejects(
    () =>
      native.execute({
        kind: "connect",
        body: {
          leaseReceipt: {
            signature: "synthetic",
            receipt: {
              version: 1,
              issuer: "https://roles.bittrees.org",
              audience: "https://mcp.bittrees.org",
              sourceWorkspace: f.scope.sourceWorkspace,
              leaseId: randomUUID(),
              policyDigest: "e".repeat(64),
              principal: f.scope.principal,
              credentialId: f.scope.credentialId,
              runtimeBindingDigest: "f".repeat(64),
              tenant: f.scope.tenant,
              workspace: f.scope.workspace,
              activatedAt: new Date(at).toISOString(),
              expiresAt: new Date(at + 30000).toISOString(),
              renewable: false,
            },
          },
        },
      }),
    /credential custody is not wired/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(f.budget.snapshot()?.requests, 0);
});

test("signed activation is bound to the host scope and returns no gateway bearer", async () => {
  for (const invalid of [null, "receipt", "response"] as const) {
    const f = fixture(2);
    const at = Date.now();
    const keys = generateKeyPairSync("ed25519");
    const task: SyncTask = {
      content: {
        sourceId: f.scope.tasks[0]!.sourceId,
        projectId: "agent",
        title: "Fixture",
        description: "",
        status: "todo",
        priority: "P1",
        area: "",
        acceptanceCriteria: [],
        progressNote: "",
        sourceUrl: "https://agent.bittrees.org/readiness",
      },
      destination: {
        projectId: randomUUID(),
        workspaceId: f.scope.sourceWorkspace,
      },
      fingerprint: "",
    };
    task.fingerprint = digest(task.content);
    f.scope.tasks[0]!.fingerprint = task.fingerprint;
    const expected = {
      principal: f.scope.principal,
      subject: f.scope.principal,
      credentialId: f.scope.credentialId,
      tenant: f.scope.tenant,
      workspace: f.scope.workspace,
      sourceWorkspace: f.scope.sourceWorkspace,
      leaseId: randomUUID(),
      runtimeBindingDigest: "e".repeat(64),
      policyDigest: "f".repeat(64),
      projectIds: ["crm", "agent"],
    };
    const { policyDigest, projectIds, ...binding } = expected;
    const { subject, ...receiptBinding } = binding;
    const receipt = {
      ...receiptBinding,
      policyDigest,
      version: 1 as const,
      issuer: "https://roles.bittrees.org" as const,
      audience: "https://mcp.bittrees.org" as const,
      activatedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 30000).toISOString(),
      renewable: false as const,
    };
    const signature = sign(
      null,
      Buffer.from(activationReceiptMessage(receipt)),
      keys.privateKey,
    ).toString("base64");
    const identity = {
      ...binding,
      subject,
      activatedAt: at,
      expiresAt: at + 30000,
    };
    const token = "synthetic-host-owned-token";
    let requests = 0;
    const native = taskSyncNativeTransport({
      ...f.options,
      credential: () => {
        throw Error("Gateway credential must come from protected connection");
      },
      connection: {
        expected,
        challengeTask: task,
        rolesPublicKey: keys.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        signAndAttest: async () => {
          throw Error("No challenge expected");
        },
      },
      request: async (url, init) => {
        requests++;
        const auth = new Headers(init?.headers).get("authorization");
        if (String(url).endsWith("/v1/task-sync/connect")) {
          assert.equal(auth, null);
          return Response.json(
            {
              identity:
                invalid === "response"
                  ? { ...identity, tenant: "other" }
                  : identity,
              token,
              projectIds,
              permissions: [
                "catalog:read",
                "task-sync:read",
                "task-sync:write",
              ],
            },
            { headers: { "x-test-secret": token } },
          );
        }
        assert.equal(auth, "Bearer " + token);
        return Response.json({ ok: true });
      },
    })!;
    const op = {
      kind: "connect",
      body: {
        leaseReceipt: {
          receipt,
          signature: invalid === "receipt" ? "wrong" : signature,
        },
      },
    };
    if (invalid) {
      await assert.rejects(() => native.execute(op), /Native connection held/);
      await assert.rejects(
        () => native.execute({ kind: "preview", id: randomUUID() }),
        /connection unavailable/,
      );
      assert.equal(requests, invalid === "receipt" ? 0 : 1);
    } else {
      const result = await native.execute(op);
      assert.deepEqual(await result.json(), { identity });
      assert.equal(result.headers.has("x-test-secret"), false);
      await native.execute({ kind: "preview", id: randomUUID() });
      assert.equal(requests, 2);
      assert.equal(f.budget.snapshot()?.requests, 2);
    }
    await assert.rejects(() => native.execute(op), /already attempted/);
  }
});
