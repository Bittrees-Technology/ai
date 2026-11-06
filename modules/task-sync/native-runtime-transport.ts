import { z } from "zod";
import {
  activeLease,
  digest,
  requestSchema,
  type SyncIdentity,
  type SyncTask,
} from "./proof-contract.js";
import { exchangeActivation, type ActivationScope } from "./activation.js";
import {
  activationReceiptSchema,
  runtimeHandoffSchema,
  runtimeEnrollmentSchema,
  leaseActivationSchema,
} from "./runtime-contract.js";
import {
  TaskSyncBudgetHeld,
  TaskSyncRunBudget,
  type TaskSyncRequestKind,
} from "./run-budget.js";

const signature = z.string().min(1).max(200);
const signed = <T extends z.ZodType>(request: T) =>
  z.strictObject({ request, signature });
const poll = { id: z.uuid(), pollSecret: z.string().regex(/^[a-f0-9]{64}$/) };
const json = z.record(z.string(), z.unknown());
const proof = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16384)
  .optional();
const operation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source") }),
  z.strictObject({
    kind: z.literal("connect"),
    body: z.strictObject({
      leaseReceipt: z.strictObject({
        receipt: activationReceiptSchema,
        signature,
      }),
    }),
  }),
  z.strictObject({ kind: z.literal("preview"), id: z.uuid(), proof }),
  z.strictObject({
    kind: z.literal("execute"),
    id: z.uuid(),
    sourceId: z.string().min(1).max(200),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    proof,
  }),
  z.strictObject({
    kind: z.literal("owner-start"),
    body: signed(runtimeHandoffSchema),
  }),
  z.strictObject({ kind: z.literal("owner-poll"), body: z.strictObject(poll) }),
  z.strictObject({
    kind: z.literal("owner-complete"),
    body: z.strictObject({
      ...poll,
      proof: z.strictObject({
        request: z.union([runtimeEnrollmentSchema, leaseActivationSchema]),
        signature,
        attestation: json,
      }),
    }),
  }),
  z.strictObject({
    kind: z.literal("attestation"),
    body: z.discriminatedUnion("purpose", [
      z.strictObject({
        purpose: z.literal("enroll"),
        ...signed(runtimeEnrollmentSchema).shape,
      }),
      z.strictObject({
        purpose: z.literal("activate"),
        ...signed(leaseActivationSchema).shape,
      }),
      z.strictObject({
        purpose: z.literal("decision"),
        ...signed(requestSchema).shape,
      }),
    ]),
  }),
]);
const scopeSchema = z.strictObject({
  version: z.literal(1),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  credentialId: z.string().regex(/^[a-f0-9]{64}$/),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  sourceWorkspace: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  projects: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .max(128),
    )
    .min(1)
    .max(100),
  tasks: z
    .array(
      z.strictObject({
        sourceId: z.string().min(1).max(200),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(1000),
});
export type TaskSyncNativeScope = z.infer<typeof scopeSchema>;
export type TaskSyncNativeOperation = z.infer<typeof operation>;

/** Candidate adapter, deliberately absent from native startup. No default scope,
 * credentials, authority verifier, fetch, grants, registration or key creation.
 * The synchronous verifier must perform no I/O. The trusted native owner must
 * verify current source/Roles authority for this
 * exact digest, not accept approval or credentials from the core/model input.
 * TLS/DNS and the native IPC listener remain a separate reviewed host boundary.
 */
export function taskSyncNativeTransport(options: {
  enabled: boolean;
  current: () => TaskSyncNativeScope | null;
  budget: TaskSyncRunBudget;
  authorize: (
    binding: {
      scope: TaskSyncNativeScope;
      kind: TaskSyncNativeOperation["kind"];
      requestDigest: string;
    },
    signal: AbortSignal,
  ) => void;
  credential: (kind: "gateway" | "coordinator") => string;
  request: typeof fetch;
  connection?: {
    expected: ActivationScope;
    rolesPublicKey: string;
    challengeTask: SyncTask;
    signAndAttest: Parameters<typeof exchangeActivation>[4];
  };
}) {
  if (!options.enabled) return null;
  const scope = scopeSchema.parse(options.current()),
    pinned = digest(scope);
  if (
    new Set(scope.projects).size !== scope.projects.length ||
    scope.projects.includes("crm") ||
    new Set(scope.tasks.map((t) => t.sourceId)).size !== scope.tasks.length
  )
    throw new TaskSyncBudgetHeld("Duplicate or invalid native task scope");
  const current = () => {
    if (digest(scopeSchema.parse(options.current())) !== pinned)
      throw new TaskSyncBudgetHeld("Native task scope changed or revoked");
    options.budget.assertCurrent(scope.scopeDigest);
  };
  const connection = options.connection;
  const expected = connection && structuredClone(connection.expected);
  const challengeTask = connection && structuredClone(connection.challengeTask);
  if (expected && challengeTask) {
    if (
      expected.principal !== scope.principal ||
      expected.credentialId !== scope.credentialId ||
      expected.tenant !== scope.tenant ||
      expected.workspace !== scope.workspace ||
      expected.sourceWorkspace !== scope.sourceWorkspace ||
      digest([...expected.projectIds].sort()) !==
        digest(["crm", ...scope.projects].sort()) ||
      digest(challengeTask.content) !== challengeTask.fingerprint ||
      !scope.tasks.some(
        (task) =>
          task.sourceId === challengeTask.content.sourceId &&
          task.fingerprint === challengeTask.fingerprint,
      ) ||
      challengeTask.destination.workspaceId !== scope.sourceWorkspace
    )
      throw new TaskSyncBudgetHeld("Native activation scope mismatch");
  }
  let connectionAttempted = false;
  let gateway: { identity: SyncIdentity; token: string } | undefined;

  return {
    async execute(raw: unknown, parent?: AbortSignal) {
      current();
      const op = operation.parse(raw);
      let url: string,
        body: unknown,
        kind: TaskSyncRequestKind,
        credential: "gateway" | "coordinator" | undefined;
      if (op.kind === "source") {
        url = "https://agent.bittrees.org/tasks.json";
        kind = "source";
      } else if (op.kind === "connect") {
        if (!connection || !expected || !challengeTask)
          throw new TaskSyncBudgetHeld(
            "Native connection credential custody is not wired",
          );
        if (connectionAttempted)
          throw new TaskSyncBudgetHeld(
            "Native connection was already attempted",
          );
        const signal = options.budget.signal(scope.scopeDigest, parent);
        signal.throwIfAborted();
        connectionAttempted = true;
        try {
          const bounded = options.budget.fetch(
            options.request,
            () => {
              current();
              return scope.scopeDigest;
            },
            () => "connect",
          );
          gateway = await exchangeActivation(
            op.body.leaseReceipt,
            expected,
            connection.rolesPublicKey,
            challengeTask,
            async (challenge, identity, activationSignal) => {
              current();
              const signingSignal = AbortSignal.any([signal, activationSignal]);
              signingSignal.throwIfAborted();
              const proof = await connection.signAndAttest(
                challenge,
                identity,
                signingSignal,
              );
              signingSignal.throwIfAborted();
              current();
              return proof;
            },
            async (input, init) => {
              current();
              const wireSignal = init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal;
              wireSignal.throwIfAborted();
              options.authorize(
                {
                  scope: structuredClone(scope),
                  kind: "connect",
                  requestDigest: digest({
                    scopeDigest: scope.scopeDigest,
                    url: input,
                    body: init?.body,
                  }),
                },
                wireSignal,
              );
              wireSignal.throwIfAborted();
              return bounded(input, { ...init, signal: wireSignal });
            },
          );
          signal.throwIfAborted();
          current();
          return Response.json({ identity: gateway.identity });
        } catch {
          gateway = undefined;
          throw new TaskSyncBudgetHeld("Native connection held");
        }
      } else if (op.kind === "execute" || op.kind === "preview") {
        if (
          op.kind === "execute" &&
          !scope.tasks.some(
            (t) =>
              t.sourceId === op.sourceId &&
              t.fingerprint === op.expectedFingerprint,
          )
        )
          throw new TaskSyncBudgetHeld("Unreviewed native task");
        url =
          "https://mcp.bittrees.org/mcp?" +
          new URLSearchParams({
            mode: "selected",
            projects: ["crm", ...scope.projects].join(","),
          });
        body = {
          jsonrpc: "2.0",
          id: op.id,
          method: "tools/call",
          params: {
            name: "task_sync_" + op.kind,
            arguments:
              op.kind === "execute"
                ? {
                    sourceId: op.sourceId,
                    expectedFingerprint: op.expectedFingerprint,
                    confirmed: true,
                  }
                : {},
          },
        };
        kind = op.kind;
        credential = "gateway";
      } else if (op.kind === "attestation") {
        if (
          op.body.request.principal !== scope.principal ||
          ("credentialId" in op.body.request &&
            op.body.request.credentialId !== scope.credentialId)
        )
          throw new TaskSyncBudgetHeld("Attestation identity mismatch");
        url = "https://ai.bittrees.org/api/workflows";
        body = { action: "runtime-attestation", input: op.body };
        kind = "attestation";
        credential = "coordinator";
      } else {
        if (
          op.kind === "owner-start" &&
          (op.body.request.principal !== scope.principal ||
            op.body.request.sourceWorkspace !== scope.sourceWorkspace)
        )
          throw new TaskSyncBudgetHeld("Owner review scope mismatch");
        url = "https://roles.bittrees.org/api/mcp/runtime/" + op.kind.slice(6);
        body = op.body;
        kind = "owner";
      }
      const init: RequestInit = {
        method: op.kind === "source" ? "GET" : "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      // Includes ephemeral proof bytes. The verifier must validate their signatures,
      // exact operation/lease/task binding and freshness, not merely this hash.
      const requestDigest = digest({
        scopeDigest: scope.scopeDigest,
        op,
        url,
        body: body ?? null,
      });
      const signal = options.budget.signal(scope.scopeDigest, parent);
      signal.throwIfAborted();
      options.authorize(
        { scope: structuredClone(scope), kind: op.kind, requestDigest },
        signal,
      );
      signal.throwIfAborted();
      current();
      const headers = new Headers(init.headers);
      if (credential) {
        let token: string;
        if (credential === "gateway" && connection) {
          if (!gateway)
            throw new TaskSyncBudgetHeld(
              "Native gateway connection unavailable",
            );
          activeLease(gateway.identity);
          token = gateway.token;
        } else {
          token = options.credential(credential);
        }
        if (!/^\S{16,4096}$/.test(token))
          throw new TaskSyncBudgetHeld("Native credential unavailable");
        headers.set("Authorization", "Bearer " + token);
      }
      if ((op.kind === "execute" || op.kind === "preview") && op.proof)
        headers.set("x-bittrees-agent-proof", op.proof);
      const response = await options.budget.fetch(
        options.request,
        () => {
          current();
          return scope.scopeDigest;
        },
        () => kind,
      )(url, { ...init, headers, signal });
      current();
      return response;
    },
  };
}
