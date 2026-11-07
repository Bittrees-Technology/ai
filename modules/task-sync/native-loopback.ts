import { z } from "zod";
import { randomBytes } from "node:crypto";
import { ProtectedLoopbackBroker } from "./enrollment-broker.js";
import { ProtectedLoopbackClient } from "./enrollment-client.js";
import { taskSyncNativeOperation } from "./native-runtime-transport.js";
import { taskSyncIdentitySchema } from "./proof-contract.js";

import { assignmentGatewayOperation } from "./assignment-native.js";

import { directoryResearchNativeOperation } from "../research/directory-research-native.js";

const assignmentOperation = z.strictObject({
  kind: z.literal("assignment"),
  input: assignmentGatewayOperation,
});

function parseOperation(raw: unknown) {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    raw.kind === "directory-research"
  )
    return directoryResearchNativeOperation.parse(raw);
  if (
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    raw.kind === "assignment"
  )
    return assignmentOperation.parse(raw);
  const op = taskSyncNativeOperation.parse(raw);
  if (
    op.kind !== "source" &&
    op.kind !== "connect" &&
    op.kind !== "preview" &&
    op.kind !== "execute"
  )
    throw Error("Operation unavailable through task-sync broker");
  return op;
}
const responseSchema = z.strictObject({
  status: z.int().min(200).max(599),
  body: z.record(z.string(), z.unknown()),
});
const protocol = {
  path: "/task-sync",
  parse: parseOperation,
  maxRequest: 24000,
  maxResponse: 2_010_000,
  deadline: 22000,
};
export type NativeTaskSyncClient = {
  execute(raw: unknown, signal?: AbortSignal): Promise<Response>;
};

/** Trusted launcher supplies an already-reviewed host session. This socket
 * never creates a session or accepts owner authority or credentials. */
export class TaskSyncBroker extends ProtectedLoopbackBroker<
  ReturnType<typeof parseOperation>
> {
  constructor(token: string, current: () => NativeTaskSyncClient | null) {
    let wrapped: {
      execute: (
        op: ReturnType<typeof parseOperation>,
        signal: AbortSignal,
      ) => Promise<unknown>;
    } | null = null;
    let active: NativeTaskSyncClient | null = null;
    super(
      token,
      () => {
        const session = current();
        if (!session) {
          active = wrapped = null;
          return null;
        }
        if (active !== session) {
          active = session;
          wrapped = {
            async execute(op, signal) {
              const result = await session.execute(op, signal);
              const reader = result.body?.getReader();
              if (!reader) throw Error("Missing task sync response");
              const chunks: Uint8Array[] = [];
              let size = 0;
              const limit = op.kind === "source" ? 2_000_000 : 256000;
              try {
                for (;;) {
                  signal.throwIfAborted();
                  const next = await reader.read();
                  if (next.done) break;
                  size += next.value.length;
                  if (size > limit) throw Error("Task sync response too large");
                  chunks.push(next.value);
                }
              } finally {
                await reader.cancel();
              }
              const body = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks),
                ),
              );
              return responseSchema.parse({
                status: result.status,
                body:
                  op.kind === "connect"
                    ? z
                        .strictObject({
                          identity: taskSyncIdentitySchema.strict(),
                        })
                        .parse(body)
                    : body,
              });
            },
          };
        }
        return wrapped;
      },
      protocol,
    );
  }
}

/** The native owner supplies a current reviewed session. Construction is local
 * only and the returned capability is for the sandboxed companion. */
export async function launchTaskSyncBroker(
  current: () => NativeTaskSyncClient | null,
) {
  const token = randomBytes(32).toString("hex");
  const broker = new TaskSyncBroker(token, current);
  try {
    const endpoint = await broker.listen();
    return {
      environment: {
        BITTREES_TASK_SYNC_HELPER_URL: endpoint,
        BITTREES_TASK_SYNC_HELPER_TOKEN: token,
      },
      close: () => broker.close(),
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}

export function nativeTaskSyncClient(
  environment: NodeJS.ProcessEnv = process.env,
): NativeTaskSyncClient | undefined {
  const endpoint = environment.BITTREES_TASK_SYNC_HELPER_URL;
  const token = environment.BITTREES_TASK_SYNC_HELPER_TOKEN;
  if (endpoint === undefined && token === undefined) return undefined;
  if (!endpoint || !token)
    throw Error("Incomplete native task sync capability");
  const client = new ProtectedLoopbackClient(endpoint, token, protocol);
  return {
    async execute(raw, signal = new AbortController().signal) {
      const { status, body } = responseSchema.parse(
        await client.execute(raw, signal),
      );
      return Response.json(body, { status });
    },
  };
}
