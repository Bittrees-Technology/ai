import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { request } from "node:https";
import { nativeAssignmentRequest } from "../modules/task-sync/assignment-native.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import { TaskSyncRunBudget } from "../modules/task-sync/run-budget.js";
import { AssignmentNativeHTTPS } from "../modules/task-sync/assignment-https.js";
import {
  nativeAssignmentGateway,
  assignmentGatewayScope,
  validateAssignmentChallenge,
} from "../modules/task-sync/assignment-gateway-native.js";

function fixture() {
  const now = Date.now(),
    { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const identity = {
    principal: "agent:" + randomUUID(),
    credentialId: createHash("sha256").update(pem).digest("hex"),
    tenant: "fixture",
    workspace: "fixture",
    sourceWorkspace: randomUUID(),
    subject: "fixture",
    leaseId: randomUUID(),
    runtimeBindingDigest: "a".repeat(64),
    activatedAt: now - 1000,
    expiresAt: now + 60000,
  };
  const assignment = {
    assignmentId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 1,
    projectId: randomUUID(),
    workflowId: "fixture",
    workflowRevision: 1,
    principal: identity.principal,
  };
  const review = {
    version: 1 as const,
    epoch: randomUUID(),
    approvedAt: now - 100,
    expiresAt: now + 60000,
    profileId: "fixture",
    modelDigest: "b".repeat(64),
    assignments: [assignment],
  };
  const connectionId = randomUUID();
  const operation = {
    kind: "claim" as const,
    assignmentId: assignment.assignmentId,
    operationId: randomUUID(),
  };
  const parameters = {
    tool: "workflow_claim",
    arguments: {
      connectionId,
      workflowId: assignment.workflowId,
      operationId: operation.operationId,
      assignmentDigest: digest(assignment),
    },
  };
  const challenge = {
    type: "roles-proof-required" as const,
    parameters,
    request: {
      version: 1 as const,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: operation.operationId,
      parametersDigest: digest(parameters),
      issuedAt: now,
      principal: identity.principal,
      credentialId: identity.credentialId,
      delegationId: null,
      leaseId: identity.leaseId,
      runtimeBindingDigest: identity.runtimeBindingDigest,
      tenant: identity.tenant,
      workspace: identity.workspace,
      project: "workflow",
      resource: "workflow:fixture",
      action: "workflow:claim",
      stage: "execute",
    },
  };
  return {
    now,
    pem,
    privateKey,
    identity,
    assignment,
    review,
    connectionId,
    operation,
    challenge,
  };
}

test("assignment proof validates independently pinned connection and rejects altered identity, revision and operation", () => {
  const f = fixture();
  const validate = (raw: unknown, op = f.operation, review = f.review) =>
    validateAssignmentChallenge(
      raw,
      review,
      f.identity,
      f.connectionId,
      op,
      f.now,
    );
  assert.deepEqual(validate(f.challenge), f.challenge);
  for (const change of [
    { principal: "agent:" + randomUUID() },
    { credentialId: "c".repeat(64) },
    { leaseId: randomUUID() },
    { operationId: randomUUID() },
    { parametersDigest: "d".repeat(64) },
    { issuedAt: f.now - 16000 },
    { resource: "workflow:other" },
    { action: "workflow:complete" },
    { project: "crm" },
  ])
    assert.throws(() =>
      validate({
        ...f.challenge,
        request: { ...f.challenge.request, ...change },
      }),
    );
  assert.throws(() =>
    validate({
      ...f.challenge,
      parameters: {
        ...f.challenge.parameters,
        arguments: {
          ...f.challenge.parameters.arguments,
          connectionId: randomUUID(),
        },
      },
    }),
  );
  assert.throws(() =>
    validate(f.challenge, f.operation, {
      ...f.review,
      assignments: [{ ...f.assignment, taskRevision: 2 }],
    }),
  );
  assert.throws(() =>
    validateAssignmentChallenge(
      f.challenge,
      f.review,
      f.identity,
      f.connectionId,
      { kind: "task", assignmentId: f.assignment.assignmentId },
      f.now,
    ),
  );
});

test("completion proof keeps runtime and workflow leases separate and pins result receipt and method", () => {
  const f = fixture();
  const operation = {
    kind: "complete" as const,
    assignmentId: f.assignment.assignmentId,
    operationId: randomUUID(),
    runId: randomUUID(),
    leaseId: randomUUID(),
    crmOperationId: randomUUID(),
    resultDigest: "e".repeat(64),
    expiresAt: f.now + 30000,
  };
  const parameters = {
    tool: "workflow_crm_completion",
    arguments: {
      runId: operation.runId,
      operationId: operation.operationId,
      method: "PUT",
      connectionId: f.connectionId,
      assignmentDigest: digest(f.assignment),
      leaseId: operation.leaseId,
      crmOperationId: operation.crmOperationId,
      resultDigest: operation.resultDigest,
    },
  };
  const challenge = {
    ...f.challenge,
    parameters,
    request: {
      ...f.challenge.request,
      action: "workflow:complete",
      operationId: operation.operationId,
      parametersDigest: digest(parameters),
    },
  };
  assert.deepEqual(
    validateAssignmentChallenge(
      challenge,
      f.review,
      f.identity,
      f.connectionId,
      operation,
      f.now,
    ),
    challenge,
  );
  for (const change of [
    { runId: randomUUID() },
    { leaseId: f.identity.leaseId },
    { crmOperationId: randomUUID() },
    { resultDigest: "f".repeat(64) },
  ])
    assert.throws(() =>
      validateAssignmentChallenge(
        challenge,
        f.review,
        f.identity,
        f.connectionId,
        { ...operation, ...change },
        f.now,
      ),
    );
  assert.throws(() =>
    validateAssignmentChallenge(
      challenge,
      f.review,
      f.identity,
      f.connectionId,
      { ...operation, kind: "completion" },
      f.now,
    ),
  );
  assert.throws(() =>
    validateAssignmentChallenge(
      {
        ...challenge,
        request: { ...challenge.request, leaseId: operation.leaseId },
      },
      f.review,
      f.identity,
      f.connectionId,
      operation,
      f.now,
    ),
  );
});

for (const mode of [
  "success",
  "revoked-after-sign",
  "changed-proof",
  "budget-restart",
  "second-challenge",
  "response-budget",
  "extra-proof-field",
  "async-admit",
] as const) {
  test("native assignment gateway: " + mode, async () => {
    const f = fixture();
    let current: typeof f.review | null = f.review,
      state: unknown = null,
      calls = 0,
      signatures = 0;
    const scope = assignmentGatewayScope(f.review, f.identity, f.connectionId);
    const budget = new TaskSyncRunBudget(
      {
        read: () => state,
        write: (s) => {
          state = structuredClone(s);
        },
        atomic: (work) => work(),
      },
      () => f.now,
    );
    budget.bind({
      version: 1,
      confirmed: true,
      runId: randomUUID(),
      scopeDigest: scope,
      issuedAt: f.now - 100,
      expiresAt: f.now + 60000,
      maxWorkAttempts: 1,
      maxRequests: 2,
      maxRequestBytes: 64000,
      maxResponseBytes: mode === "response-budget" ? 1 : 64000,
      requestsByKind: {
        source: 0,
        connect: 0,
        execute: 2,
        preview: 0,
        owner: 0,
        attestation: 0,
        status: 0,
      },
    });
    const options = {
      current: () => current,
      identity: f.identity,
      connectionId: f.connectionId,
      publicKey: f.pem,
      credential: () => "synthetic-private-native-bearer",
      budget,
      now: () => f.now,
      admit: (wire: { url: string; body: string | null }) => {
        assert.equal(wire.url, "https://mcp.bittrees.org/v1/crm-assignments");
        assert.equal(
          JSON.stringify(wire).includes("synthetic-private-native-bearer"),
          false,
        );
        assert.deepEqual(JSON.parse(wire.body!), f.operation);
        if (mode === "async-admit") return Promise.resolve();
      },
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      send: ((_url: unknown, init: any, callback: any) => {
        calls++;
        assert.equal(init.rejectUnauthorized, true);
        assert.equal(init.servername, "mcp.bittrees.org");
        assert.equal(
          init.headers.Authorization,
          "Bearer synthetic-private-native-bearer",
        );
        if (calls === 2) assert.ok(init.headers["X-Bittrees-Agent-Proof"]);
        const req = new EventEmitter() as any;
        req.end = () =>
          queueMicrotask(() => {
            const challenge = calls === 1 || mode === "second-challenge";
            const res = Readable.from([
              JSON.stringify(
                challenge
                  ? {
                      error: "Local device signature required",
                      challenge: f.challenge,
                    }
                  : { runId: randomUUID() },
              ),
            ]) as any;
            res.statusCode = challenge ? 428 : 200;
            res.headers = { "content-type": "application/json" };
            callback(res);
          });
        return req;
      }) as typeof request,
      signAndAttest: async (challenge: any) => {
        signatures++;
        if (mode === "revoked-after-sign") current = null;
        const request =
          mode === "changed-proof"
            ? { ...challenge.request, operationId: randomUUID() }
            : challenge.request;
        return {
          ...(mode === "extra-proof-field"
            ? { unapproved: "must-not-leave-native" }
            : {}),
          request,
          signature: sign(
            null,
            Buffer.from(
              "Bittrees MCP authority request v1\n" + canonical(request),
            ),
            f.privateKey,
          ).toString("base64"),
          attestation: {
            request: {
              version: 1,
              issuer: "https://ai.bittrees.org",
              audience: "https://roles.bittrees.org",
              purpose: "decision",
              requestDigest: digest(challenge.request),
              authorityId: randomUUID(),
              deviceId: randomUUID(),
              ownerWallet: "0x" + "a".repeat(40),
              principal: f.identity.principal,
              credentialId: f.identity.credentialId,
              sourceWorkspace: f.identity.sourceWorkspace,
              issuedAt: f.now,
              expiresAt: f.now + 15000,
              nonce: randomUUID(),
            },
            signature: "synthetic",
          },
        };
      },
    };
    const gateway = nativeAssignmentGateway(options);
    if (
      mode === "revoked-after-sign" ||
      mode === "changed-proof" ||
      mode === "response-budget" ||
      mode === "extra-proof-field" ||
      mode === "async-admit"
    ) {
      await assert.rejects(
        gateway.forward(f.operation, AbortSignal.timeout(3000)),
      );
      assert.equal(calls, mode === "async-admit" ? 0 : 1);
    } else {
      const response = await gateway.forward(
        f.operation,
        AbortSignal.timeout(3000),
      );
      assert.equal(response.status, mode === "second-challenge" ? 428 : 200);
      await response.body?.cancel();
      assert.equal(calls, 2);
      if (mode === "budget-restart") {
        const restarted = nativeAssignmentGateway({
          ...options,
          budget: new TaskSyncRunBudget(
            {
              read: () => state,
              write: (s) => {
                state = structuredClone(s);
              },
              atomic: (work) => work(),
            },
            () => f.now,
          ),
        });
        await assert.rejects(
          restarted.forward(f.operation, AbortSignal.timeout(3000)),
          /budget/,
        );
        assert.equal(calls, 2);
      }
    }
    assert.equal(
      signatures,
      mode === "response-budget" || mode === "async-admit" ? 0 : 1,
    );
  });
}

test("assignment HTTPS rejects old task routes, extra keys, private DNS and revocation before socket", async () => {
  const operation = { kind: "task", assignmentId: randomUUID() },
    url = "https://mcp.bittrees.org/v1/crm-assignments";
  const init = {
    method: "POST",
    redirect: "error" as const,
    body: JSON.stringify(operation),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic-native-bearer",
    },
  };
  let lookups = 0,
    current = true;
  const adapter = new AssignmentNativeHTTPS(
    () => {
      if (!current) throw Error("Revoked");
    },
    async () => {
      lookups++;
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    },
    () => {
      throw Error("Unexpected socket");
    },
  );
  await assert.rejects(
    adapter.dispatch("https://agent.bittrees.org/tasks.json", init),
  );
  await assert.rejects(
    adapter.dispatch(url, {
      ...init,
      body: JSON.stringify({ ...operation, extra: true }),
    }),
  );
  await assert.rejects(
    adapter.dispatch(url, {
      ...init,
      headers: { ...init.headers, Cookie: "unapproved" },
    }),
  );
  assert.equal(lookups, 0);
  await assert.rejects(adapter.dispatch(url, init), /DNS address/);
  current = false;
  await assert.rejects(adapter.dispatch(url, init), /Revoked/);
  assert.equal(lookups, 1);
});

