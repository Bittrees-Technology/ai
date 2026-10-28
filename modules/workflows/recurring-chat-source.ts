import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  prepareChatJournalPath,
  chatJournalApplicationId,
  chatJournalVersion,
} from "./chat-journal-path.js";
import { z } from "zod";
import {
  acerBindingSchema,
  acerFresh,
  acerStoredResultSchema,
  parseAcerAggregate,
  type AcerAggregateCheck,
  type AcerSourceBinding,
  type AcerSourceTransport,
  type AcerStoredResult,
} from "./chat-acer-aggregate.js";
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
const publicResultSchema = z.strictObject({
  available: z.boolean(),
  gateReady: z.boolean().optional(),
  releaseReady: z.boolean().optional(),
});
type Result = z.infer<typeof publicResultSchema> | AcerStoredResult;
function parseResult(check: string, value: unknown): Result {
  return check === "acer_aggregate"
    ? acerStoredResultSchema.parse(value)
    : publicResultSchema.parse(value);
}
export type ChatAuthorityCheck = ChatPublicCheck | AcerAggregateCheck;
export type ChatAuthorityContext = {
  workflowId: string;
  revision: string;
  operationId: string;
  check: ChatAuthorityCheck;
  phase: "read" | "dispatch" | "accept" | "aggregate";
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
    const guard =
      path === ":memory:" ? undefined : prepareChatJournalPath(path);
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: path !== ":memory:" });
      guard?.assertUnchanged();
      db.pragma("synchronous = FULL");
      db.pragma("busy_timeout = 1000");
      if (!guard || guard.created) {
        // Persist the identity/schema before WAL so crash recovery never depends on a
        // marker present only in a sidecar. No existing foreign file is initialized.
        db.exec(
          "CREATE TABLE chat_attempts(operation TEXT,revision TEXT,checkId TEXT,attempt INTEGER,state TEXT,at INTEGER,result TEXT,PRIMARY KEY(operation,checkId))",
        );
        db.pragma(`application_id = ${chatJournalApplicationId}`);
        db.pragma(`user_version = ${chatJournalVersion}`);
      } else {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[];
        const columns = db.pragma("table_info(chat_attempts)") as {
          name: string;
        }[];
        if (
          tables.length !== 1 ||
          tables[0]?.name !== "chat_attempts" ||
          columns.map((c) => c.name).join() !==
            "operation,revision,checkId,attempt,state,at,result"
        )
          throw Error("Foreign Chat journal schema");
      }
      guard?.assertUnchanged();
      db.pragma("journal_mode = WAL");
      this.db = db;
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      guard?.close();
    }
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
            ? parseResult(check, JSON.parse(row.result))
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
      (!chatPublicChecks.some((c) => c.id === check) &&
        check !== "acer_aggregate") ||
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
    const raw = JSON.stringify(parseResult(check, result));
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
): Promise<z.infer<typeof publicResultSchema>> {
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
  const work = async (): Promise<z.infer<typeof publicResultSchema>> => {
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
/** Bounded typed source call, never an ambient transport or command selector. */
async function observeAcer(
  check: AcerAggregateCheck,
  transport: AcerSourceTransport,
  parent: AbortSignal,
  bindingSha256: string,
  elapsed: () => number,
): Promise<AcerStoredResult> {
  const controller = new AbortController();
  let rejectAbort: (e: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(Error("aborted"));
  };
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("timeout"));
    }, check.timeoutMs);
  });
  const work = async (): Promise<AcerStoredResult> => {
    controller.signal.throwIfAborted();
    const response = await transport(check, controller.signal);
    controller.signal.throwIfAborted();
    const report = parseAcerAggregate(response.output, response.exitCode);
    return {
      kind: "acer",
      available: acerFresh(report, elapsed()),
      bindingSha256,
      report,
    };
  };
  try {
    return await Promise.race([work(), deadline, aborted]);
  } catch {
    return {
      kind: "acer",
      available: false,
      bindingSha256,
      failure: "source_unavailable",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    parent.removeEventListener("abort", abort);
  }
}
/** Registered by startup with default disabled configuration and no provisioned interfaces. */
export function createChatMonitorCollector(
  options: {
    enabled?: boolean;
    workflowId?: string;
    revision?: string;
    authority?: ChatAuthority;
    transport?: ChatSourceTransport;
    journal?: ChatJournal;
    now?: () => number;
    monotonic?: () => number;
    acer?: { binding?: AcerSourceBinding; transport?: AcerSourceTransport };
  } = {},
): LocalRecurringCollector {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  type Clock = {
    wall: number;
    mono: number;
    attempt: number;
    lastElapsed: number;
  };
  // Ephemeral clock continuity is never reconstructed from a wall timestamp.
  // A restart holds a settled private cache rather than replaying the occurrence.
  const clocks = new Map<string, Clock>();
  const elapsedFor = (
    clock: Clock | undefined,
    row?: { at: number; attempt: number },
  ) => {
    if (
      !clock ||
      (row && (row.at !== clock.wall || row.attempt !== clock.attempt))
    )
      return NaN;
    const wall = now() - clock.wall,
      mono = monotonic() - clock.mono;
    if (
      !Number.isSafeInteger(wall) ||
      wall < 0 ||
      !Number.isFinite(mono) ||
      mono < 0
    )
      return NaN;
    const elapsed = Math.ceil(Math.max(wall, mono));
    if (!Number.isSafeInteger(elapsed) || elapsed < clock.lastElapsed)
      return NaN;
    clock.lastElapsed = elapsed;
    return elapsed;
  };
  const receipt = (
    evidence: unknown,
    state: RecurringReceipt["state"] = "held",
  ): RecurringReceipt => ({
    state,
    objectiveComplete: false,
    evidence,
    fingerprint: digest(evidence),
    observedAt: now(),
  });
  return {
    workflowId: options.workflowId,
    capability: "local.chat.monitor.read",
    decide: (r) =>
      r.state === "confirmed"
        ? {
            decision: "wait",
            summary:
              "Read-only source aggregate healthy; monitoring activation is separate.",
          }
        : {
            decision: "escalate",
            summary:
              "Chat monitoring source evidence held; reconcile its exact source and authority.",
          },
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
      let acerCheck: AcerAggregateCheck | undefined;
      const acerOptions = options.acer,
        acerTransport = acerOptions?.transport;
      const binding = acerBindingSchema.safeParse(acerOptions?.binding);
      if (binding.success && acerTransport)
        acerCheck = Object.freeze({
          id: "acer_aggregate",
          binding: Object.freeze(binding.data),
          timeoutMs: 22000,
          maxBytes: 4096,
        });
      const selected: ChatAuthorityCheck[] = [
        ...chatPublicChecks,
        ...(acerCheck ? [acerCheck] : []),
      ];
      const operation = digest([workflowId, operationId]);
      const checks: {
        checkId: string;
        observedAt?: number;
        available: boolean;
        gateReady?: boolean;
        releaseReady?: boolean;
      }[] = [];
      let privateRow: ReturnType<ChatJournal["load"]>;
      const authorized = async (
        check: ChatAuthorityCheck,
        phase: ChatAuthorityContext["phase"],
      ) => {
        signal.throwIfAborted();
        const decision = await authority(
          Object.freeze({ workflowId, revision, operationId, check, phase }),
          signal,
        );
        signal.throwIfAborted();
        return decision === "authorized";
      };
      try {
        for (const check of selected) {
          // Keep the occurrence ID stable. Changing a private binding changes its
          // expected revision, so pending/old records hold rather than dispatch again.
          const expectedRevision =
            check.id === "acer_aggregate"
              ? digest([revision, check.binding])
              : revision;
          if (!(await authorized(check, "read")))
            return receipt({ reason: "authority_held", acer: "held" });
          let row = journal.load(operation, expectedRevision, check.id);
          if (row?.state === "pending")
            return receipt({ reason: "uncertain_attempt", acer: "held" });
          if (row?.result) parseResult(check.id, row.result);
          if (!row?.result?.available && !(row && row.attempt >= 2)) {
            const startedAt = now(),
              clockKey = digest([operation, expectedRevision]);
            if (
              check.id === "acer_aggregate" &&
              !clocks.has(clockKey) &&
              clocks.size >= 10000
            )
              throw Error("Clock evidence capacity held");
            const clock: Clock = {
              wall: startedAt,
              mono: monotonic(),
              attempt: (row?.attempt ?? 0) + 1,
              lastElapsed: 0,
            };
            journal.reserve(operation, expectedRevision, check.id, startedAt);
            if (check.id === "acer_aggregate") clocks.set(clockKey, clock);
            if (!(await authorized(check, "dispatch")))
              return receipt({ reason: "authority_held", acer: "held" });
            const result =
              check.id === "acer_aggregate"
                ? await observeAcer(
                    check,
                    acerTransport!,
                    signal,
                    digest(check.binding),
                    () => elapsedFor(clock),
                  )
                : await observe(check, transport, signal);
            if (!(await authorized(check, "accept")))
              return receipt({ reason: "authority_held", acer: "held" });
            journal.settle(operation, expectedRevision, check.id, result);
            row = journal.load(operation, expectedRevision, check.id);
          }
          if (check.id === "acer_aggregate") privateRow = row;
          else {
            const result = publicResultSchema.parse(row?.result);
            checks.push({ checkId: check.id, observedAt: row?.at, ...result });
          }
        }
        // Recheck every scope before final aggregate completion or cached delivery.
        for (const check of selected)
          if (!(await authorized(check, "aggregate")))
            return receipt({ reason: "authority_held", acer: "held" });
        let acer: unknown = "unresolved",
          acerAvailable = false;
        if (acerCheck) {
          const result = acerStoredResultSchema.parse(privateRow?.result);
          if (result.bindingSha256 !== digest(acerCheck.binding))
            return receipt({ reason: "acer_binding_held", acer: "held" });
          const elapsed = elapsedFor(
            clocks.get(
              digest([operation, digest([revision, acerCheck.binding])]),
            ),
            privateRow,
          );
          acerAvailable =
            result.available &&
            !!result.report &&
            acerFresh(result.report, elapsed);
          acer = {
            available: acerAvailable,
            status: acerAvailable
              ? "healthy"
              : result.report?.status === "healthy"
                ? "degraded"
                : (result.report?.status ?? "unavailable"),
            observedAt: privateRow?.at,
            elapsedMs:
              Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null,
            freshness: acerAvailable
              ? "fresh"
              : result.report?.status === "healthy"
                ? "held"
                : "not_healthy",
            report: result.report,
          };
        }
        const publicAvailabilityPassed = checks.every((c) => c.available);
        const aggregateHealthy = publicAvailabilityPassed && acerAvailable;
        return receipt(
          {
            checks,
            publicAvailabilityPassed,
            acer,
            aggregateHealthy,
            monitoringAccepted: false,
          },
          aggregateHealthy ? "confirmed" : "held",
        );
      } catch {
        return receipt({ reason: "source_or_journal_held", acer: "held" });
      }
    },
  };
}
