import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync, chmodSync } from "node:fs";
import { z } from "zod";

export const myCloudOperationIdSchema = z.union([
  z.string().regex(/^[a-f0-9]{64}$/),
  z.uuid(),
  z
    .string()
    .refine(
      (value) =>
        value.startsWith("verify:") &&
        z.uuid().safeParse(value.slice(7)).success,
    ),
]);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type MyCloudOperationRecord = {
  id: string;
  revision: string;
  state: "pending" | "confirmed" | "uncertain";
  startedAt: number;
  responseSha256: string | null;
};

/** Durable opaque operation metadata only; accepted health stays in the encrypted source store.
 * An old ID can return its still-cached, hash-matching response, or must be held. It can
 * never be executed again, including after helper/app restart. No retention deletion.
 */
export class MyCloudOperationJournal {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw Error("Invalid MyCloud journal identity");
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
      "CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,revision TEXT NOT NULL,state TEXT NOT NULL,startedAt INTEGER NOT NULL,responseSha256 TEXT)",
    );
  }
  get(id: string): MyCloudOperationRecord | null {
    myCloudOperationIdSchema.parse(id);
    return (
      (this.db
        .prepare(
          "SELECT id,revision,state,startedAt,responseSha256 FROM operations WHERE id=?",
        )
        .get(id) as MyCloudOperationRecord | undefined) ?? null
    );
  }
  reserve(id: string, revision: string, now: number) {
    myCloudOperationIdSchema.parse(id);
    revisionSchema.parse(revision);
    if (!Number.isSafeInteger(now) || now < 0)
      throw Error("Invalid MyCloud operation time");
    this.db.transaction(() => {
      if (this.get(id))
        throw Error(
          "MyCloud operation already recorded; reconcile rather than replay",
        );
      const stats = this.db
        .prepare(
          "SELECT COUNT(*) AS count,MAX(startedAt) AS latest FROM operations",
        )
        .get() as { count: number; latest: number | null };
      if (stats.count >= 10000)
        throw Error(
          "MyCloud operation journal full; retention review required",
        );
      if (stats.latest !== null && now - stats.latest < 60000)
        throw Error("MyCloud source rate limit; no immediate replay");
      this.db
        .prepare(
          "INSERT INTO operations(id,revision,state,startedAt) VALUES(?,?,'pending',?)",
        )
        .run(id, revision, now);
    })();
  }
  confirm(id: string, revision: string, raw: string) {
    myCloudOperationIdSchema.parse(id);
    revisionSchema.parse(revision);
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768)
      throw Error("Bounded MyCloud response required");
    const hash = createHash("sha256").update(raw).digest("hex");
    const result = this.db
      .prepare(
        "UPDATE operations SET state='confirmed',responseSha256=? WHERE id=? AND revision=? AND state='pending'",
      )
      .run(hash, id, revision);
    if (result.changes !== 1)
      throw Error("MyCloud operation or approval changed");
    return hash;
  }
  uncertain(id: string, revision: string) {
    myCloudOperationIdSchema.parse(id);
    revisionSchema.parse(revision);
    this.db
      .prepare(
        "UPDATE operations SET state='uncertain' WHERE id=? AND revision=? AND state='pending'",
      )
      .run(id, revision);
  }
  matchesCached(id: string, revision: string, raw: string) {
    revisionSchema.parse(revision);
    const row = this.get(id);
    return (
      row?.state === "confirmed" &&
      row.revision === revision &&
      row.responseSha256 === createHash("sha256").update(raw).digest("hex")
    );
  }
  count() {
    return (
      this.db.prepare("SELECT COUNT(*) AS count FROM operations").get() as {
        count: number;
      }
    ).count;
  }
  close() {
    if (this.db.open) this.db.close();
  }
}
