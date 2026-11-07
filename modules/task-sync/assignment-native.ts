import { z } from "zod";
import type { AssignmentBinding } from "./assignment-runner.js";
import type { NativeTaskSyncClient } from "./native-loopback.js";

const assignmentId = z.uuid();
const operationId = z.uuid();
const lease = {
  assignmentId,
  runId: z.uuid(),
  leaseId: z.uuid(),
  crmOperationId: z.uuid(),
};
const completion = {
  ...lease,
  operationId,
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
export const assignmentGatewayOperation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("intake"), assignmentId }),
  z.strictObject({ kind: z.literal("claim"), assignmentId, operationId }),
  z.strictObject({ kind: z.literal("task"), assignmentId }),
  z.strictObject({
    kind: z.literal("write"),
    ...lease,
    result: z.strictObject({ summary: z.string().trim().min(1).max(4000) }),
  }),
  z.strictObject({ kind: z.literal("receipt"), ...lease }),
  z.strictObject({
    kind: z.literal("complete"),
    ...completion,
    expiresAt: z.int().positive(),
  }),
  z.strictObject({ kind: z.literal("completion"), ...completion }),
]);

export type AssignmentGatewayOperation = z.infer<
  typeof assignmentGatewayOperation
>;

export function nativeAssignmentRequest(client: NativeTaskSyncClient) {
  return (
    url: string,
    init: RequestInit,
    binding: AssignmentBinding & {
      crmOperationId: string;
      resultDigest?: string;
    },
  ) => {
    const assignmentId = binding.assignment.assignmentId;
    const operationId =
      new Headers(init.headers).get("idempotency-key") ??
      new URL(url).pathname.split("/").at(-1);
    const lease = {
      assignmentId,
      runId: binding.claim?.runId,
      leaseId: binding.claim?.leaseId,
      crmOperationId: binding.crmOperationId,
    };
    const completion = {
      ...lease,
      operationId,
      resultDigest: binding.resultDigest,
    };
    let input;
    switch (binding.action) {
      case "claim":
        input = { kind: "claim", assignmentId, operationId };
        break;
      case "read":
        input = { kind: "task", assignmentId };
        break;
      case "write":
        input = {
          kind: "write",
          ...lease,
          result: JSON.parse(String(init.body)).result,
        };
        break;
      case "read-receipt":
        input = { kind: "receipt", ...lease };
        break;
      case "complete":
        input = {
          kind: "complete",
          ...completion,
          expiresAt: binding.claim?.expiresAt,
        };
        break;
      case "read-completion":
        input = { kind: "completion", ...completion };
        break;
      default:
        throw Error("Assignment action has no gateway operation");
    }
    return client.execute(
      { kind: "assignment", input: assignmentGatewayOperation.parse(input) },
      init.signal ?? undefined,
    );
  };
}

/** The launcher binds this capability to a reviewed assignment and supplies
 * the protected gateway client. Only the launcher holds gateway credentials. */
export function nativeAssignmentSession(
  approvedAssignmentId: string,
  forward: (
    input: AssignmentGatewayOperation,
    signal?: AbortSignal,
  ) => Promise<Response>,
): NativeTaskSyncClient {
  const approved = assignmentId.parse(approvedAssignmentId);
  return {
    async execute(raw, signal) {
      const { input } = z
        .strictObject({
          kind: z.literal("assignment"),
          input: assignmentGatewayOperation,
        })
        .parse(raw);
      signal?.throwIfAborted();
      if (input.assignmentId !== approved)
        return Response.json(
          { error: "Assignment is outside the reviewed scope" },
          { status: 403 },
        );
      return forward(input, signal);
    },
  };
}
