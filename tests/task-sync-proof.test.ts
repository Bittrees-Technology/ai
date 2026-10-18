import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, verify } from "node:crypto";
import {
  digest,
  validateChallenge,
  importOperation,
  signChallenges,
  type SyncIdentity,
  type SyncTask,
} from "../modules/task-sync/proof-contract.js";
import { canonical } from "../modules/workflows/central-worker.js";
test("native task sync signs only reviewed imports and rejects widened authority, expiry and changed retries", () => {
  const now = Date.now(),
    workspace = randomUUID();
  const i: SyncIdentity = {
    principal: "agent:" + randomUUID(),
    credentialId: "a".repeat(64),
    tenant: "t",
    workspace,
    subject: "device",
    leaseId: randomUUID(),
    runtimeBindingDigest: "b".repeat(64),
    activatedAt: now - 1000,
    expiresAt: now + 3599000,
  };
  const content = {
    sourceId: "agent-readiness:agent:review",
    projectId: "agent",
    title: "Review",
    description: "Description",
    status: "todo" as const,
    priority: "P0" as const,
    area: "docs",
    acceptanceCriteria: ["Evidence"],
    progressNote: "",
    sourceUrl: "https://agent.bittrees.org/readiness#review",
  };
  const task: SyncTask = {
      content,
      fingerprint: digest(content),
      destination: { projectId: randomUUID(), workspaceId: workspace },
    },
    operationId = importOperation(i, task);
  const parameters = {
    tool: "tasks.import_source",
    arguments: {
      projectId: task.destination.projectId,
      operationId,
      source: "https://agent.bittrees.org",
      sourceId: content.sourceId,
      contentHash: task.fingerprint,
      title: content.title,
      description: content.description,
      sourceUrl: content.sourceUrl,
      sourceStatus: content.status,
      sourcePriority: content.priority,
      expectedVersion: 2,
    },
  };
  const request = {
    version: 1,
    source: "mcp.bittrees.org",
    audience: "https://roles.bittrees.org/api/authority/mcp-decision",
    requestId: randomUUID(),
    operationId,
    parametersDigest: digest(parameters),
    issuedAt: now,
    principal: i.principal,
    credentialId: i.credentialId,
    delegationId: null,
    leaseId: i.leaseId,
    runtimeBindingDigest: i.runtimeBindingDigest,
    tenant: i.tenant,
    workspace,
    project: "crm",
    resource: "project:" + task.destination.projectId,
    action: "task:import",
    stage: "execute",
  };
  const raw = { type: "roles-proof-required", request, parameters },
    valid = validateChallenge(raw, i, task, undefined, now);
  for (const delta of [
    { leaseId: randomUUID() },
    { runtimeBindingDigest: "c".repeat(64) },
    { principal: "agent:" + randomUUID() },
    { action: "task:delete" },
    { issuedAt: now - 16000 },
    { unexpected: true },
  ])
    assert.throws(() =>
      validateChallenge(
        { ...raw, request: { ...request, ...delta } },
        i,
        task,
        undefined,
        now,
      ),
    );
  assert.throws(() =>
    validateChallenge(raw, { ...i, expiresAt: now }, task, undefined, now),
  );
  assert.throws(() =>
    validateChallenge(
      raw,
      { ...i, expiresAt: now + 3600001 },
      task,
      undefined,
      now,
    ),
  );
  const changed = {
    ...parameters,
    arguments: { ...parameters.arguments, expectedVersion: 3 },
  };
  assert.throws(() =>
    validateChallenge(
      {
        ...raw,
        parameters: changed,
        request: { ...request, parametersDigest: digest(changed) },
      },
      i,
      task,
      parameters,
      now,
    ),
  );
  const broadened = {
    ...parameters,
    arguments: { ...parameters.arguments, title: "Unapproved" },
  };
  assert.throws(() =>
    validateChallenge(
      {
        ...raw,
        parameters: broadened,
        request: { ...request, parametersDigest: digest(broadened) },
      },
      i,
      task,
      undefined,
      now,
    ),
  );
  const keys = generateKeyPairSync("ed25519");
  const key = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const first = JSON.parse(
      Buffer.from(signChallenges([valid], key, i, now), "base64url").toString(),
    ).proofs[0],
    second = JSON.parse(
      Buffer.from(
        signChallenges([valid], key, i, now + 1),
        "base64url",
      ).toString(),
    ).proofs[0];
  assert.notEqual(first.request.requestId, second.request.requestId);
  assert.equal(first.request.operationId, second.request.operationId);
  assert.ok(
    verify(
      null,
      Buffer.from(
        "Bittrees MCP authority request v1\n" + canonical(first.request),
      ),
      keys.publicKey,
      Buffer.from(first.signature, "base64"),
    ),
  );
  assert.throws(() =>
    signChallenges([valid, valid, valid, valid], key, i, now),
  );
});
