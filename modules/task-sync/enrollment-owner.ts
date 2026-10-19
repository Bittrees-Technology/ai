import { EnrollmentBroker } from "./enrollment-broker.js";
import {
  EnrollmentTransportPlan,
  type EnrollmentReview,
} from "./enrollment-transport-plan.js";

type Session = {
  execute(raw: unknown, signal: AbortSignal): Promise<unknown>;
  close(): void;
};
/** Inactive native lifecycle for a review already approved by the owner surface.
 * Does not obtain consent, create authority, renew reviews or register startup.
 * The factory and current-authority callback must come from trusted native code.
 */
export class EnrollmentOwner {
  private readonly review: EnrollmentReview;
  private readonly abort = new AbortController();
  private readonly planner: EnrollmentTransportPlan;
  private readonly session: Session;
  private readonly broker: EnrollmentBroker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private pending = new Set<Promise<unknown>>();
  private stopped = false;
  private closing?: Promise<void>;
  constructor(
    review: EnrollmentReview,
    currentAuthority: () => EnrollmentReview | null,
    token: string,
    factory: (current: () => EnrollmentReview | null) => Session,
    now = Date.now,
  ) {
    this.review = Object.freeze({ ...review });
    // Compare current trusted authority to the original review, including its deadline.
    const initial = new EnrollmentTransportPlan(() => this.review, now);
    this.planner = new EnrollmentTransportPlan(currentAuthority, now);
    const current = () => {
      if (this.stopped) return null;
      try {
        initial.assertCurrent();
        const live = this.planner.assertCurrent();
        for (const key of [
          "epoch",
          "expiresAt",
          "authorityId",
          "deviceId",
          "sourceWorkspace",
          "principal",
          "publicKey",
          "ownerWallet",
        ] as const)
          if (live[key] !== this.review[key])
            throw Error("Owner review changed");
        return this.review;
      } catch {
        this.revoke();
        return null;
      }
    };
    // Validate before opening the encrypted session or reserving any operation.
    if (!current()) throw Error("Current enrollment authority required");
    this.session = factory(current);
    const endpointSession = {
      execute: (raw: unknown, signal: AbortSignal) => {
        if (!current()) return Promise.reject(Error("Enrollment owner closed"));
        const combined = AbortSignal.any([signal, this.abort.signal]);
        const work = Promise.resolve()
          .then(() => {
            combined.throwIfAborted();
            if (!current()) throw Error("Enrollment authority changed");
            return this.session.execute(raw, combined);
          })
          .then((value) => {
            combined.throwIfAborted();
            if (!current()) throw Error("Enrollment authority changed");
            return value;
          });
        this.pending.add(work);
        void work.then(
          () => this.pending.delete(work),
          () => this.pending.delete(work),
        );
        return work;
      },
    };
    try {
      this.broker = new EnrollmentBroker(token, () =>
        current() ? endpointSession : null,
      );
    } catch (error) {
      this.session.close();
      throw error;
    }
    this.timer = setTimeout(
      () => this.revoke(),
      Math.max(0, review.expiresAt - now()),
    );
    this.timer.unref();
  }
  async listen() {
    if (this.stopped) throw Error("Enrollment owner closed");
    try {
      return await this.broker.listen();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  /** Synchronous denial/cancellation; close then drains work before releasing storage. */
  revoke() {
    this.stopped = true;
    this.abort.abort(Error("Enrollment owner revoked or expired"));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.revoke();
    clearTimeout(this.timer);
    this.closing = (async () => {
      await this.broker.close();
      await Promise.allSettled([...this.pending]);
      this.session.close();
    })();
    return this.closing;
  }
}