for (const kind of [
  "intake",
  "task",
  "write",
  "receipt",
  "finalize",
  "finalization",
] as const) {
  test("native challenge pins exact " + kind + " authority", () => {
    const f = fixture(),
      refs = {
        assignmentId: f.assignment.assignmentId,
        runId: randomUUID(),
        leaseId: randomUUID(),
        crmOperationId: randomUUID(),
      };
    const result = { summary: "Checked synthetic source" },
      operationId = randomUUID(),
      resultDigest = digest(result);
    const operation =
      kind === "intake" || kind === "task"
        ? { kind, assignmentId: refs.assignmentId }
        : kind === "write"
          ? { kind, ...refs, result }
          : kind === "receipt"
            ? { kind, ...refs }
            : kind === "finalize"
              ? {
                  kind,
                  ...refs,
                  operationId,
                  resultDigest,
                  expiresAt: f.now + 30000,
                }
              : { kind, ...refs, operationId, resultDigest };
    const parameters =
      kind === "intake" || kind === "task"
        ? {
            tool:
              kind === "intake" ? "workflow_crm_intake" : "workflow_crm_task",
            arguments: {
              connectionId: f.connectionId,
              workflowId: f.assignment.workflowId,
              assignmentDigest: digest(f.assignment),
            },
          }
        : kind === "write" || kind === "receipt"
          ? {
              tool:
                kind === "write"
                  ? "workflow_crm_result_write"
                  : "workflow_crm_result_read",
              arguments: {
                connectionId: f.connectionId,
                assignmentDigest: digest(f.assignment),
                runId: refs.runId,
                leaseId: refs.leaseId,
                crmOperationId: refs.crmOperationId,
                ...(kind === "write" ? { resultDigest } : {}),
              },
            }
          : {
              tool: "workflow_crm_completion",
              arguments: {
                runId: refs.runId,
                operationId,
                method: kind === "finalize" ? "PUT" : "GET",
                connectionId: f.connectionId,
                assignmentDigest: digest(f.assignment),
                leaseId: refs.leaseId,
                crmOperationId: refs.crmOperationId,
                resultDigest,
              },
            };
    const review = { ...f.review, completeTask: true };
    const challenge = {
      ...f.challenge,
      parameters,
      request: {
        ...f.challenge.request,
        action:
          kind === "intake" || kind === "task"
            ? "workflow:claim"
            : "workflow:complete",
        operationId:
          kind === "write" || kind === "receipt"
            ? refs.crmOperationId
            : operationId,
        parametersDigest: digest(parameters),
      },
    };
    assert.deepEqual(
      validateAssignmentChallenge(
        challenge,
        review,
        f.identity,
        f.connectionId,
        operation,
        f.now,
      ),
      challenge,
    );
    assert.throws(() =>
      validateAssignmentChallenge(
        { ...challenge, parameters: { ...parameters, extra: true } },
        review,
        f.identity,
        f.connectionId,
        operation,
        f.now,
      ),
    );
    assert.throws(() =>
      validateAssignmentChallenge(
        challenge,
        review,
        f.identity,
        randomUUID(),
        operation,
        f.now,
      ),
    );
    if (kind === "finalize" || kind === "finalization")
      assert.throws(() =>
        validateAssignmentChallenge(
          challenge,
          { ...review, completeTask: false },
          f.identity,
          f.connectionId,
          operation,
          f.now,
        ),
      );
    if (
      "crmOperationId" in operation &&
      (kind === "write" || kind === "receipt")
    )
      assert.throws(() =>
        validateAssignmentChallenge(
          challenge,
          review,
          f.identity,
          f.connectionId,
          { ...operation, crmOperationId: randomUUID() },
          f.now,
        ),
      );
  });
}

