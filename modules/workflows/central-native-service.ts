import { randomBytes } from "node:crypto";
import { CentralNativeControl } from "./central-native-control.js";
import { CentralNativeBroker } from "./central-native-broker.js";
import { CentralTransportPlan } from "./central-transport-plan.js";
import {
  CentralNativeOwner,
  centralNativeReviewSchema,
  centralReviewDigest,
  type CentralNativeReview,
  type CentralSession,
} from "./central-native-owner.js";
/** Unregistered native approval owner. These control methods must only be
 * exposed through a separate native capability, never through the core broker.
 * No sessions before exact approval, and no network/grant/credential on propose.
 */
export class CentralNativeService {
  private readonly coreToken = randomBytes(32).toString("hex");
  private readonly broker: CentralNativeBroker;
  private readonly nativeToken = randomBytes(32).toString("hex");
  private readonly control: CentralNativeControl;
  private proposal: CentralNativeReview | null = null;
  private approved: CentralNativeReview | null = null;
  private owner: CentralNativeOwner | null = null;
  private draining: Promise<void> | null = null;
  private held = false;
  private closed = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  constructor(
    private trustedReview: () => unknown,
    private admitted: () => boolean,
    private factory: (
      current: () => CentralNativeReview | null,
    ) => CentralSession,
    private now = Date.now,
  ) {
    this.control = new CentralNativeControl(
      this.nativeToken,
      this.coreToken,
      this,
    );
    this.broker = new CentralNativeBroker(this.coreToken, () =>
      this.current() ? this.owner : null,
    );
  }
  private read() {
    if (this.closed || this.held || !this.admitted())
      throw Error("Central native admission unavailable");
    const review = centralNativeReviewSchema.parse(this.trustedReview());
    new CentralTransportPlan(() => review.scope, this.now);
    return review;
  }
  propose() {
    if (this.owner || this.draining || this.approved)
      throw Error("Previous central native review must stop first");
    this.proposal = this.read();
    return {
      version: 1,
      purpose: "bounded-central-workflow-verification",
      digest: centralReviewDigest(this.proposal),
      review: centralNativeReviewSchema.parse(this.proposal),
    };
  }
  approve(digest: string) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !this.proposal ||
      this.owner ||
      this.draining ||
      this.approved
    )
      throw Error("Current native proposal required");
    const review = this.read();
    if (
      digest !== centralReviewDigest(this.proposal) ||
      digest !== centralReviewDigest(review)
    )
      throw Error("Central native proposal changed");
    this.approved = review;
    try {
      this.owner = new CentralNativeOwner(
        review,
        () => this.current(),
        this.factory,
        this.now,
      );
      this.proposal = null;
      this.expiry = setTimeout(
        () => {
          void this.revoke().catch(() => {});
        },
        Math.max(0, review.scope.expiresAt - this.now()),
      );
      this.expiry.unref();
      return { approved: true };
    } catch (error) {
      this.approved = null;
      this.owner = null;
      throw error;
    }
  }
  private current(): CentralNativeReview | null {
    if (!this.approved) return null;
    try {
      const live = this.read();
      if (centralReviewDigest(live) !== centralReviewDigest(this.approved))
        throw Error("Central native review changed");
      return centralNativeReviewSchema.parse(this.approved);
    } catch {
      void this.revoke().catch(() => {});
      return null;
    }
  }
  revoke(): Promise<void> {
    this.proposal = null;
    this.approved = null;
    clearTimeout(this.expiry);
    const owner = this.owner;
    this.owner = null;
    if (owner) {
      owner.revoke();
      this.draining = owner
        .close()
        .catch((error) => {
          this.held = true;
          throw error;
        })
        .finally(() => {
          this.draining = null;
        });
    }
    return this.draining ?? Promise.resolve();
  }
  async listen() {
    if (this.closed || this.held)
      throw Error("Central native service unavailable");
    try {
      const url = await this.control.listen();
      return {
        native: { url, token: this.nativeToken },
        core: { url: await this.broker.listen(), token: this.coreToken },
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const drain = this.revoke();
    this.closing = (async () => {
      const results = await Promise.allSettled([
        this.control.close(),
        this.broker.close(),
        drain,
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (this.held)
        throw Error("Central native storage requires reconciliation");
    })();
    return this.closing;
  }
}
