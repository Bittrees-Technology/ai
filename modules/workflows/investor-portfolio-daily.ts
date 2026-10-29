import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { preparePortfolioJournalPath } from "./chat-journal-path.js";
import { canonical } from "../contracts/canonical-json.js";
import { sourceURL } from "../research/public-pages.js";
import type { RecurringReceipt } from "./recurring.js";

export const portfolioProfiles = Object.freeze(
  Array.from({ length: 8 }, (_, i) => `investor-portfolio-0${i + 1}`),
);
const hash = (v: unknown) =>
  createHash("sha256")
    .update(canonical(JSON.parse(JSON.stringify(v))))
    .digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema = z.strictObject({
  identity: z.string().min(1).max(250),
  aliases: z.array(z.string().min(1).max(160)).max(20),
  name: z.string().min(1).max(160),
  kind: z.enum(["people", "organizations"]),
  profile: z.enum(portfolioProfiles as [string, ...string[]]),
  datasetId: z.uuid(),
  urls: z.array(z.url().max(2000)).min(1).max(4),
});
type Candidate = z.infer<typeof candidateSchema>;
const pageSchema = z.strictObject({
  url: z.url(),
  text: z.string().min(1).max(24000),
  retrievedAt: z.number().int().safe(),
  sha256: digest,
  robotsAllowed: z.literal(true),
});
export type PortfolioPage = z.infer<typeof pageSchema>;
const factSchema = z.strictObject({
  field: z.enum([
    "status",
    "role",
    "business-email",
    "professional-linkedin",
    "professional-x",
    "official-telegram",
    "founder-pitch",
    "lp-relations",
    "press",
    "general-route",
    "stage",
    "geography",
    "instrument",
    "initial-cheque",
    "follow-on-cheque",
    "fund-size",
    "financing-round",
    "lp-minimum",
    "unknown",
    "conflict",
    "closed-programme",
  ]),
  value: z.string().min(1).max(300),
  quote: z.string().min(10).max(1200),
  sourceUrl: z.url(),
});
const proposalSchema = z.strictObject({
  facts: z.array(factSchema).min(1).max(20),
  modelDigest: digest,
  inputDigest: digest,
  modelProfileId: z.uuid(),
});
const snapshotSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    entries: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.string(),
            name: z.string(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .max(10000),
    crm: z.array(z.unknown()).length(0),
    links: z.array(z.unknown()).length(0),
  })
  .passthrough();
