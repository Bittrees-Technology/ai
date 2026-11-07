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
import {
  assignmentValidatorSchema,
  assignmentValidationInput,
  checkAssignmentValidation,
} from "./assignment-contract.js";

export const assignmentServiceReview = z
  .strictObject({
    version: z.literal(1),
    epoch: z.uuid(),
    approvedAt: z.int(),
    expiresAt: z.int(),
    profileId: z.string().min(1).max(128),
    modelDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    validator: assignmentValidatorSchema.optional(),
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
    "validate",
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
    kind: z.literal("validate"),
    epoch: z.uuid(),
    input: assignmentValidationInput,
  }),
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
  validate?: (
    review: z.infer<typeof assignmentServiceReview>,
    input: z.infer<typeof assignmentValidationInput>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  forward: (
    input: z.infer<typeof assignmentGatewayOperation>,
    signal: AbortSignal,
  ) => Promise<Response>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const token = randomBytes(32).toString("hex");
  const validations = new Map<
    string,
    {
      scope: string;
      input: z.infer<typeof assignmentValidationInput>;
      receipt: ReturnType<typeof checkAssignmentValidation>;
    }
  >();
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
          : operation.kind === "validate"
            ? operation.input.assignment.assignmentId
            : operation.input.assignmentId;
      const selected = review.assignments.find(
        (item) => item.assignmentId === id,
      );
      if (!selected) throw Error("Assignment outside native reviewed batch");
      if (operation.kind === "validate") {
        if (
          !review.validator ||
          !options.validate ||
          digest(selected) !== digest(operation.input.assignment)
        )
          throw Error(
            "Independent assignment validator unavailable or scope changed",
          );
        const prior = validations.get(id);
        if (
          prior &&
          prior.input.crmOperationId !== operation.input.crmOperationId
        )
          throw Error("Assignment result operation cannot be replaced");
        await options.authorize(
          review,
          {
            assignment: operation.input.assignment,
            claim: operation.input.claim,
            action: "validate",
            inputDigest: operation.input.inputDigest,
          },
          signal,
        );
        recheck();
        const receipt = checkAssignmentValidation(
          await options.validate(
            review,
            structuredClone(operation.input),
            signal,
          ),
          operation.input,
          review.validator,
          now(),
        );
        recheck();
        if (receipt.expiresAt > review.expiresAt)
          throw Error("Assignment validation exceeds native review");
        validations.set(id, { scope: pin, input: operation.input, receipt });
        return { status: 200, body: { validation: receipt } };
      }
      if (operation.kind === "authorize") {
        if (digest(selected) !== digest(operation.binding.assignment))
          throw Error("Assignment revision changed");
        await options.authorize(review, operation.binding, signal);
        recheck();
        return { status: 200, body: { authorized: true } };
      }
      if (
        ["intake", "claim", "write", "complete"].includes(
          operation.input.kind,
        ) &&
        (!review.validator || !options.validate)
      )
        throw Error(
          "Independent assignment validator must be configured before work",
        );
      if (
        operation.input.kind === "write" ||
        operation.input.kind === "complete"
      ) {
        const accepted = validations.get(id),
          op = operation.input;
        const resultDigest =
          op.kind === "write" ? digest(op.result) : op.resultDigest;
        if (
          !accepted ||
          accepted.scope !== pin ||
          accepted.receipt.expiresAt <= now() ||
          accepted.input.crmOperationId !== op.crmOperationId ||
          accepted.input.resultDigest !== resultDigest ||
          accepted.input.claim.runId !== op.runId ||
          accepted.input.claim.leaseId !== op.leaseId ||
          (op.kind === "complete" &&
            op.expiresAt !== accepted.input.claim.expiresAt)
        )
          throw Error(
            "Current independently validated result required before effects",
          );
        await options.authorize(
          review,
          {
            assignment: selected,
            claim: accepted.input.claim,
            action: op.kind === "write" ? "write" : "complete",
            inputDigest: accepted.input.inputDigest,
          },
          signal,
        );
        recheck();
        if (accepted.receipt.expiresAt <= now())
          throw Error(
            "Independent assignment validation expired before effect",
          );
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
