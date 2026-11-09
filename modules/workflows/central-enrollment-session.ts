import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { nativeEnrollmentSessionFactory } from "../task-sync/enrollment-native-session.js";
import type { EnrollmentReview } from "../task-sync/enrollment-transport-plan.js";
import { CentralEnrollmentOwner } from "./central-enrollment-owner.js";
import { centralEnrollmentReconciliation } from "./central-enrollment-reconciliation.js";

/** A separate central-purpose native store. No task-sync state or credential
 * fallback. Construct only after exact native owner consent; no network occurs
 * until a typed start/poll command. Existing original-session receipts and
 * reservations are retained across owner-review epochs and process restarts. */
export function nativeCentralEnrollmentSessionFactory(
  options: Parameters<typeof nativeEnrollmentSessionFactory>[0] & {
    centralStatePath: string;
  },
) {
  if (
    !isAbsolute(options.path) ||
    !isAbsolute(options.centralStatePath) ||
    options.path === options.centralStatePath
  )
    throw Error(
      "Separate absolute central enrollment and identity paths required",
    );
  const sessionFactory = nativeEnrollmentSessionFactory(options);
  return (current: () => EnrollmentReview | null) => {
    if (!options.admitted())
      throw Error("Current native central enrollment admission required");
    const review = current();
    if (!review)
      throw Error("Explicit native central enrollment review required");
    try {
      const fd = openSync(options.path, "wx", 0o600);
      closeSync(fd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    for (const path of [
      options.path,
      options.path + "-wal",
      options.path + "-shm",
    ]) {
      try {
        const s = lstatSync(path);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          realpathSync(path) !== path ||
          s.uid !== process.getuid?.() ||
          (s.mode & 0o077) !== 0 ||
          s.size > 32 * 1024 ** 2
        )
          throw Error("Protected central enrollment state required");
      } catch (e) {
        if (
          path === options.path ||
          (e as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw e;
      }
    }
    const db = new Database(options.path);
    try {
      db.pragma("journal_mode=WAL");
      db.pragma("synchronous=FULL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS central_native_handoffs(id TEXT PRIMARY KEY,record BLOB NOT NULL)",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS central_native_handoff_archive(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,record BLOB NOT NULL)",
      );
      const id = createHash("sha256")
          .update(review.principal + "\n" + review.publicKey)
          .digest("hex"),
        aad = "central-native-handoff:" + id;
      const admittedReview = () => (options.admitted() ? current() : null);
      const owner = new CentralEnrollmentOwner({
        path: options.centralStatePath,
        vault: options.vault,
        current: admittedReview,
        store: {
          read: () => {
            const row = db
              .prepare(
                "SELECT CASE WHEN length(record)<=160000 THEN record ELSE NULL END AS record FROM central_native_handoffs WHERE id=?",
              )
              .get(id) as { record: Buffer | null } | undefined;
            if (!row) return null;
            if (!Buffer.isBuffer(row.record))
              throw Error("Central enrollment record limit exceeded");
            return options.vault.open(row.record, aad);
          },
          write: (record) => {
            if (JSON.stringify(record).length > 128000)
              throw Error("Central enrollment record limit exceeded");
            db.prepare(
              "INSERT INTO central_native_handoffs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
            ).run(id, options.vault.seal(record, aad));
          },
          replace: (original, replacement) => {
            if (JSON.stringify(original).length > 128000)
              throw Error("Original enrollment archive limit exceeded");
            db.prepare(
              "INSERT INTO central_native_handoff_archive VALUES(?,?,?)",
            ).run(
              id,
              original.review.epoch,
              options.vault.seal(
                original,
                "central-native-handoff-archive:" +
                  id +
                  ":" +
                  original.review.epoch,
              ),
            );
            db.prepare(
              "UPDATE central_native_handoffs SET record=? WHERE id=?",
            ).run(options.vault.seal(replacement, aad), id);
          },
          canReplace: () =>
            !db
              .prepare(
                "SELECT 1 FROM central_native_handoff_archive WHERE id=?",
              )
              .get(id),
          atomic: (work) => db.transaction(work).immediate(),
        },
        session: sessionFactory,
        reconcile: centralEnrollmentReconciliation({
          ...options,
          db,
          current: admittedReview,
        }),
        now: options.now,
      });
      return {
        execute: (raw: unknown, signal: AbortSignal) =>
          owner.execute(raw, signal),
        close: () => {
          try {
            owner.close();
          } finally {
            db.close();
          }
        },
      };
    } catch (e) {
      db.close();
      throw e;
    }
  };
}
