import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ProtectedLoopbackBroker } from "./enrollment-broker.js";
import { ProtectedLoopbackClient } from "./enrollment-client.js";
import {
  assignmentSchema,
  type AssignmentBinding,
} from "./assignment-runner.js";
import { assignmentGatewayOperation } from "./assignment-native.js";
import { digest } from "./proof-contract.js";

export const assignmentServiceReview = z
  .strictObject({
    version: z.literal(1),
    epoch: z.uuid(),
    approvedAt: z.int(),
    expiresAt: z.int(),
    profileId: z.string().min(1).max(128),
    modelDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    assignments: z.array(assignmentSchema).min(1).max(60),
  })
  .refine(
    (value) =>
      new Set(value.assignments.map((a) => a.assignmentId)).size ===
      value.assignments.length,
    "Duplicate assignment in native review",
  );
const binding = z.strictObject({
  assignment: assignmentSchema,
  claim: z
    .strictObject({
      assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      runId: z.uuid(),
      leaseId: z.uuid(),
      expiresAt: z.int().positive(),
    })
    .optional(),
  action: z.enum([
    "claim",
    "read",
    "infer",
    "write",
    "read-receipt",
    "complete",
    "read-completion",
  ]),
  request: z
    .strictObject({
      url: z.string().max(1024),
      method: z.enum(["GET", "POST", "PUT"]),
      bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
      operationId: z.uuid().nullable(),
    })
    .optional(),
  inputDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const assignmentServiceOperation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("review") }),
  z.strictObject({ kind: z.literal("authorize"), epoch: z.uuid(), binding }),
  z.strictObject({
    kind: z.literal("assignment"),
    epoch: z.uuid(),
    input: assignmentGatewayOperation,
  }),
]);
export type AssignmentServiceClient = {
  execute(raw: unknown, signal: AbortSignal): Promise<Response>;
};
const response = z.strictObject({
  status: z.int().min(200).max(599),
  body: z.record(z.string(), z.unknown()),
});
const protocol = {
  path: "/crm-assignments",
  parse: (raw: unknown) => assignmentServiceOperation.parse(raw),
  maxRequest: 24000,
  maxResponse: 256000,
  deadline: 22000,
};

/** Construct only from current native owner/source/cost admission. No identity,
 * credential, authority or route is discovered from caller/model configuration. */
export async function launchAssignmentServiceBroker(options: {
  current: () => unknown | null;
  authorize: (
    review: z.infer<typeof assignmentServiceReview>,
    binding: AssignmentBinding,
    signal: AbortSignal,
  ) => Promise<void>;
  forward: (
    input: z.infer<typeof assignmentGatewayOperation>,
    signal: AbortSignal,
  ) => Promise<Response>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const token = randomBytes(32).toString("hex");
  const session = {
    async execute(
      operation: z.infer<typeof assignmentServiceOperation>,
      signal: AbortSignal,
    ) {
      const current = () => {
        signal.throwIfAborted();
        const review = assignmentServiceReview.parse(options.current());
        const at = now();
        if (
          review.approvedAt > at ||
          review.expiresAt <= at ||
          review.expiresAt - review.approvedAt > 900000
        )
          throw Error("Native assignment review expired");
        return review;
      };
      const review = current(),
        pin = digest(review);
      const recheck = () => {
        if (digest(current()) !== pin)
          throw Error("Native assignment review changed");
      };
      if (operation.kind === "review") return { status: 200, body: { review } };
      if (operation.epoch !== review.epoch)
        throw Error("Native assignment epoch changed");
      const id =
        operation.kind === "authorize"
          ? operation.binding.assignment.assignmentId
          : operation.input.assignmentId;
      const selected = review.assignments.find(
        (item) => item.assignmentId === id,
      );
      if (!selected) throw Error("Assignment outside native reviewed batch");
      if (operation.kind === "authorize") {
        if (digest(selected) !== digest(operation.binding.assignment))
          throw Error("Assignment revision changed");
        await options.authorize(review, operation.binding, signal);
        recheck();
        return { status: 200, body: { authorized: true } };
      }
      const result = await options.forward(operation.input, signal);
      const reader = result.body?.getReader();
      if (!reader) throw Error("Missing assignment gateway response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 128000)
            throw Error("Assignment gateway response too large");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      recheck();
      return response.parse({
        status: result.status,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
    },
  };
  const broker = new ProtectedLoopbackBroker(token, () => session, protocol);
  try {
    const endpoint = await broker.listen();
    return {
      environment: {
        BITTREES_ASSIGNMENT_HELPER_URL: endpoint,
        BITTREES_ASSIGNMENT_HELPER_TOKEN: token,
      },
      close: () => broker.close(),
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}
export function nativeAssignmentServiceClient(
  env: NodeJS.ProcessEnv = process.env,
): AssignmentServiceClient | undefined {
  const endpoint = env.BITTREES_ASSIGNMENT_HELPER_URL,
    token = env.BITTREES_ASSIGNMENT_HELPER_TOKEN;
  if (endpoint === undefined && token === undefined) return undefined;
  if (!endpoint || !token)
    throw Error("Incomplete native assignment capability");
  const client = new ProtectedLoopbackClient(endpoint, token, protocol);
  return {
    async execute(raw, signal) {
      const result = response.parse(await client.execute(raw, signal));
      return Response.json(result.body, { status: result.status });
    },
  };
}
