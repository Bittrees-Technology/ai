import { randomUUID, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { digest } from "../task-sync/proof-contract.js";
import type { createDirectoryResearchBridge } from "./directory-research-bridge.js";

type Authorize = Parameters<
  typeof createDirectoryResearchBridge
>[2]["authorize"];
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  credentialId: hex,
  personPrincipal: z.string().regex(/^person:[a-f0-9-]{36}$/),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  workflowId: z.string().min(1).max(128),
  workflowRevision: z.int().positive(),
  connectionId: z.uuid(),
  delegationId: z.uuid(),
  policyDigest: hex,
  sourceConsentRevision: z.int().positive(),
});
const rolesDecision = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://roles.bittrees.org"),
  audience: z.literal("https://mcp.bittrees.org"),
  request: z.unknown(),
  checkedAt: z.int(),
  expiresAt: z.int(),
  allowed: z.boolean(),
  requiresSourceAuthorization: z.literal(true),
  policyDigest: hex,
});
const sourceDecision = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://cd.bittrees.org"),
  audience: z.literal("https://mcp.bittrees.org"),
  purpose: z.literal("directory-research"),
  requestDigest: hex,
  binding: bindingSchema,
  checkedAt: z.int(),
  expiresAt: z.int(),
  allowed: z.boolean(),
});
const envelope = z.strictObject({
  decision: z.unknown(),
  signature: z.string().max(128),
});

export const directorySourceDecisionMessage = (decision: unknown) =>
  "Bittrees staged directory research source decision v1\n" +
  canonical(decision);
export const directoryRolesDecisionMessage = (decision: unknown) =>
  "Bittrees MCP authority decision v1\n" + canonical(decision);

/** Review candidate only. The source-purpose issuer and action require separate
 * live approval. Keys and resolvers belong to the trusted native launcher. */
export function createDirectoryResearchAuthorization(
  rawBinding: unknown,
  keys: { roles: string; source: string },
  resolve: {
    roles(request: unknown, signal: AbortSignal): Promise<unknown>;
    source(request: unknown, signal: AbortSignal): Promise<unknown>;
  },
  now = Date.now,
): Authorize {
  const binding = bindingSchema.parse(rawBinding);
  const rolesKey = createPublicKey(keys.roles),
    sourceKey = createPublicKey(keys.source);
  if ([rolesKey, sourceKey].some((key) => key.asymmetricKeyType !== "ed25519"))
    throw Error("Directory research authorization requires Ed25519 trust keys");
  const fresh = (decision: { checkedAt: number; expiresAt: number }) => {
    const at = now();
    if (
      decision.checkedAt > at + 1000 ||
      decision.checkedAt < at - 5000 ||
      decision.expiresAt <= at ||
      decision.expiresAt <= decision.checkedAt ||
      decision.expiresAt - decision.checkedAt > 5000
    )
      throw Error("Directory research authorization expired");
  };
  return async (scope, item, phase, signal) => {
    signal.throwIfAborted();
    const parameters = {
      tool: "directory_research_run",
      arguments: {
        scopeDigest: scope.digest,
        originalValidationRunId: scope.originalValidationRunId,
        originalReceiptId: item.originalReceiptId,
        lastRecordedRetryReceiptId: item.lastRecordedRetryReceiptId,
        url: item.reviewedResearchUrl,
        phase,
        binding,
      },
    };
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: item.lastRecordedRetryReceiptId,
      parametersDigest: digest(parameters),
      issuedAt: now(),
      principal: binding.principal,
      credentialId: binding.credentialId,
      delegationId: binding.delegationId,
      tenant: binding.tenant,
      workspace: binding.workspace,
      project: "workflow",
      resource: "workflow:" + binding.workflowId,
      action: "directory.research",
      stage: "execute",
    };
    const sourceRequest = { request, parameters };
    const checkSource = async () => {
      const raw = envelope.parse(await resolve.source(sourceRequest, signal));
      const decision = sourceDecision.parse(raw.decision);
      if (
        !verify(
          null,
          Buffer.from(directorySourceDecisionMessage(decision)),
          sourceKey,
          Buffer.from(raw.signature, "base64"),
        ) ||
        !decision.allowed ||
        decision.requestDigest !== digest(sourceRequest) ||
        canonical(decision.binding) !== canonical(binding)
      )
        throw Error("Directory research source authorization denied");
      fresh(decision);
      signal.throwIfAborted();
    };
    await checkSource();
    const raw = envelope.parse(await resolve.roles(request, signal));
    const decision = rolesDecision.parse(raw.decision);
    if (
      !verify(
        null,
        Buffer.from(directoryRolesDecisionMessage(decision)),
        rolesKey,
        Buffer.from(raw.signature, "base64"),
      ) ||
      !decision.allowed ||
      canonical(decision.request) !== canonical(request) ||
      decision.policyDigest !== binding.policyDigest
    )
      throw Error("Directory research Roles authorization denied");
    fresh(decision);
    await checkSource();
    fresh(decision);
    signal.throwIfAborted();
    return true;
  };
}
