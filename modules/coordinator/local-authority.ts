import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export class AuthorityDenied extends Error {}
/** Local operator grants never override authority enforced by MCP or source apps. */
export class LocalAuthority {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS marketplace_authority (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER,
      revoked_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS marketplace_authority_events (
      id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);`);
  }
  grant(owner: string, duration: "until-revoked" | number, automatic = false) {
    if (
      !owner ||
      (duration !== "until-revoked" &&
        (!Number.isSafeInteger(duration) || duration <= Date.now()))
    )
      throw Error("Choose until-revoked or a future expiry");
    const id = randomUUID();
    this.db
      .transaction(() => {
        this.db
          .prepare("INSERT INTO marketplace_authority VALUES(?,?,?,NULL,?)")
          .run(
            id,
            owner,
            duration === "until-revoked" ? null : duration,
            Date.now(),
          );
        this.event(id, "granted");
        if (automatic) this.event(id, "qualified_execution_enabled");
      })
      .immediate();
    return id;
  }
  private event(id: string, event: string) {
    this.db
      .prepare(
        "INSERT INTO marketplace_authority_events(grant_id,event,at) VALUES(?,?,?)",
      )
      .run(id, event, Date.now());
  }
  revoke(owner: string, id: string) {
    this.db
      .transaction(() => {
        const result = this.db
          .prepare(
            "UPDATE marketplace_authority SET revoked_at=? WHERE owner=? AND id=? AND revoked_at IS NULL",
          )
          .run(Date.now(), owner, id);
        if (result.changes) this.event(id, "revoked");
      })
      .immediate();
  }
  check(owner: string, id: string, action: string) {
    // Re-read on every dispatch; never cache a successful authorization.
    const grant = this.db
      .prepare("SELECT * FROM marketplace_authority WHERE id=? AND owner=?")
      .get(id, owner) as
      { revoked_at: number | null; expires_at: number | null } | undefined;
    const executionAllowed =
      !action.endsWith(":execute") ||
      !!this.db
        .prepare(
          "SELECT 1 FROM marketplace_authority_events WHERE grant_id=? AND event='qualified_execution_enabled'",
        )
        .get(id);
    if (
      !executionAllowed ||
      !grant ||
      grant.revoked_at !== null ||
      (grant.expires_at !== null && grant.expires_at <= Date.now()) ||
      ![
        "crm:execute",
        "mercado:execute",
        "create",
        "crm:status",
        "crm:preview",
        "mercado:status",
        "mercado:preview",
        "sync",
      ].includes(action)
    )
      throw new AuthorityDenied(
        "Automation authority is missing, expired, revoked, or out of scope",
      );
  }
  list(owner: string) {
    return this.db
      .prepare(
        "SELECT id,expires_at,revoked_at,created_at FROM marketplace_authority WHERE owner=? ORDER BY created_at DESC",
      )
      .all(owner);
  }
}
