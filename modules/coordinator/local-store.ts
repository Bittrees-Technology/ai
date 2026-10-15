import Database from "better-sqlite3";
import { Vault } from "../storage/vault.js";
import type { RunStore, RunStep } from "./run-store.js";
export class LocalRunStore implements RunStore {
  constructor(
    private db: Database.Database,
    private vault: Vault,
  ) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS marketplace_local_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload BLOB NOT NULL,lease TEXT,lease_until INTEGER,revision INTEGER NOT NULL DEFAULT 1,acked INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
    );
  }
  private decode(row: any) {
    return this.vault.open<{ input: unknown; steps: RunStep[] }>(
      row.payload,
      `marketplace:${row.owner}:${row.id}`,
    );
  }
  async create(owner: string, id: string, input: unknown, steps: RunStep[]) {
    this.db
      .transaction(() => {
        const old: any = this.db
          .prepare("SELECT * FROM marketplace_local_runs WHERE id=?")
          .get(id);
        if (old) {
          if (
            old.owner !== owner ||
            this.vault.fingerprint(this.decode(old).input) !==
              this.vault.fingerprint(input)
          )
            throw Error("Run ID conflict");
          return;
        }
        this.db
          .prepare(
            "INSERT INTO marketplace_local_runs(id,owner,payload,updated_at) VALUES(?,?,?,?)",
          )
          .run(
            id,
            owner,
            this.vault.seal({ input, steps }, `marketplace:${owner}:${id}`),
            Date.now(),
          );
      })
      .immediate();
  }
  async get(owner: string, id: string) {
    const row: any = this.db
      .prepare("SELECT * FROM marketplace_local_runs WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) throw Error("Run not found");
    return { id, steps: this.decode(row).steps, updated_at: row.updated_at };
  }
  async claim(owner: string, id: string, lease: string) {
    return this.db
      .transaction(() => {
        const row: any = this.db
          .prepare(
            "UPDATE marketplace_local_runs SET lease=?,lease_until=? WHERE id=? AND owner=? AND (lease_until IS NULL OR lease_until<?) RETURNING *",
          )
          .get(lease, Date.now() + 90000, id, owner, Date.now());
        return row ? this.decode(row).steps : undefined;
      })
      .immediate();
  }
  async save(id: string, lease: string, steps: RunStep[]) {
    this.db
      .transaction(() => {
        const row: any = this.db
          .prepare(
            "SELECT * FROM marketplace_local_runs WHERE id=? AND lease=?",
          )
          .get(id, lease);
        if (!row) throw Error("Lease lost");
        const data = this.decode(row);
        this.db
          .prepare(
            "UPDATE marketplace_local_runs SET payload=?,revision=revision+1,updated_at=? WHERE id=? AND lease=?",
          )
          .run(
            this.vault.seal(
              { ...data, steps },
              `marketplace:${row.owner}:${id}`,
            ),
            Date.now(),
            id,
            lease,
          );
      })
      .immediate();
  }
  async release(id: string, lease: string) {
    this.db
      .prepare(
        "UPDATE marketplace_local_runs SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
      )
      .run(id, lease);
  }
  pending(owner: string) {
    return (
      this.db
        .prepare(
          "SELECT * FROM marketplace_local_runs WHERE owner=? AND revision>acked ORDER BY updated_at LIMIT 20",
        )
        .all(owner) as any[]
    ).map((row) => ({
      runId: row.id,
      revision: row.revision,
      counts: this.decode(row).steps.reduce(
        (counts: Record<string, number>, s) => {
          const key = s.source + ":" + s.state;
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        },
        {},
      ),
    }));
  }
  acknowledge(owner: string, id: string, revision: number) {
    this.db
      .prepare(
        "UPDATE marketplace_local_runs SET acked=max(acked,?) WHERE owner=? AND id=? AND revision>=?",
      )
      .run(revision, owner, id, revision);
  }
  ids(owner: string) {
    return (
      this.db
        .prepare(
          "SELECT id FROM marketplace_local_runs WHERE owner=? ORDER BY updated_at LIMIT 20",
        )
        .all(owner) as { id: string }[]
    ).map((r) => r.id);
  }
}
