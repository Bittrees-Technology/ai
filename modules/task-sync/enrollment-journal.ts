import Database from "better-sqlite3";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  operationId: z.uuid(),
  epoch: z.string().min(1).max(200),
  kind: z.enum(["start", "complete"]),
  requestDigest: digest,
});
export type EnrollmentOperationBinding = z.infer<typeof bindingSchema>;
export function enrollmentOperationId(
  epoch: string,
  kind: "start" | "complete",
) {
  const id = createHash("sha256")
    .update(canonical({ epoch, kind }))
    .digest("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
}
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
  /** Only after the original authenticated poll has independently verified the
   * completed receipt. Preserve its mutation ID/body digest; no dispatch, new
   * reservation, budget refund or replacement completion is permitted here. */
  confirmCompletionRead(epoch: string, verifiedResponseDigest: string) {
    this.assertCurrent();
    const row = this.read(enrollmentOperationId(epoch, "complete"));
    if (!row || row.epoch !== epoch || row.kind !== "complete")
      throw Error("Original enrollment completion reservation required");
    this.confirm(
      {
        operationId: row.operationId,
        epoch: row.epoch,
        kind: row.kind,
        requestDigest: row.requestDigest,
      },
      verifiedResponseDigest,
    );
  }
  close() {
    this.db.close();
  }
}
