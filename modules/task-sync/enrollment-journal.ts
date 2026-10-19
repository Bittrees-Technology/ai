import Database from "better-sqlite3";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  operationId: z.uuid(),
  epoch: z.string().min(1).max(200),
  kind: z.enum(["start", "complete"]),
  requestDigest: digest,
});
export type EnrollmentOperationBinding = z.infer<typeof bindingSchema>;
type Entry = EnrollmentOperationBinding & {
  state: "reserved" | "confirmed";
  responseDigest?: string;
};
/** Inactive durable mutation guard. A reserved row means reconcile, never retry.
 * Receipt digests are evidence references, not cryptographic proof or permission.
 * The future sole transport owner must validate source receipts before confirm().
 */
export class EnrollmentJournal {
  private db: Database.Database;
  constructor(
    path: string,
    private vault: Vault,
    private assertCurrent: () => void,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS enrollment_operations(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
  }
  private read(id: string): Entry | undefined {
    const row = this.db
      .prepare("SELECT value FROM enrollment_operations WHERE id=?")
      .get(id) as { value: Buffer } | undefined;
    return (
      row && this.vault.open<Entry>(row.value, "enrollment-operation:" + id)
    );
  }
  inspect(raw: EnrollmentOperationBinding): Entry | undefined {
    const binding = bindingSchema.parse(raw);
    this.assertCurrent();
    const row = this.read(binding.operationId);
    if (
      row &&
      (row.epoch !== binding.epoch ||
        row.kind !== binding.kind ||
        row.requestDigest !== binding.requestDigest)
    )
      throw Error("Enrollment operation binding mismatch");
    return row;
  }
  reserve(raw: EnrollmentOperationBinding): void {
    const binding = bindingSchema.parse(raw);
    this.db
      .transaction(() => {
        this.assertCurrent();
        if (this.inspect(binding))
          throw Error("Existing operation requires reconciliation, not replay");
        const count = this.db
          .prepare("SELECT count(*) AS n FROM enrollment_operations")
          .get() as { n: number };
        if (count.n >= 1000)
          throw Error("Enrollment journal requires retention review");
        const row: Entry = { ...binding, state: "reserved" };
        this.db
          .prepare("INSERT INTO enrollment_operations VALUES(?,?)")
          .run(
            row.operationId,
            this.vault.seal(row, "enrollment-operation:" + row.operationId),
          );
      })
      .immediate();
  }
  confirm(
    raw: EnrollmentOperationBinding,
    verifiedResponseDigest: string,
  ): void {
    const responseDigest = digest.parse(verifiedResponseDigest);
    this.db
      .transaction(() => {
        const row = this.inspect(raw);
        if (!row) throw Error("Enrollment operation was not reserved");
        if (row.state === "confirmed") {
          if (row.responseDigest !== responseDigest)
            throw Error("Conflicting enrollment receipt");
          return;
        }
        const confirmed: Entry = { ...row, state: "confirmed", responseDigest };
        this.db
          .prepare("UPDATE enrollment_operations SET value=? WHERE id=?")
          .run(
            this.vault.seal(
              confirmed,
              "enrollment-operation:" + row.operationId,
            ),
            row.operationId,
          );
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
