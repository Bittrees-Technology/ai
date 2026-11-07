import Database from "better-sqlite3";
import { z } from "zod";
import type { NativeTaskSyncClient } from "../task-sync/native-loopback.js";
import {
  createDirectoryResearchBridge,
  DirectoryResearchHold,
  directoryResearchRequest,
} from "./directory-research-bridge.js";

export const directoryResearchNativeOperation = z.strictObject({
  kind: z.literal("directory-research"),
  rpc: z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: z.uuid(),
    method: z.literal("tools/call"),
    params: z.strictObject({
      name: z.enum(["directory_research_review", "directory_research_run"]),
      arguments: directoryResearchRequest,
    }),
  }),
});

import type { DirectoryResearchCompletion } from "./directory-research-completion.js";

type Host = Parameters<typeof createDirectoryResearchBridge>[2];

/** Launcher-owned journal. Reservations are never cleared automatically, even
 * after an interrupted provider call or a manifest revision. */
export function openDirectoryResearchNative(
  path: string,
  manifests: readonly { json: string; digest: string }[],
  host: Omit<Host, "reserve">,
  completions: ReadonlyMap<string, DirectoryResearchCompletion> = new Map(),
) {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 2500");
    db.exec(`CREATE TABLE IF NOT EXISTS directory_research_reservations (
      run_id TEXT PRIMARY KEY NOT NULL, scope_digest TEXT NOT NULL
    )`);
    const insert = db.prepare(
      "INSERT INTO directory_research_reservations VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING",
    );
    const bridges = manifests.map(({ json, digest }) =>
      createDirectoryResearchBridge(json, digest, {
        ...host,
        async reserve(scope, signal) {
          signal.throwIfAborted();
          return (
            insert.run(scope.originalValidationRunId, scope.digest).changes ===
            1
          );
        },
      }),
    );

    const session: NativeTaskSyncClient = {
      async execute(raw, signal = AbortSignal.timeout(20_000)) {
        const { rpc } = directoryResearchNativeOperation.parse(raw);
        signal.throwIfAborted();
        const reply = (status: number, body: object) =>
          Response.json({ jsonrpc: "2.0", id: rpc.id, ...body }, { status });
        for (const bridge of bridges) {
          let review;
          try {
            review = bridge.review(rpc.params.arguments);
          } catch {
            continue;
          }
          if (rpc.params.name === "directory_research_review")
            return reply(200, { result: review });
          try {
            if (review.exhausted)
              throw new DirectoryResearchHold(
                "Directory research retry budget exhausted",
              );
            const completion = completions.get(review.scopeDigest);
            const result = completion?.pending()
              ? undefined
              : await bridge.research(rpc.params.arguments, signal);
            if (completion) {
              await bridge.recheckEvidence(rpc.params.arguments, signal);
              return reply(200, {
                result: await completion.run(result, signal),
              });
            }
            return reply(200, { result });
          } catch (error) {
            if (error instanceof DirectoryResearchHold)
              return reply(409, {
                error: { code: -32009, message: error.message },
              });
            return reply(503, {
              error: {
                code: -32003,
                message: "Directory research unavailable",
              },
            });
          }
        }
        return reply(403, {
          error: { code: -32004, message: "Directory research scope denied" },
        });
      },
    };
    return { session, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
