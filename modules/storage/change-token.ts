import type Database from "better-sqlite3";
/** Compare only on the same open connection. Detect local writes and other-connection commits. */
export function databaseChangeToken(db: Database.Database) {
  const local = db.prepare("SELECT total_changes() AS changes").get() as {
    changes: number;
  };
  return JSON.stringify([
    local.changes,
    db.pragma("data_version", { simple: true }),
  ]);
}
