import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { id, sourceRefSchema } from "../contracts/index.js";
import { Vault } from "../storage/vault.js";
import { StoreError, type Owner } from "../storage/store.js";
const memorySchema = z.strictObject({
  type: z.enum(["preference", "fact", "decision", "outcome", "procedure"]),
  text: z.string().min(1).max(16000),
  sources: z.array(sourceRefSchema).min(1).max(32),
  origin: z.enum(["user", "model"]),
  expiresAt: z.number().int().positive().nullable().default(null),
});
type MemoryInput = z.infer<typeof memorySchema>;
interface Row {
  id: string;
  user_id: string;
  tenant_id: string;
  state: "candidate" | "approved";
  revision: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  payload: Buffer;
  fingerprint: string;
}
export type AccessCheck = (
  owner: Owner,
  sources: MemoryInput["sources"],
) => Promise<boolean>;
export class MemoryStore {
  private db: Database.Database;
  constructor(
    path: string,
    private vault: Vault,
    private canRead: AccessCheck,
    private now: () => number = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("foreign_keys=ON");
    this.db.pragma("secure_delete=ON");
    this.db.pragma("busy_timeout=5000");
    try {
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS memory_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,verifier BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,pinned INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,payload BLOB NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(user_id,tenant_id,fingerprint));
CREATE INDEX IF NOT EXISTS memory_owner ON memory(user_id,tenant_id);
CREATE TABLE IF NOT EXISTS feedback(memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,id TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(memory_id,id));`);
        const meta = this.db
          .prepare("SELECT version,verifier FROM memory_meta WHERE id=1")
          .get() as { version: number; verifier: Buffer } | undefined;
        if (meta) {
          if (
            meta.version !== 1 ||
            this.vault.open(meta.verifier, "memory-key") !==
              "bittrees-ai-memory"
          )
            throw new Error("Unsupported memory store or key");
        } else
          this.db
            .prepare("INSERT INTO memory_meta VALUES(1,1,?)")
            .run(this.vault.seal("bittrees-ai-memory", "memory-key"));
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private row(owner: Owner, memoryId: string) {
    const r = this.db
      .prepare("SELECT * FROM memory WHERE id=? AND user_id=? AND tenant_id=?")
      .get(memoryId, owner.userId, owner.tenantId) as Row | undefined;
    if (!r) throw new StoreError("NOT_FOUND");
    return r;
  }
  private input(r: Row) {
    return this.vault.open<MemoryInput>(r.payload, "memory:" + r.id);
  }
  private unexpired(input: MemoryInput) {
    return input.expiresAt === null || input.expiresAt > this.now();
  }
  private unchanged(owner: Owner, snapshot: Row) {
    try {
      const current = this.row(owner, snapshot.id);
      return (
        current.revision === snapshot.revision &&
        current.state === snapshot.state &&
        current.fingerprint === snapshot.fingerprint &&
        this.unexpired(this.input(current))
      );
    } catch (error) {
      if (error instanceof StoreError && error.code === "NOT_FOUND")
        return false;
      throw error;
    }
  }
  private visible(owner: Owner, input: MemoryInput) {
    return this.unexpired(input) && this.canRead(owner, input.sources);
  }
  async add(owner: Owner, raw: unknown) {
    const input = memorySchema.parse(raw);
    if (!(await this.visible(owner, input))) throw new StoreError("NOT_FOUND");
    return this.db
      .transaction(() => {
        if (!this.unexpired(input)) throw new StoreError("NOT_FOUND");
        const fingerprint = this.vault.fingerprint(input);
        const old = this.db
          .prepare(
            "SELECT id FROM memory WHERE user_id=? AND tenant_id=? AND fingerprint=?",
          )
          .get(owner.userId, owner.tenantId, fingerprint) as
          { id: string } | undefined;
        if (old) return { id: old.id };
        const count = this.db
          .prepare(
            "SELECT count(*) AS n FROM memory WHERE user_id=? AND tenant_id=?",
          )
          .get(owner.userId, owner.tenantId) as { n: number };
        if (count.n >= 1000) throw new StoreError("CAPACITY");
        const memoryId = randomUUID();
        this.db
          .prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(
            memoryId,
            owner.userId,
            owner.tenantId,
            "candidate",
            1,
            0,
            this.now(),
            this.now(),
            this.vault.seal(input, "memory:" + memoryId),
            fingerprint,
          );
        return { id: memoryId };
      })
      .immediate();
  }
  async get(owner: Owner, memoryId: string) {
    const r = this.row(owner, memoryId),
      input = this.input(r);
    if (!(await this.visible(owner, input)) || !this.unchanged(owner, r))
      throw new StoreError("NOT_FOUND");
    return {
      id: r.id,
      state: r.state,
      revision: r.revision,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...input,
      verified: false,
    };
  }
  async review(
    owner: Owner,
    memoryId: string,
    revision: number,
    change: { approve?: boolean; text?: string; pinned?: boolean },
  ) {
    const patch = z
      .strictObject({
        approve: z.boolean().optional(),
        text: z.string().min(1).max(16000).optional(),
        pinned: z.boolean().optional(),
      })
      .parse(change);
    const initial = this.row(owner, memoryId);
    const input = this.input(initial);
    if (!(await this.visible(owner, input))) throw new StoreError("NOT_FOUND");
    const next = { ...input, ...(patch.text ? { text: patch.text } : {}) };
    this.db
      .transaction(() => {
        const current = this.row(owner, memoryId);
        if (!this.unexpired(this.input(current)))
          throw new StoreError("NOT_FOUND");
        if (
          current.revision !== revision ||
          current.revision !== initial.revision
        )
          throw new StoreError("CONFLICT");
        this.db
          .prepare(
            "UPDATE memory SET state=?,revision=revision+1,pinned=?,updated_at=?,payload=?,fingerprint=? WHERE id=?",
          )
          .run(
            patch.approve === undefined
              ? next.text !== input.text
                ? "candidate"
                : current.state
              : patch.approve
                ? "approved"
                : "candidate",
            patch.pinned === undefined ? current.pinned : Number(patch.pinned),
            this.now(),
            this.vault.seal(next, "memory:" + memoryId),
            this.vault.fingerprint(next),
            memoryId,
          );
      })
      .immediate();
    return this.get(owner, memoryId);
  }
  async feedback(
    owner: Owner,
    memoryId: string,
    feedbackId: string,
    outcome: "accepted" | "edited" | "rejected",
  ) {
    id.parse(feedbackId);
    z.enum(["accepted", "edited", "rejected"]).parse(outcome);
    await this.get(owner, memoryId);
    this.db
      .transaction(() => {
        this.row(owner, memoryId);
        const existing = this.db
          .prepare("SELECT outcome FROM feedback WHERE memory_id=? AND id=?")
          .get(memoryId, feedbackId) as { outcome: string } | undefined;
        if (existing && existing.outcome !== outcome)
          throw new StoreError("CONFLICT");
        this.db
          .prepare("INSERT OR IGNORE INTO feedback VALUES(?,?,?,?)")
          .run(memoryId, feedbackId, outcome, this.now());
      })
      .immediate();
  }
  async search(owner: Owner, query: string, limit = 8) {
    if (
      query.length > 512 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new StoreError("INVALID_INPUT");
    const terms = [
      ...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
    ].slice(0, 20);
    if (!terms.length) return [];
    const rows = this.db
      .prepare(
        "SELECT * FROM memory WHERE user_id=? AND tenant_id=? AND state='approved' ORDER BY id LIMIT 1000",
      )
      .all(owner.userId, owner.tenantId) as Row[];
    const eligible = new Map<string, { row: Row; input: MemoryInput }>();
    for (const row of rows) {
      const input = this.input(row);
      if (await this.visible(owner, input))
        eligible.set(row.id, { row, input });
    }
    // Plaintext FTS lives only in this ephemeral connection, after current access filtering.
    const index = new Database(":memory:");
    try {
      index.exec("CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,text)");
      const insert = index.prepare("INSERT INTO search VALUES(?,?)");
      for (const [key, item] of eligible) insert.run(key, item.input.text);
      const matches = index
        .prepare(
          "SELECT id,bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT 1000",
        )
        .all(terms.map((t) => '"' + t + '"').join(" OR ")) as {
        id: string;
        rank: number;
      }[];
      const results = matches
        .map((match) => {
          const { row, input } = eligible.get(match.id)!;
          const f = this.db
            .prepare(
              "SELECT COALESCE(SUM(CASE outcome WHEN 'accepted' THEN 1 WHEN 'edited' THEN 0 ELSE -1 END),0) AS usefulness FROM feedback WHERE memory_id=?",
            )
            .get(row.id) as { usefulness: number };
          const relevance =
            terms.filter((t) => input.text.toLocaleLowerCase().includes(t))
              .length / terms.length;
          const freshness =
              1 /
              (1 + Math.max(0, this.now() - row.updated_at) / 2_592_000_000),
            usefulness = Math.max(-1, Math.min(1, f.usefulness / 5));
          return {
            id: row.id,
            text: input.text,
            type: input.type,
            sources: input.sources,
            verified: false,
            score:
              relevance * 5 + freshness + usefulness + (row.pinned ? 0.5 : 0),
            why: {
              relevance,
              freshness,
              usefulness,
              pinned: !!row.pinned,
              provenance: input.origin,
              reviewed: true,
            },
          };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      // A source can be revoked while other checks await. Recheck final candidates before returning.
      const output = [];
      const selectedText = new Set<string>();
      const sourceUses = new Map<string, number>();
      const sourceKeys = (sources: MemoryInput["sources"]) => [
        ...new Set(
          sources.map((source) =>
            JSON.stringify([source.app, source.tenantId, source.resourceId]),
          ),
        ),
      ];
      const penalty = (sources: MemoryInput["sources"]) =>
        Math.min(
          2,
          0.75 *
            Math.max(
              0,
              ...sourceKeys(sources).map((key) => sourceUses.get(key) ?? 0),
            ),
        );
      const remaining = [...results];
      while (remaining.length && output.length < limit) {
        // Once a text has a valid representative, skip its other copies in one pass.
        for (let i = remaining.length - 1; i >= 0; i--) {
          if (
            selectedText.has(
              JSON.stringify([remaining[i]!.type, remaining[i]!.text]),
            )
          )
            remaining.splice(i, 1);
        }
        if (!remaining.length) break;
        // Diversify only within the leading base-ranked candidate's query coverage.
        // Never cross a different term-coverage group solely to gain source diversity.
        const coverage = remaining[0]!.why.relevance;
        let nextIndex = 0;
        let nextScore = remaining[0]!.score - penalty(remaining[0]!.sources);
        for (let i = 1; i < remaining.length; i++) {
          const candidate = remaining[i]!;
          if (candidate.why.relevance !== coverage) continue;
          const score = candidate.score - penalty(candidate.sources);
          if (
            score > nextScore ||
            (score === nextScore &&
              candidate.id.localeCompare(remaining[nextIndex]!.id) < 0)
          ) {
            nextIndex = i;
            nextScore = score;
          }
        }
        const r = remaining.splice(nextIndex, 1)[0]!;
        // Preserve meaning-sensitive case, punctuation and whitespace. This is exact-text diversity only.
        const textKey = JSON.stringify([r.type, r.text]);
        if (selectedText.has(textKey)) continue;
        const snapshot = eligible.get(r.id)!.row;
        if (!this.unchanged(owner, snapshot)) continue;
        if (
          (await this.visible(owner, this.input(snapshot))) &&
          this.unchanged(owner, snapshot)
        ) {
          selectedText.add(textKey);
          const sourcePenalty = penalty(r.sources);
          output.push({
            ...r,
            score: r.score - sourcePenalty,
            why: { ...r.why, sourcePenalty },
          });
          for (const key of sourceKeys(r.sources))
            sourceUses.set(key, (sourceUses.get(key) ?? 0) + 1);
        }
      }
      // Later access checks may yield to edits/deletion of an earlier result.
      return output.filter((r) =>
        this.unchanged(owner, eligible.get(r.id)!.row),
      );
    } finally {
      index.close();
    }
  }
  forget(owner: Owner, memoryId: string) {
    this.row(owner, memoryId);
    this.db.prepare("DELETE FROM memory WHERE id=?").run(memoryId);
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  invalidate(owner: Owner, app: string, resourceId: string) {
    const rows = this.db
      .prepare("SELECT * FROM memory WHERE user_id=? AND tenant_id=?")
      .all(owner.userId, owner.tenantId) as Row[];
    this.db
      .transaction(() => {
        for (const row of rows)
          if (
            this.input(row).sources.some(
              (s) => s.app === app && s.resourceId === resourceId,
            )
          )
            this.db.prepare("DELETE FROM memory WHERE id=?").run(row.id);
      })
      .immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  async export(owner: Owner) {
    const rows = this.db
      .prepare("SELECT * FROM memory WHERE user_id=? AND tenant_id=?")
      .all(owner.userId, owner.tenantId) as Row[];
    const output = [];
    for (const row of rows) {
      try {
        const value = await this.get(owner, row.id);
        if (this.unchanged(owner, row)) output.push({ row, value });
      } catch (error) {
        if (!(error instanceof StoreError && error.code === "NOT_FOUND"))
          throw error;
      }
    }
    return output
      .filter((item) => this.unchanged(owner, item.row))
      .map((item) => item.value);
  }
  deleteAll(owner: Owner) {
    this.db
      .prepare("DELETE FROM memory WHERE user_id=? AND tenant_id=?")
      .run(owner.userId, owner.tenantId);
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  async backup(destination: string) {
    await this.db.backup(destination);
  }
  close() {
    this.db.close();
  }
}
