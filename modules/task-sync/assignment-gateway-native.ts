import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { AssignmentNativeHTTPS } from "./assignment-https.js";
import {
  assignmentGatewayOperation,
  type AssignmentGatewayOperation,
} from "./assignment-native.js";
import {
  assignmentServiceReview,
  launchAssignmentServiceBroker,
} from "./assignment-service-native.js";
import {
  activeLease,
  digest,
  taskSyncIdentitySchema,
  type SyncIdentity,
} from "./proof-contract.js";
import type { TaskSyncRunBudget } from "./run-budget.js";
import { assignmentAuthorityRequest as authorityRequest } from "./assignment-proof-contract.js";
import { runtimeAttestationSchema } from "./runtime-contract.js";

const challengeSchema = z.strictObject({
  type: z.literal("roles-proof-required"),
  request: authorityRequest,
  parameters: z.record(z.string(), z.unknown()),
});
type Review = z.infer<typeof assignmentServiceReview>;
export type AssignmentChallenge = z.infer<typeof challengeSchema>;

/** Validate independently reviewed task/connection/operation bindings before
 * asking the native signer for a workflow-purpose proof. Import/read proofs
 * and central identity discovery never supply this authority. */
export function validateAssignmentChallenge(
  raw: unknown,
  review: Review,
  identity: SyncIdentity,
  connectionId: string,
  operation: AssignmentGatewayOperation,
  now = Date.now(),
) {
  activeLease(identity, now);
  const challenge = challengeSchema.parse(raw),
    request = challenge.request;
  const assignment = review.assignments.find(
    (item) => item.assignmentId === operation.assignmentId,
  );
  if (
    !assignment ||
    assignment.principal !== identity.principal ||
    !["claim", "complete", "completion"].includes(operation.kind)
  )
    throw Error("Assignment proof is outside the native reviewed operation");
  for (const field of [
    "principal",
    "credentialId",
    "tenant",
    "workspace",
    "leaseId",
    "runtimeBindingDigest",
  ] as const)
    if (request[field] !== identity[field])
      throw Error("Assignment proof identity changed");
  if (
    request.issuedAt < now - 15000 ||
    request.issuedAt > now + 1000 ||
    request.issuedAt < identity.activatedAt ||
    request.delegationId !== null ||
    request.resource !== "workflow:" + assignment.workflowId
  )
    throw Error("Assignment proof scope or freshness rejected");
  let parameters: unknown;
  if (operation.kind === "claim") {
    if (
      request.action !== "workflow:claim" ||
      request.operationId !== operation.operationId
    )
      throw Error("Assignment claim operation changed");
    parameters = {
      tool: "workflow_claim",
      arguments: {
        connectionId,
        workflowId: assignment.workflowId,
        operationId: operation.operationId,
        assignmentDigest: digest(assignment),
      },
    };
  } else if (operation.kind === "complete" || operation.kind === "completion") {
    if (
      request.action !== "workflow:complete" ||
      request.operationId !== operation.operationId
    )
      throw Error("Assignment completion operation changed");
    parameters = {
      tool: "workflow_crm_completion",
      arguments: {
        runId: operation.runId,
        operationId: operation.operationId,
        method: operation.kind === "complete" ? "PUT" : "GET",
        connectionId,
        assignmentDigest: digest(assignment),
        leaseId: operation.leaseId,
        crmOperationId: operation.crmOperationId,
        resultDigest: operation.resultDigest,
      },
    };
  }
  if (
    digest(parameters) !== request.parametersDigest ||
    digest(challenge.parameters) !== digest(parameters)
  )
    throw Error("Assignment proof parameters changed");
  return challenge;
}

export function assignmentGatewayScope(
  review: Review,
  identity: SyncIdentity,
  connectionId: string,
) {
  return digest({
    review: assignmentServiceReview.parse(review),
    identity: taskSyncIdentitySchema.parse(identity),
    connectionId: z.uuid().parse(connectionId),
  });
}

/** Native construction only. The caller supplies an already approved lease,
 * source/cost verifier, protected signer and existing durable request budget.
 * No creation, enrollment, grant, source credential or network discovery.
 * Bind the returned forward function to launchAssignmentServiceBroker. */