type Snapshot = z.infer<typeof snapshotSchema>;
/** This interface deliberately exposes no project, task, sharing or publication method. */
export type PortfolioDataset = {
  read: () => Promise<unknown>;
  append: (
    args: { version: number; entries: Record<string, unknown>[] },
    expectedDatasetId: string,
  ) => Promise<unknown>;
  patch: (args: {
    version: number;
    name: string;
    changes: Record<string, unknown>[];
    removeIds: [];
  }) => Promise<unknown>;
};
type State = {
  revision: number;
  binding: string;
  cursor: number;
  phase: "idle" | "collecting" | "draft" | "pending" | "confirmed" | "held";
  collectOperation?: string;
  actionOperation?: string;
  candidate?: Candidate;
  entry?: Record<string, unknown>;
  expectedEntryHash?: string;
  targetId?: string;
  targetProfile?: string;
  targetDataset?: string;
  previousDescription?: string;
  targetExisted?: boolean;
  draftAt?: number;
  modelEvidence?: unknown;
  reason?: string;
  sourceReceipt?: unknown;
};
/** Encrypted, WAL/FULL state with atomic CAS. Caller supplies an operator-owned private path. */
export class PortfolioDailyJournal {
  private db: Database.Database;
  constructor(
    path: string,
    private vault: Vault,
  ) {
    const guard =
      path === ":memory:" ? undefined : preparePortfolioJournalPath(path);
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: path !== ":memory:" });
      guard?.assertUnchanged();
      if (!guard || guard.created) {
        db.exec(
          "CREATE TABLE portfolio_daily(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,value BLOB NOT NULL); CREATE TABLE portfolio_operations(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
        );
        db.pragma("application_id=1112820048");
        db.pragma("user_version=1");
      } else {
        if (
          db.pragma("application_id", { simple: true }) !== 1112820048 ||
          db.pragma("user_version", { simple: true }) !== 1
        )
          throw Error("Foreign portfolio journal");
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[];
        const columns = db.pragma("table_info(portfolio_daily)") as {
          name: string;
        }[];
        if (
          tables
            .map((t) => t.name)
            .sort()
            .join() !== "portfolio_daily,portfolio_operations" ||
          columns.map((c) => c.name).join() !== "id,revision,value" ||
          (db.pragma("table_info(portfolio_operations)") as { name: string }[])
            .map((c) => c.name)
            .join() !== "id,value"
        )
          throw Error("Foreign portfolio journal schema");
      }
      db.pragma("journal_mode=WAL");
      db.pragma("synchronous=FULL");
      guard?.assertUnchanged();
      this.db = db;
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      guard?.close();
    }
  }
  load(): State | undefined {
    const row = this.db
      .prepare("SELECT value FROM portfolio_daily WHERE id=1")
      .get() as { value: Buffer } | undefined;
    return row
      ? this.vault.open<State>(row.value, "investor-portfolio-daily:v1")
      : undefined;
  }
  seen(kind: "collect" | "action", id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM portfolio_operations WHERE id=?")
      .get(hash([kind, id]));
  }
  save(previous: State | undefined, next: State) {
    return this.db
      .transaction(() => {
        const revision = (previous?.revision ?? 0) + 1,
          state = { ...next, revision };
        const value = this.vault.seal(state, "investor-portfolio-daily:v1");
        if (value.length > 256000)
          throw Error("Portfolio evidence capacity held");
        const result = previous
          ? this.db
              .prepare(
                "UPDATE portfolio_daily SET revision=?,value=? WHERE id=1 AND revision=?",
              )
              .run(revision, value, previous.revision)
          : this.db
              .prepare("INSERT OR IGNORE INTO portfolio_daily VALUES(1,?,?)")
              .run(revision, value);
        if (result.changes !== 1) throw Error("Portfolio owner state changed");
        for (const [kind, op, prior] of [
          ["collect", next.collectOperation, previous?.collectOperation],
          ["action", next.actionOperation, previous?.actionOperation],
        ] as const) {
          if (!op) continue;
          const key = hash([kind, op]),
            exists = this.seen(kind, op);
          if (prior !== op && exists)
            throw Error("Portfolio occurrence already processed");
          const stats = this.db
            .prepare(
              "SELECT count(*) AS count,coalesce(sum(length(value)),0) AS bytes FROM portfolio_operations",
            )
            .get() as { count: number; bytes: number };
          if (
            (!exists && stats.count >= 10000) ||
            stats.bytes + value.length > 64000000
          )
            throw Error("Portfolio journal capacity held");
          this.db
            .prepare(
              "INSERT INTO portfolio_operations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            )
            .run(
              key,
              this.vault.seal(state, "investor-portfolio-operation:" + key),
            );
        }
        return state;
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
async function within<T>(
  signal: AbortSignal,
  work: (child: AbortSignal) => Promise<T>,
  ms = 15000,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (e: Error) => void = () => {};
  const abort = () => {
    controller.abort();
    rejectAbort(Error("Portfolio call held"));
  };
  const stop = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(abort, ms);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work(controller.signal), stop]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
const norm = (v: string) =>
  v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function stableId(identity: string) {
  const h = hash(["investor-portfolio", identity]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Inactive unless trusted native adapters and exact current authority are provided.
 * Public source/model data never selects credentials, URLs, identifiers or actions.
 */
export class InvestorPortfolioDaily {
  private busy = false;
  private queue: Candidate[];
  private binding: string;
  constructor(
    private journal: PortfolioDailyJournal,
    private options: {
      queue: unknown;
      hosts: readonly string[];
      modelProfileId: string;
      datasets: ReadonlyMap<
        string,
        { id: string; name: string; client: PortfolioDataset }
      >;
      /** Must enforce current exact native/source grant, expiry, workflow approval and $0 cost per action. */
      authorize: (
        scope: {
          action:
            | "public-read"
            | "model"
            | "private-read"
            | "private-append"
            | "private-enrich";
          profile?: string;
          datasetId?: string;
          url?: string;
        },
        signal: AbortSignal,
      ) => Promise<void>;
      /** Reviewed native transport owns TLS/DNS pinning, private-address rejection, robots and access controls. No default network fallback. */
      publicRead: (url: string, signal: AbortSignal) => Promise<unknown>;
      /** Trusted local-only model runner pins the reviewed profile and returns actual provenance. */
      propose: (
        candidate: Candidate,
        pages: PortfolioPage[],
        signal: AbortSignal,
      ) => Promise<unknown>;
      now?: () => number;
    },
  ) {
    this.queue = z.array(candidateSchema).min(1).max(1000).parse(options.queue);
    if (
      new Set(this.queue.map((c) => c.identity)).size !== this.queue.length ||
      options.datasets.size !== 8 ||
      portfolioProfiles.some((p) => !options.datasets.has(p))
    )
      throw Error("Exact portfolio scope required");
    z.uuid().parse(options.modelProfileId);
    const ids = [...options.datasets.values()].map((d) => z.uuid().parse(d.id));
    if (new Set(ids).size !== 8)
      throw Error("Distinct portfolio bindings required");
    for (const c of this.queue) {
      if (options.datasets.get(c.profile)?.id !== c.datasetId)
        throw Error("Candidate dataset mismatch");
      for (const url of c.urls) sourceURL(url, [...options.hosts]);
    }
    this.binding = hash([
      this.queue,
      options.hosts,
      options.modelProfileId,
      portfolioProfiles.map((p) => [p, options.datasets.get(p)!.id]),
    ]);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async authorize(
    scope: Parameters<typeof this.options.authorize>[0],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await within(
      signal,
      (child) => this.options.authorize(Object.freeze(scope), child),
      5000,
    );
    signal.throwIfAborted();
  }
  private async snapshots(signal: AbortSignal) {
    const all = new Map<string, Snapshot>();
    for (const profile of portfolioProfiles) {
      const d = this.options.datasets.get(profile)!;
      await this.authorize(
        { action: "private-read", profile, datasetId: d.id },
        signal,
      );
      const value = snapshotSchema.parse(
        await within(signal, () => d.client.read()),
      );
      signal.throwIfAborted();
      if (value.id !== d.id) throw Error("Private dataset identity changed");
      all.set(profile, value);
    }
    return all;
  }
  private receipt(s: State): RecurringReceipt {
    const evidence = {
      phase: s.phase,
      cursor: s.cursor,
      reason: s.reason,
      privateDraftOnly: true,
      workspacePublished: false,
      modelEvidence: s.modelEvidence,
      sourceReceipt: s.sourceReceipt,
    };
    return {
      state:
        s.phase === "draft" || s.phase === "confirmed" ? "confirmed" : "held",
      evidence,
      fingerprint: hash(evidence),
      observedAt: this.now(),
      objectiveComplete: false,
    };
  }
  private state() {
    const s = this.journal.load();
    if (s && s.binding !== this.binding)
      throw Error("Portfolio revision changed; reconcile saved state");
    return s;
  }
  async collect(
    signal: AbortSignal,
    operationId: string,
  ): Promise<RecurringReceipt> {
    if (!/^[A-Za-z0-9:._-]{1,160}$/.test(operationId))
      throw Error("Invalid portfolio operation");
    if (this.busy) throw Error("Portfolio run already active");
    this.busy = true;
    let s: State | undefined;
    try {
      s = this.state();
      if (s?.targetProfile)
        await this.authorize(
          {
            action: "private-read",
            profile: s.targetProfile,
            datasetId: s.targetDataset,
          },
          signal,
        );
      if (
        s &&
        s.collectOperation !== operationId &&
        this.journal.seen("collect", operationId)
      )
        return this.receipt({
          ...s,
          phase: "held",
          reason: "Occurrence already processed",
        });
      if (s?.phase === "pending") return await this.reconcile(s, signal);
      if (s && !["idle", "confirmed"].includes(s.phase)) return this.receipt(s);
      if (s?.collectOperation === operationId) return this.receipt(s);
      const cursor = s?.cursor ?? 0,
        candidate = this.queue[cursor % this.queue.length]!;
      s = this.journal.save(s, {
        revision: 0,
        binding: this.binding,
        cursor,
        phase: "collecting",
        candidate,
        collectOperation: operationId,
      });
      const snapshots = await this.snapshots(signal),
        pages: PortfolioPage[] = [];
      for (const url of candidate.urls) {
        await this.authorize({ action: "public-read", url }, signal);
        const page = pageSchema.parse(
          await within(signal, (child) => this.options.publicRead(url, child)),
        );
        signal.throwIfAborted();
        if (
          page.url !== url ||
          page.sha256 !==
            createHash("sha256").update(page.text).digest("hex") ||
          this.now() - page.retrievedAt < 0 ||
          this.now() - page.retrievedAt > 86400000
        )
          throw Error("Fresh exact primary source evidence required");
        pages.push(page);
      }
      await this.authorize({ action: "model" }, signal);
      const proposal = proposalSchema.parse(
        await within(
          signal,
          (child) => this.options.propose(candidate, pages, child),
          40000,
        ),
      );
      signal.throwIfAborted();
      if (
        proposal.inputDigest !== hash([candidate, pages]) ||
        proposal.modelProfileId !== this.options.modelProfileId
      )
        throw Error("Local model provenance mismatch");
      for (const fact of proposal.facts) {
        const page = pages.find((p) => p.url === fact.sourceUrl);
        if (
          !page ||
          !page.text.includes(fact.quote) ||
          !fact.quote.includes(fact.value)
        )
          throw Error("Unsupported fact held");
        if (
          ["initial-cheque", "follow-on-cheque"].includes(fact.field) &&
          (/\b(fund size|fundrais|financing round|total round|LP minimum|minimum commitment|assets under management|AUM)\b/i.test(
            fact.quote,
          ) ||
            !(
              fact.field === "initial-cheque"
                ? /\b(initial|first|ticket|cheque|check)\b/i
                : /\b(follow.on|subsequent)\b/i
            ).test(fact.quote))
        )
          throw Error("Cheque dimension requires explicit source evidence");
        if (
          fact.field === "business-email" &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fact.value)
        )
          throw Error("Explicit public business email required");
      }
      const names = new Set([candidate.name, ...candidate.aliases].map(norm)),
        matches: { profile: string; entry: Snapshot["entries"][number] }[] = [];
      for (const [profile, snapshot] of snapshots)
        for (const entry of snapshot.entries)
          if (
            entry.id === stableId(candidate.identity) ||
            names.has(norm(entry.name))
          )
            matches.push({ profile, entry });
      if (
        matches.length > 1 ||
        matches.some((m) => m.entry.kind !== candidate.kind)
      )
        throw Error("Ambiguous identity requires review");
      const prior = matches[0],
        profile = prior?.profile ?? candidate.profile,
        target = this.options.datasets.get(profile)!;
      const lines = proposal.facts.map(
        (f) =>
          `${f.field} (research proposal): ${f.value}\nEvidence: ${f.quote}\nSource: ${f.sourceUrl}; retrieved ${new Date(pages.find((p) => p.url === f.sourceUrl)!.retrievedAt).toISOString()}`,
      );
      const novelLines = lines.filter(
        (line) =>
          !(prior?.entry.description ?? "").includes(
            line.split("; retrieved ")[0]!,
          ),
      );
      if (prior && novelLines.length === 0) {
        await this.authorize(
          { action: "private-read", profile, datasetId: target.id },
          signal,
        );
        s = this.journal.save(s, {
          ...s,
          phase: "confirmed",
          cursor: s.cursor + 1,
          sourceReceipt: {
            datasetId: target.id,
            version: snapshots.get(profile)!.version,
            entryId: prior.entry.id,
            unchanged: true,
            workspacePublished: false,
          },
        });
        return this.receipt(s);
      }
      const description = [prior?.entry.description ?? "", ...novelLines]
        .filter(Boolean)
        .join("\n\n");
      const entry = {
        id: prior?.entry.id ?? stableId(candidate.identity),
        kind: candidate.kind,
        name: prior?.entry.name ?? candidate.name,
        description,
      };
      s = this.journal.save(s, {
        ...s,
        phase: "draft",
        entry,
        expectedEntryHash: hash(entry),
        targetId: entry.id,
        targetProfile: profile,
        targetDataset: target.id,
        previousDescription: prior?.entry.description,
        targetExisted: !!prior,
        draftAt: Math.min(...pages.map((p) => p.retrievedAt)),
        modelEvidence: {
          modelProfileId: proposal.modelProfileId,
          modelDigest: proposal.modelDigest,
          inputDigest: proposal.inputDigest,
          sourceHashes: pages.map((p) => p.sha256),
          retrievedAt: pages.map((p) => p.retrievedAt),
        },
      });
      await this.authorize(
        {
          action: "private-read",
          profile: s.targetProfile,
          datasetId: s.targetDataset,
        },
        signal,
      );
      return this.receipt(s);
    } catch {
      if (s) {
        if (s.phase === "pending") return this.receipt(s);
        s = this.journal.save(s, {
          ...s,
          phase: "held",
          reason: "Research/source/identity outcome requires review",
        });
        return this.receipt(s);
      }
      throw Error("Portfolio state held");
    } finally {
      this.busy = false;
    }
  }
  private async reconcile(s: State, signal: AbortSignal) {
    const all = await this.snapshots(signal),
      snapshot = all.get(s.targetProfile!)!,
      entry = snapshot.entries.find((e) => e.id === s.targetId);
    if (
      entry &&
      s.entry &&
      ["id", "kind", "name", "description"].every(
        (k) => entry[k] === s.entry![k],
      )
    ) {
      s = this.journal.save(s, {
        ...s,
        phase: "confirmed",
        cursor: s.cursor + 1,
        sourceReceipt: {
          datasetId: snapshot.id,
          version: snapshot.version,
          entryId: entry.id,
          reconciledPresence: true,
          workspacePublished: false,
          mutationReceipt: s.sourceReceipt ?? null,
        },
      });
    }
    return this.receipt(s); // Absent/changed means held, never re-send the mutation.
  }
  async apply(
    signal: AbortSignal,
    operationId: string,
  ): Promise<RecurringReceipt> {
    if (!/^[A-Za-z0-9:._-]{1,160}$/.test(operationId))
      throw Error("Invalid portfolio operation");
    if (this.busy) throw Error("Portfolio run already active");
    this.busy = true;
    let s = this.state();
    try {
      if (!s) throw Error("No reviewed draft");
      if (
        s.actionOperation !== operationId &&
        this.journal.seen("action", operationId)
      )
        return this.receipt({
          ...s,
          phase: "held",
          reason: "Action occurrence already processed",
        });
      if (s.phase === "pending") return await this.reconcile(s, signal);
      if (
        s.phase !== "draft" ||
        !s.entry ||
        s.expectedEntryHash !== hash(s.entry)
      )
        return this.receipt(s);
      const all = await this.snapshots(signal),
        snapshot = all.get(s.targetProfile!)!,
        prior = snapshot.entries.find((e) => e.id === s!.targetId);
      const names = new Set(
        [s.candidate!.name, ...s.candidate!.aliases].map(norm),
      );
      const matches = [...all].flatMap(([profile, v]) =>
        v.entries
          .filter((e) => names.has(norm(e.name)) || e.id === s!.targetId)
          .map((entry) => ({ profile, entry })),
      );
      if (
        matches.length > 1 ||
        matches.some(
          (m) => m.profile !== s!.targetProfile || m.entry.id !== s!.targetId,
        ) ||
        !!prior !== s.targetExisted ||
        prior?.description !== s.previousDescription ||
        (prior &&
          (prior.name !== s.entry!.name || prior.kind !== s.entry!.kind)) ||
        s.draftAt === undefined ||
        this.now() < s.draftAt ||
        this.now() - s.draftAt > 86400000
      )
        throw Error("Fresh version conflict");
      const action = prior ? "private-enrich" : "private-append";
      await this.authorize(
        { action, profile: s.targetProfile!, datasetId: s.targetDataset! },
        signal,
      );
      const target = this.options.datasets.get(s.targetProfile!)!;
      // Persist before the first mutation. Any uncertain outcome can only reconcile.
      s = this.journal.save(s, {
        ...s,
        phase: "pending",
        actionOperation: operationId,
      });
      const raw = prior
        ? await within(signal, () =>
            target.client.patch({
              version: snapshot.version,
              name: snapshot.name,
              changes: [
                { id: s!.targetId, description: s!.entry!.description },
              ],
              removeIds: [],
            }),
          )
        : await within(signal, () =>
            target.client.append(
              { version: snapshot.version, entries: [s!.entry!] },
              target.id,
            ),
          );
      signal.throwIfAborted();
      const receipt = z
        .object({ id: z.uuid(), version: z.number().int().positive() })
        .passthrough()
        .parse(raw);
      if (receipt.id !== target.id || receipt.version <= snapshot.version)
        throw Error("Uncertain private save receipt");
      s = this.journal.save(s, {
        ...s,
        sourceReceipt: {
          id: receipt.id,
          version: receipt.version,
          entryId: s.targetId,
          workspacePublished: false,
        },
      });
      return await this.reconcile(s, signal);
    } catch {
      if (s) {
        if (s.phase !== "pending")
          s = this.journal.save(s, {
            ...s,
            phase: "held",
            reason: "Private save/source scope requires reconciliation",
          });
        return this.receipt(s);
      }
      throw Error("Portfolio state held");
    } finally {
      this.busy = false;
    }
  }
}

/** Default registration has no source, credential, storage or network side effects. */
export function portfolioDailyAdapters(adapter?: InvestorPortfolioDaily) {
  const workflowId = "bittrees-investor-portfolio-daily";
  const unavailable = async (): Promise<RecurringReceipt> => ({
    state: "held",
    observedAt: Date.now(),
    fingerprint: hash("portfolio-native-interfaces-unavailable"),
    evidence: {
      reason: "Trusted native portfolio interfaces are not provisioned",
      privateDraftOnly: true,
      workspacePublished: false,
    },
    objectiveComplete: false,
  });
  return {
    collector: {
      workflowId,
      capability: "local.investor.portfolio.daily",
      read: (signal: AbortSignal, id: string) =>
        adapter ? adapter.collect(signal, id) : unavailable(),
      decide: (receipt: RecurringReceipt) => {
        const evidence = receipt.evidence as { phase?: string };
        return receipt.state !== "confirmed"
          ? {
              decision: "escalate" as const,
              summary:
                "Daily investor research held; reconcile exact native/source scope.",
            }
          : evidence.phase === "draft"
            ? {
                decision: "act" as const,
                actionId: "local.investor.portfolio.private-apply",
                summary:
                  "Save sourced proposal to its reviewed private list; workspace publication remains separate.",
              }
            : {
                decision: "wait" as const,
                summary:
                  "Private research evidence reconciled. No workspace publication performed.",
              };
      },
    },
    action: {
      workflowId,
      capability: "local.investor.portfolio.private-edit",
      read: (signal: AbortSignal, id: string) =>
        adapter ? adapter.apply(signal, id) : unavailable(),
    },
  };
}
