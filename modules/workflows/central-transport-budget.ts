import Database from "better-sqlite3";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import { Vault } from "../storage/vault.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const shared = {
  epoch: z.uuid(),
  approvedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  maximumAttempts: z.number().int().min(1).max(108),
  evidenceId: z.string().min(1).max(128),
};
export const centralBudgetReviewSchema = z.discriminatedUnion("costBasis", [
  z.strictObject({
    ...shared,
    costBasis: z.literal("verified-included-usage"),
    maximumMicroUSD: z.literal(0),
    attemptCeilingMicroUSD: z.literal(0),
  }),
  z.strictObject({
    ...shared,
    costBasis: z.literal("explicit-one-time-approval"),
    maximumMicroUSD: z.number().int().min(1).max(1000000),
    attemptCeilingMicroUSD: z.number().int().min(1).max(1000000),
  }),
]);
export type CentralBudgetReview = z.infer<typeof centralBudgetReviewSchema>;
type State = {
  reviewHash: string;
  requests: string[];
  reservedMicroUSD: number;
};
/** Native owner must independently establish each attempted request's maximum
 * aggregate downstream cost before supplying this review. The evidenceId alone
 * is not cost evidence or authorization. Reserve full worst-case cost before DNS;
 * failed/uncertain requests consume the reservation and are never refunded.
 */
export class CentralTransportBudget {
  private db: Database.Database;
  private readonly review: CentralBudgetReview;
  private readonly reviewHash: string;
  private closed = false;
  constructor(
    path: string,
    private vault: Vault,
    private current: () => CentralBudgetReview | null,
    private guard: () => void,
    private now = Date.now,
  ) {
    this.review = centralBudgetReviewSchema.parse(current());
    this.reviewHash = hash(this.review);
    this.assertCurrent();
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS central_native_budgets(epoch TEXT PRIMARY KEY,value BLOB NOT NULL)",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private assertCurrent() {
    this.guard();
    const review = centralBudgetReviewSchema.parse(this.current()),
      time = this.now();
    if (
      this.closed ||
      hash(review) !== this.reviewHash ||
      !Number.isSafeInteger(time) ||
      time < review.approvedAt ||
      time >= review.expiresAt ||
      review.expiresAt - review.approvedAt > 3600000
    )
      throw Error("Central native budget expired, revoked or changed");
  }
  reserve = (raw: {
    epoch: string;
    requestId: string;
    operationId: string;
  }) => {
    this.assertCurrent();
    const input = z
      .strictObject({
        epoch: z.uuid(),
        requestId: z.uuid(),
        operationId: z.uuid(),
      })
      .parse(raw);
    if (input.epoch !== this.review.epoch)
      throw Error("Central native budget epoch mismatch");
    this.db.transaction(() => {
      this.assertCurrent();
      const row = this.db
        .prepare("SELECT value FROM central_native_budgets WHERE epoch=?")
        .get(input.epoch) as { value: Buffer } | undefined;
      const state: State = row
        ? this.vault.open(row.value, "central-native-budget:" + input.epoch)
        : { reviewHash: this.reviewHash, requests: [], reservedMicroUSD: 0 };
      if (
        state.reviewHash !== this.reviewHash ||
        state.requests.includes(input.requestId)
      )
        throw Error(
          "Central native request already reserved or review changed",
        );
      if (
        state.requests.length >= this.review.maximumAttempts ||
        state.reservedMicroUSD + this.review.attemptCeilingMicroUSD >
          this.review.maximumMicroUSD
      )
        throw Error("Central native request or spending budget exhausted");
      state.requests.push(input.requestId);
      state.reservedMicroUSD += this.review.attemptCeilingMicroUSD;
      this.db
        .prepare(
          "INSERT OR REPLACE INTO central_native_budgets(epoch,value) VALUES(?,?)",
        )
        .run(
          input.epoch,
          this.vault.seal(state, "central-native-budget:" + input.epoch),
        );
    })();
  };
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