export function nativeAssignmentGateway(options: {
  current: () => Review | null;
  identity: SyncIdentity;
  connectionId: string;
  publicKey: string;
  credential: () => string;
  budget: TaskSyncRunBudget;
  admit: ConstructorParameters<typeof AssignmentNativeHTTPS>[0];
  signAndAttest: (
    challenge: AssignmentChallenge,
    signal: AbortSignal,
  ) => Promise<{
    request: unknown;
    signature: string;
    attestation: { request: Record<string, unknown>; signature: string };
  }>;
  resolve?: ConstructorParameters<typeof AssignmentNativeHTTPS>[1];
  send?: ConstructorParameters<typeof AssignmentNativeHTTPS>[2];
  now?: () => number;
}) {
  const review = assignmentServiceReview.parse(options.current()),
    identity = taskSyncIdentitySchema.parse(options.identity),
    connectionId = z.uuid().parse(options.connectionId),
    scope = assignmentGatewayScope(review, identity, connectionId),
    key = createPublicKey(options.publicKey),
    now = options.now ?? Date.now;
  if (
    key.asymmetricKeyType !== "ed25519" ||
    createHash("sha256")
      .update(key.export({ type: "spki", format: "pem" }))
      .digest("hex") !== identity.credentialId ||
    review.assignments.some((item) => item.principal !== identity.principal)
  )
    throw Error("Assignment gateway credential differs from approved worker");
  const current = () => {
    activeLease(identity, now());
    const value = assignmentServiceReview.parse(options.current());
    if (
      assignmentGatewayScope(value, identity, connectionId) !== scope ||
      value.approvedAt > now() ||
      value.expiresAt <= now() ||
      value.expiresAt - value.approvedAt > 900000
    )
      throw Error("Native assignment scope changed or expired");
    options.budget.assertCurrent(scope);
    return scope;
  };
  current();
  const https = new AssignmentNativeHTTPS(
    (wire, signal) => {
      current();
      const decision: unknown = options.admit(wire, signal);
      if (decision !== undefined) {
        if (decision instanceof Promise) void decision.catch(() => {});
        throw Error("Synchronous native assignment admission required");
      }
      current();
    },
    options.resolve,
    options.send,
  );
  const dispatch = options.budget.fetch(
    https.dispatch,
    current,
    () => "execute",
  );
  let busy = false;
  return {
    scope,
    async forward(raw: unknown, signal: AbortSignal) {
      if (busy) throw Error("Native assignment gateway is busy");
      busy = true;
      try {
        const operation = assignmentGatewayOperation.parse(raw);
        current();
        if (
          !review.assignments.some(
            (item) => item.assignmentId === operation.assignmentId,
          )
        )
          throw Error("Assignment outside native reviewed batch");
        const body = JSON.stringify(operation);
        const send = async (proof?: string) => {
          current();
          signal.throwIfAborted();
          const token = options.credential();
          if (!/^[\x21-\x7e]{16,4096}$/.test(token))
            throw Error("Native gateway credential unavailable");
          const response = await dispatch(
            "https://mcp.bittrees.org/v1/crm-assignments",
            {
              method: "POST",
              redirect: "error",
              signal,
              body,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: "Bearer " + token,
                ...(proof ? { "x-bittrees-agent-proof": proof } : {}),
              },
            },
          );
          // Consume the metered body inside the native gate. A core caller
          // cannot avoid the durable response budget by ignoring its stream.
          const bytes = await response.arrayBuffer();
          current();
          return new Response(bytes, {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        };
        const first = await send();
        if (first.status !== 428) return first;
        const decoded = z
          .strictObject({
            error: z.string().max(1000),
            challenge: challengeSchema,
          })
          .parse(await first.json());
        current();
        const challenge = validateAssignmentChallenge(
          decoded.challenge,
          review,
          identity,
          connectionId,
          operation,
          now(),
        );
        const proof = z
          .strictObject({
            request: authorityRequest,
            signature: z.string().min(1).max(128),
            attestation: z.strictObject({
              request: runtimeAttestationSchema,
              signature: z.string().min(1).max(200),
            }),
          })
          .parse(
            await options.signAndAttest(structuredClone(challenge), signal),
          );
        signal.throwIfAborted();
        current();
        const attestation = proof.attestation.request;
        if (
          attestation.purpose !== "decision" ||
          attestation.requestDigest !== digest(challenge.request) ||
          attestation.principal !== identity.principal ||
          attestation.credentialId !== identity.credentialId ||
          attestation.sourceWorkspace !== identity.sourceWorkspace ||
          attestation.issuedAt > now() + 1000 ||
          attestation.issuedAt < now() - 15000 ||
          attestation.expiresAt <= now() ||
          attestation.expiresAt <= attestation.issuedAt ||
          attestation.expiresAt - attestation.issuedAt > 15000
        )
          throw Error(
            "Assignment registration attestation scope or lifetime rejected",
          );
        if (
          digest(proof.request) !== digest(challenge.request) ||
          !verify(
            null,
            Buffer.from(
              "Bittrees MCP authority request v1\n" +
                canonical(challenge.request),
            ),
            key,
            Buffer.from(proof.signature, "base64"),
          ) ||
          !proof.attestation?.request ||
          typeof proof.attestation.signature !== "string" ||
          Buffer.byteLength(JSON.stringify(proof.attestation)) > 4096
        )
          throw Error("Native assignment signature or attestation rejected");
        const encoded = Buffer.from(JSON.stringify(proof)).toString(
          "base64url",
        );
        if (encoded.length > 16384)
          throw Error("Assignment proof exceeds native wire limit");
        // One challenge continuation only. The caller reconciles any uncertain
        // outcome under the original durable operation, never a replacement.
        return await send(encoded);
      } finally {
        busy = false;
      }
    },
  };
}

/** Reviewed native bootstrap entry. Ordinary app startup supplies no options.
 * Runtime keys, credentials and current authority stay on this side of IPC. */
export async function launchNativeAssignmentService(
  options: Parameters<typeof nativeAssignmentGateway>[0] & {
    authorize: Parameters<typeof launchAssignmentServiceBroker>[0]["authorize"];
    validate: NonNullable<
      Parameters<typeof launchAssignmentServiceBroker>[0]["validate"]
    >;
  },
) {
  const gateway = nativeAssignmentGateway(options);
  return launchAssignmentServiceBroker({
    current: options.current,
    authorize: options.authorize,
    validate: options.validate,
    forward: gateway.forward,
    now: options.now,
  });
}