test("native REST translation retains original IDs for source finalization and readback", async () => {
  const f = fixture(),
    id = randomUUID(),
    crmOperationId = randomUUID(),
    claim = {
      assignmentDigest: digest(f.assignment),
      runId: randomUUID(),
      leaseId: randomUUID(),
      expiresAt: f.now + 30000,
    };
  const sent: unknown[] = [];
  const request = nativeAssignmentRequest({
    execute: async (raw) => {
      sent.push(raw);
      return Response.json({});
    },
  });
  for (const action of ["finalize", "read-finalization"] as const) {
    await request(
      "https://crm.bittrees.org/api/automation/tasks/" +
        f.assignment.taskId +
        "/finalizations/" +
        id,
      {
        method: action === "finalize" ? "PUT" : "GET",
        ...(action === "finalize"
          ? { headers: { "Idempotency-Key": id } }
          : {}),
      },
      {
        assignment: f.assignment,
        claim,
        action,
        crmOperationId,
        resultDigest: "d".repeat(64),
      },
    );
  }
  assert.deepEqual(sent, [
    {
      kind: "assignment",
      input: {
        kind: "finalize",
        assignmentId: f.assignment.assignmentId,
        runId: claim.runId,
        leaseId: claim.leaseId,
        crmOperationId,
        operationId: id,
        resultDigest: "d".repeat(64),
        expiresAt: claim.expiresAt,
      },
    },
    {
      kind: "assignment",
      input: {
        kind: "finalization",
        assignmentId: f.assignment.assignmentId,
        runId: claim.runId,
        leaseId: claim.leaseId,
        crmOperationId,
        operationId: id,
        resultDigest: "d".repeat(64),
      },
    },
  ]);
});
