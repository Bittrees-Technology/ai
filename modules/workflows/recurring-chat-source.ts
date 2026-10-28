import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { z } from "zod";
import type { LocalRecurringCollector } from "./recurring-host.js";
import type { RecurringReceipt } from "./recurring.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const chatPublicChecks = Object.freeze([
  Object.freeze({
    id: "chat_public",
    url: "https://chat.bittrees.org/api/health",
    method: "GET",
    redirect: "error",
    credentials: "omit",
    timeoutMs: 15000,
    maxBytes: 16384,
  } as const),
  Object.freeze({
    id: "mail_public",
    url: "https://mail.bittrees.org/",
    method: "GET",
    redirect: "error",
    credentials: "omit",
    timeoutMs: 15000,
    maxBytes: 0,
  } as const),
]);
export type ChatPublicCheck = (typeof chatPublicChecks)[number];
const resultSchema = z.strictObject({
  available: z.boolean(),
  gateReady: z.boolean().optional(),
  releaseReady: z.boolean().optional(),
});
type Result = z.infer<typeof resultSchema>;
export type ChatAuthorityContext = {
  workflowId: string;
  revision: string;
  operationId: string;
  check: ChatPublicCheck;
};
/** Implementations must validate current Roles/source bindings and enforced zero-cost scope for THIS context. */
export type ChatAuthority = (
  context: ChatAuthorityContext,
  signal: AbortSignal,
) => Promise<"authorized" | "unresolved" | "revoked">;
/** Operator-reviewed transport owns DNS/IP pinning, TLS and egress. No ambient fetch fallback. */
export type ChatSourceTransport = (
  check: ChatPublicCheck,
  signal: AbortSignal,
) => Promise<Response>;
export interface ChatJournal {
  load(
    operation: string,
    revision: string,
    check: string,
  ):
    | { attempt: number; state: string; at: number; result: Result | null }
    | undefined;
  reserve(
    operation: string,
    revision: string,
    check: string,
    now: number,
  ): void;
  settle(
    operation: string,
    revision: string,
    check: string,
    result: Result,
  ): void;
}
/** Metadata only, bounded and crash-durable. Pending outcomes are held, never blindly replayed. */
export class ChatOperationJournal implements ChatJournal {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw Error("Invalid journal path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 1000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS chat_attempts(operation TEXT,revision TEXT,checkId TEXT,attempt INTEGER,state TEXT,at INTEGER,result TEXT,PRIMARY KEY(operation,checkId))",
    );
  }
  load(operation: string, revision: string, check: string) {
    const row = this.db
      .prepare(
        "SELECT revision,attempt,state,at,result FROM chat_attempts WHERE operation=? AND checkId=?",
      )
      .get(operation, check) as
      | {
          revision: string;
          attempt: number;
          state: string;
          at: number;
          result: string | null;
        }
      | undefined;
    if (row && row.revision !== revision)
      throw Error("Operation revision changed");
    return row
      ? {
          ...row,
          result: row.result
            ? resultSchema.parse(JSON.parse(row.result))
            : null,
        }
      : undefined;
  }
  reserve(operation: string, revision: string, check: string, now: number) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(operation);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(revision);
    if (
      !chatPublicChecks.some((c) => c.id === check) ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw Error("Invalid check/time");
    this.db
      .transaction(() => {
        const row = this.load(operation, revision, check);
        if (
          row &&
          (row.state !== "settled" ||
            row.result?.available ||
            row.attempt >= 2 ||
            now - row.at < 30000)
        )
          throw Error("Reconcile or wait; no replay");
        if (
          !row &&
          (
            this.db.prepare("SELECT COUNT(*) n FROM chat_attempts").get() as {
              n: number;
            }
          ).n >= 10000
        )
          throw Error("Journal full; review retention");
        this.db
          .prepare(
            "INSERT INTO chat_attempts VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(operation,checkId) DO UPDATE SET attempt=excluded.attempt,state='pending',at=excluded.at,result=NULL",
          )
          .run(
            operation,
            revision,
            check,
            (row?.attempt ?? 0) + 1,
            "pending",
            now,
          );
      })
      .immediate();
  }
  settle(operation: string, revision: string, check: string, result: Result) {
    const raw = JSON.stringify(resultSchema.parse(result));
    if (
      this.db
        .prepare(
          "UPDATE chat_attempts SET state='settled',result=? WHERE operation=? AND revision=? AND checkId=? AND state='pending'",
        )
        .run(raw, operation, revision, check).changes !== 1
    )
      throw Error("Operation changed");
  }
  close() {
    this.db.close();
  }
}
async function observe(
  check: ChatPublicCheck,
  transport: ChatSourceTransport,
  parent: AbortSignal,
): Promise<Result> {
  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(Error("aborted"));
  };
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  let response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("timeout"));
    }, check.timeoutMs);
  });
  const work = async (): Promise<Result> => {
    controller.signal.throwIfAborted();
    response = await transport(check, controller.signal);
    controller.signal.throwIfAborted();
    if (response.status !== 200 || response.redirected)
      return { available: false };
    if (check.id === "mail_public") return { available: true };
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      return { available: false };
    reader = response.body?.getReader();
    if (!reader) return { available: false };
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      bytes += value.length;
      if (bytes > check.maxBytes) return { available: false };
      chunks.push(value);
    }
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const r = data?.readiness;
    if (
      r?.syncReady !== true ||
      typeof r.gateReady !== "boolean" ||
      typeof r.releaseReady !== "boolean"
    )
      return { available: false };
    return {
      available: true,
      gateReady: r.gateReady,
      releaseReady: r.releaseReady,
    };
  };
  try {
    return await Promise.race([work(), deadline, aborted]);
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
    controller.abort();
    parent.removeEventListener("abort", abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}
/** Optional collector for the existing localRecurringHost map. Not registered by production startup. */
export function createChatMonitorCollector(
  options: {
    enabled?: boolean;
    workflowId?: string;
    revision?: string;
    authority?: ChatAuthority;
    transport?: ChatSourceTransport;
    journal?: ChatJournal;
    now?: () => number;
  } = {},
): LocalRecurringCollector {
  const receipt = (evidence: unknown): RecurringReceipt => ({
    state: "held",
    objectiveComplete: false,
    evidence,
    fingerprint: digest(evidence),
    observedAt: (options.now ?? Date.now)(),
  });
  return {
    workflowId: options.workflowId,
    capability: "local.chat.monitor.read",
    decide: () => ({
      decision: "escalate",
      summary:
        "Chat monitoring acceptance held: separate Acer scope unresolved.",
    }),
    read: async (signal, operationId) => {
      signal.throwIfAborted();
      if (!options.enabled)
        return receipt({ reason: "disabled", acer: "unresolved" });
      const { workflowId, revision, authority, transport, journal } = options;
      if (
        !workflowId ||
        !revision ||
        !/^[a-f0-9]{64}$/.test(revision) ||
        !authority ||
        !transport ||
        !journal
      )
        return receipt({ reason: "unresolved_binding", acer: "unresolved" });
      if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(operationId))
        return receipt({ reason: "invalid_operation", acer: "unresolved" });
      const operation = digest([workflowId, operationId]),
        checks = [];
      for (const check of chatPublicChecks) {
        const context = { workflowId, revision, operationId, check };
        const authorized = async () => {
          signal.throwIfAborted();
          return (await authority(context, signal)) === "authorized";
        };
        try {
          if (!(await authorized()))
            return receipt({ reason: "authority_held", acer: "unresolved" });
          let row = journal.load(operation, revision, check.id);
          if (row?.state === "pending")
            return receipt({ reason: "uncertain_attempt", acer: "unresolved" });
          if (!row?.result?.available && !(row && row.attempt >= 2)) {
            journal.reserve(
              operation,
              revision,
              check.id,
              (options.now ?? Date.now)(),
            );
            // Authorization can change during durable reservation; leave pending for reconciliation on denial.
            if (!(await authorized()))
              return receipt({ reason: "authority_held", acer: "unresolved" });
            const result = await observe(check, transport, signal);
            if (!(await authorized()))
              return receipt({ reason: "authority_held", acer: "unresolved" });
            journal.settle(operation, revision, check.id, result);
            row = journal.load(operation, revision, check.id);
          }
          checks.push({
            checkId: check.id,
            observedAt: row?.at,
            ...row?.result,
          });
        } catch {
          return receipt({
            reason: "source_or_journal_held",
            acer: "unresolved",
          });
        }
      }
      return receipt({
        checks,
        publicAvailabilityPassed: checks.every((c) => c.available === true),
        acer: "unresolved",
        monitoringAccepted: false,
      });
    },
  };
}
