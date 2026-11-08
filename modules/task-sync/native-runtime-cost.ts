import Database from "better-sqlite3";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { Vault } from "../storage/vault.js";

const microUSD = z.int().min(1).max(1000000);
const channels = [
  "enrollment",
  "central",
  "assignment",
  "attestation",
] as const;
export type NativeCostChannel = (typeof channels)[number];
/** This is an operator-reviewed price ceiling, not inferred provider pricing or
 * authority. Per-wire ceilings plus any independently verified fixed shared
 * reservation must cover ALL downstream resources. Nothing is discounted by
 * default; a shared reservation requires its own exact resource/time evidence.
 * A single approval is shared by setup, central, assignment and attester calls.
 * Its ID identifies the actual owner approval, never a fresh worker/run epoch. */
export const nativeRuntimeCostApproval = z
  .strictObject({
    approvalId: z.string().min(1).max(128),
    reference: z.string().min(1).max(1024),
    pricingReference: z.string().min(1).max(1024),
    authorizedAt: z.int().positive(),
    authorizationExpiresAt: z.int().positive(),
    providers: z.tuple([z.literal("neon"), z.literal("vercel")]),
    approvedAt: z.int().positive(),
    expiresAt: z.int().positive(),
    maximumMicroUSD: z.int().min(1).max(10000000),
    maximumAttempts: z.int().min(1).max(240),
    sharedResourceReservation: z
      .strictObject({
        provider: z.literal("neon"),
        resourceId: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,255}$/),
        reference: z.string().min(1).max(1024),
        maximumMicroUSD: z.int().min(1).max(10000000),
        coversFrom: z.int().positive(),
        coversUntil: z.int().positive(),
      })
      .optional(),
    ceilings: z.strictObject({
      enrollment: microUSD,
      central: microUSD,
      assignment: microUSD,
      attestation: microUSD,
    }),
  })
  .refine(
    (r) =>
      r.expiresAt > r.approvedAt &&
      r.expiresAt - r.approvedAt <= 14400000 &&
      r.authorizationExpiresAt > r.authorizedAt &&
      r.authorizationExpiresAt - r.authorizedAt <= 86400000 &&
      r.approvedAt >= r.authorizedAt &&
      r.expiresAt <= r.authorizationExpiresAt &&
      channels.every(
        (c) =>
          r.ceilings[c] + (r.sharedResourceReservation?.maximumMicroUSD ?? 0) <=
          r.maximumMicroUSD,
      ) &&
      (!r.sharedResourceReservation ||
        (r.sharedResourceReservation.coversFrom === r.approvedAt &&
          r.sharedResourceReservation.coversUntil >= r.expiresAt &&
          r.sharedResourceReservation.coversUntil <= r.expiresAt + 900000)),
    "One bounded funding window of at most four hours and aggregate price ceilings required",
  );
export type NativeRuntimeCostApproval = z.infer<
  typeof nativeRuntimeCostApproval
>;
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const stateSchema = z.strictObject({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  attempts: z.int().min(0).max(240),
  reservedMicroUSD: z.int().min(0).max(10000000),
  sharedReservedMicroUSD: z.int().min(0).max(10000000).optional(),
  lastAt: z.int().positive(),
  held: z.string().min(1).max(128).nullable(),
});

/** Native-only durable reservations before DNS. Separate helper instances and
 * restarts share the same encrypted aggregate; failed/uncertain attempts retain
 * their full reservation. No refund/reset/replacement API. Opening a ledger or
 * writing a review creates no source grant, spending approval or model access. */
export class NativeRuntimeCostBudget {
  private readonly review: NativeRuntimeCostApproval;
  private readonly reviewHash: string;
  private readonly path: string;
  constructor(
    directory: string,
    private vault: Vault,
    review: unknown,
    private admitted: () => void,
    private now = Date.now,
  ) {
    if (!isAbsolute(directory))
      throw Error("Absolute native cost directory required");
    this.review = nativeRuntimeCostApproval.parse(review);
    this.reviewHash = hash(this.review);
    this.path = join(directory, "native-runtime-cost.db");
    this.assertCurrent();
  }
  private assertCurrent() {
    this.admitted();
    const at = this.now();
    if (
      !Number.isSafeInteger(at) ||
      at < this.review.approvedAt ||
      at >= this.review.expiresAt
    )
      throw Error("Native aggregate cost approval expired or unavailable");
    return at;
  }
  reserve(channel: NativeCostChannel) {
    const at = this.assertCurrent();
    if (!channels.includes(channel))
      throw Error("Native cost channel rejected");
    const check = (path: string, optional = false) => {
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
          throw Error("Protected aggregate native cost ledger required");
      } catch (e) {
        if (!optional || (e as NodeJS.ErrnoException).code !== "ENOENT")
          throw e;
      }
    };
    try {
      const fd = openSync(this.path, "wx", 0o600);
      closeSync(fd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    check(this.path);
    check(this.path + "-wal", true);
    check(this.path + "-shm", true);
    const db = new Database(this.path);
    try {
      db.pragma("journal_mode=WAL");
      db.pragma("synchronous=FULL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,record BLOB NOT NULL)",
      );
      let failure: string | null = null;
      db.transaction(() => {
        this.assertCurrent();
        // The immutable owner-approval reference, not a caller's new epoch/ID,
        // identifies the funded allowance. Re-labelling the same approval fails.
        const id = hash(this.review.reference),
          aad = "native-runtime-cost:" + id;
        const row = db
          .prepare("SELECT record FROM approvals WHERE id=?")
          .get(id) as { record: Buffer } | undefined;
        const state = row
          ? stateSchema.parse(this.vault.open(row.record, aad))
          : {
              reviewHash: this.reviewHash,
              attempts: 0,
              // Reserve the FULL reviewed shared interval before the first
              // wire, even if this helper starts late or its reply is lost.
              // The interval never rolls forward on helper/run restart.
              reservedMicroUSD:
                this.review.sharedResourceReservation?.maximumMicroUSD ?? 0,
              sharedReservedMicroUSD:
                this.review.sharedResourceReservation?.maximumMicroUSD ?? 0,
              lastAt: at,
              held: null,
            };
        if (state.reviewHash !== this.reviewHash)
          throw Error(
            "Native aggregate cost approval cannot be replaced across helpers or epochs",
          );
        if (
          state.attempts > this.review.maximumAttempts ||
          state.reservedMicroUSD > this.review.maximumMicroUSD ||
          (state.sharedReservedMicroUSD ?? 0) !==
            (this.review.sharedResourceReservation?.maximumMicroUSD ?? 0) ||
          state.reservedMicroUSD < (state.sharedReservedMicroUSD ?? 0)
        )
          throw Error("Native aggregate cost continuity invalid");
        failure =
          state.held ||
          (at < state.lastAt
            ? "Native cost clock continuity lost"
            : state.attempts >= this.review.maximumAttempts
              ? "Native aggregate request budget exhausted"
              : state.reservedMicroUSD + this.review.ceilings[channel] >
                  this.review.maximumMicroUSD
                ? "Native aggregate spending budget exhausted"
                : null);
        if (failure) state.held = failure;
        else {
          state.attempts++;
          state.reservedMicroUSD += this.review.ceilings[channel];
          state.lastAt = at;
        }
        db.prepare(
          "INSERT INTO approvals VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        ).run(id, this.vault.seal(state, aad));
      }).immediate();
      if (failure) throw Error(failure);
    } finally {
      db.close();
    }
  }
}
