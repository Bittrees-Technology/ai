import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import {
  verifyActivationReceipt,
  exchangeActivation,
} from "../modules/task-sync/activation.js";
import { activationReceiptMessage } from "../modules/task-sync/runtime-contract.js";
import { digest } from "../modules/task-sync/proof-contract.js";
function fixture() {
  const keys = generateKeyPairSync("ed25519"),
    now = Date.now(),
    workspace = randomUUID(),
    principal = "agent:" + randomUUID();
  const expected = {
    principal,
    credentialId: "a".repeat(64),
    tenant: "roles:" + randomUUID(),
    workspace: "crm:" + workspace,
    sourceWorkspace: workspace,
    subject: principal,
    leaseId: randomUUID(),
    runtimeBindingDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    projectIds: ["crm", "agent"],
  };
  const receipt = {
    version: 1,
    issuer: "https://roles.bittrees.org",
    audience: "https://mcp.bittrees.org",
    leaseId: expected.leaseId,
    policyDigest: expected.policyDigest,
    principal,
    credentialId: expected.credentialId,
    runtimeBindingDigest: expected.runtimeBindingDigest,
    tenant: expected.tenant,
    workspace: expected.workspace,
    sourceWorkspace: workspace,
    activatedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3599000).toISOString(),
    renewable: false,
  };
  const signed = {
    receipt,
    signature: sign(
      null,
      Buffer.from(activationReceiptMessage(receipt)),
      keys.privateKey,
    ).toString("base64"),
  };
  return {
    expected,
    receipt,
    signed,
    now,
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}
test("activation requires pinned Roles signature and exact saved enrollment and lease", () => {
  const f = fixture();
  assert.equal(
    verifyActivationReceipt(f.signed, f.expected, f.publicKey, f.now).identity
      .expiresAt,
    Date.parse(f.receipt.expiresAt),
  );
  for (const field of [
    "credentialId",
    "runtimeBindingDigest",
    "policyDigest",
    "workspace",
    "sourceWorkspace",
    "leaseId",
  ])
    assert.throws(() =>
      verifyActivationReceipt(
        f.signed,
        { ...f.expected, [field]: "changed" },
        f.publicKey,
        f.now,
      ),
    );
  assert.throws(() =>
    verifyActivationReceipt(
      {
        ...f.signed,
        receipt: {
          ...f.receipt,
          expiresAt: new Date(f.now + 5000000).toISOString(),
        },
      },
      f.expected,
      f.publicKey,
      f.now,
    ),
  );
  assert.throws(() =>
    verifyActivationReceipt(f.signed, f.expected, fixture().publicKey, f.now),
  );
  assert.throws(() =>
    verifyActivationReceipt(f.signed, f.expected, f.publicKey, f.now + 3600000),
  );
});
test("credential exchange reauthorizes over fixed TLS endpoint and rejects altered identity before returning token", async () => {
  const f = fixture();
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
  const task = {
    content,
    fingerprint: digest(content),
    destination: {
      projectId: randomUUID(),
      workspaceId: f.expected.sourceWorkspace,
    },
  };
  const identity = verifyActivationReceipt(
    f.signed,
    f.expected,
    f.publicKey,
    f.now,
  ).identity;
  let calls = 0;
  const request = (async (url: any, init: any) => {
    assert.equal(url, "https://mcp.bittrees.org/v1/task-sync/connect");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, undefined);
    calls++;
    return Response.json({
      identity: { ...identity, leaseId: randomUUID() },
      token: "test-not-real-credential",
      projectIds: ["crm", "agent"],
      permissions: ["catalog:read", "task-sync:read", "task-sync:write"],
    });
  }) as typeof fetch;
  await assert.rejects(
    exchangeActivation(
      f.signed,
      f.expected,
      f.publicKey,
      task,
      async () => {
        throw Error("unexpected");
      },
      request,
      () => f.now,
    ),
    /differs/,
  );
  assert.equal(calls, 1);
});
