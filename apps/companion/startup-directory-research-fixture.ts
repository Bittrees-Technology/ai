import { z } from "zod";
import type { NativeTaskSyncClient } from "../../modules/task-sync/native-loopback.js";
import { directoryResearchNativeOperation } from "../../modules/research/directory-research-native.js";

const cases = z
  .array(
    z.strictObject({
      operation: directoryResearchNativeOperation,
      status: z.int(),
      message: z.string().optional(),
    }),
  )
  .min(1)
  .max(12);

export async function runStartupDirectoryResearchFixture(
  client: NativeTaskSyncClient,
  raw: unknown,
) {
  for (const { operation, status, message } of cases.parse(raw)) {
    const response = await client.execute(
      operation,
      AbortSignal.timeout(15_000),
    );
    const body = await response.json();
    if (
      response.status !== status ||
      body.jsonrpc !== "2.0" ||
      body.id !== operation.rpc.id ||
      (message && body.error?.message !== message)
    )
      throw Error(
        "Staged directory research transport returned an unexpected result",
      );
  }
}
