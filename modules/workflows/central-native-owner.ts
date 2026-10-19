import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import {
  centralNativeScopeSchema,
  CentralTransportPlan,
} from "./central-transport-plan.js";
import { centralBudgetReviewSchema } from "./central-transport-budget.js";
export const centralNativeReviewSchema = z
  .strictObject({
    ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
    scope: centralNativeScopeSchema,
    budget: centralBudgetReviewSchema,
  })
  .superRefine((review, ctx) => {
    for (const field of ["epoch", "approvedAt", "expiresAt"] as const)
      if (review.scope[field] !== review.budget[field])
        ctx.addIssue({
          code: "custom",
          message: "Scope and budget review differ",
          path: ["budget", field],
        });
  });
export type CentralNativeReview = z.infer<typeof centralNativeReviewSchema>;
export const centralReviewDigest = (review: CentralNativeReview) =>
  createHash("sha256").update(canonical(review)).digest("hex");
export type CentralSession = {
  dispatch(raw: unknown, signal: AbortSignal): Promise<Uint8Array>;
  close(): void;
};
/** Lifecycle of an already approved native review. No consent, grants, sockets
 * or credentials are created by this class. Native service owns the IPC broker.
 */
export class CentralNativeOwner {
  private readonly review: CentralNativeReview;
  private readonly digest: string;
  private readonly abort = new AbortController();
  private readonly session: CentralSession;
  private readonly expiry: ReturnType<typeof setTimeout>;
  private pending = new Set<Promise<Uint8Array>>();
  private stopped = false;
  private closing?: Promise<void>;
  constructor(
    review: CentralNativeReview,
    current: () => CentralNativeReview | null,
    factory: (current: () => CentralNativeReview | null) => CentralSession,
    now = Date.now,
  ) {
    this.review = centralNativeReviewSchema.parse(review);
    this.digest = centralReviewDigest(this.review);
    const original = new CentralTransportPlan(() => this.review.scope, now);
    const active = () => {
      if (this.stopped) return null;
      try {
        original.assertCurrent();
        const live = centralNativeReviewSchema.parse(current());
        if (centralReviewDigest(live) !== this.digest)
          throw Error("Central native review changed");
        return centralNativeReviewSchema.parse(this.review);
      } catch {
        this.revoke();
        return null;
      }
    };
    if (!active()) throw Error("Current native review required");
    this.current = active;
    this.session = factory(active);
    this.expiry = setTimeout(
      () => this.revoke(),
      Math.max(0, this.review.scope.expiresAt - now()),
    );
    this.expiry.unref();
  }
  private current: () => CentralNativeReview | null;
  dispatch = (raw: unknown, signal: AbortSignal): Promise<Uint8Array> => {
    if (!this.current())
      return Promise.reject(Error("Central native owner unavailable"));
    const combined = AbortSignal.any([signal, this.abort.signal]);
    const work = Promise.resolve()
      .then(() => {
        combined.throwIfAborted();
        if (!this.current()) throw Error("Central native review changed");
        return this.session.dispatch(raw, combined);
      })
      .then((value) => {
        combined.throwIfAborted();
        if (!this.current()) throw Error("Central native review changed");
        return value;
      });
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  };
  revoke() {
    this.stopped = true;
    this.abort.abort(Error("Central native review revoked or expired"));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.revoke();
    clearTimeout(this.expiry);
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      this.session.close();
    })();
    return this.closing;
  }
}
