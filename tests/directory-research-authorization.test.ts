import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import {
  createDirectoryResearchAuthorization,
  directoryRolesDecisionMessage,
  directorySourceDecisionMessage,
} from "../modules/research/directory-research-authorization.js";
import { digest } from "../modules/task-sync/proof-contract.js";

test("authorization rejects wrong signatures, expired decisions, replaced policy and source binding", async () => {
  const roles = generateKeyPairSync("ed25519"),
    source = generateKeyPairSync("ed25519");
  const pem = (key: typeof roles.publicKey) =>
    key.export({ type: "spki", format: "pem" }).toString();
  const binding = {
    principal: "agent:" + randomUUID(),
    credentialId: "c".repeat(64),
    personPrincipal: "person:" + randomUUID(),
    tenant: "fixture",
    workspace: "fixture",
    workflowId: "fixture",
    workflowRevision: 1,
    connectionId: randomUUID(),
    delegationId: randomUUID(),
    policyDigest: "a".repeat(64),
    sourceConsentRevision: 1,
  };
  const item = {
    originalReceiptId: randomUUID(),
    lastRecordedRetryReceiptId: randomUUID(),
    reviewedResearchUrl: "https://example.com/",
    historicalAttempts: 0,
  };
  const scope = {
    digest: "b".repeat(64),
    originalValidationRunId: randomUUID(),
    items: [item],
  };
  const at = Date.now();
  let mode = "ok",
    sourceCalls = 0;
  for (const next of [
    "ok",
    "forged-roles",
    "expired",
    "policy",
    "binding",
    "replayed-source",
    "source-race",
  ]) {
    mode = next;
    sourceCalls = 0;
    const authorize = createDirectoryResearchAuthorization(
      binding,
      {
        roles: pem(roles.publicKey),
        source: pem(source.publicKey),
      },
      {
        async roles(request) {
          const decision = {
            version: 1,
            issuer: "https://roles.bittrees.org",
            audience: "https://mcp.bittrees.org",
            request,
            checkedAt: at,
            expiresAt: mode === "expired" ? at - 1 : at + 4000,
            allowed: true,
            requiresSourceAuthorization: true,
            policyDigest:
              mode === "policy" ? "d".repeat(64) : binding.policyDigest,
          };
          return {
            decision,
            signature: sign(
              null,
              Buffer.from(directoryRolesDecisionMessage(decision)),
              mode === "forged-roles" ? source.privateKey : roles.privateKey,
            ).toString("base64"),
          };
        },
        async source(request) {
          sourceCalls++;
          const decision = {
            version: 1,
            issuer: "https://cd.bittrees.org",
            audience: "https://mcp.bittrees.org",
            purpose: "directory-research",
            requestDigest:
              mode === "replayed-source" ? "e".repeat(64) : digest(request),
            binding:
              mode === "binding"
                ? { ...binding, workflowRevision: 2 }
                : binding,
            checkedAt: at,
            expiresAt: at + 4000,
            allowed: mode !== "source-race" || sourceCalls === 1,
          };
          return {
            decision,
            signature: sign(
              null,
              Buffer.from(directorySourceDecisionMessage(decision)),
              source.privateKey,
            ).toString("base64"),
          };
        },
      },
      () => at,
    );
    const work = authorize(scope, item, "source", new AbortController().signal);
    if (mode === "ok") assert.equal(await work, true);
    else await assert.rejects(work);
  }
});
