import { createHash, randomUUID } from "node:crypto";
import type { AutoNoteApprovalConnector } from "./autonote-approval.js";
import type { AutoNoteExactReview } from "./autonote-review-contracts.js";
import { z } from "zod";
import { Store, StoreError, type Owner } from "../storage/store.js";
import { AutoNoteConnector } from "./autonote.js";
import { AutoNoteTasks } from "./autonote-tasks.js";
import { autoNoteProposalSchema } from "./autonote-review-contracts.js";
/** Immutable drafts and explicit exact approval with durable uncertain outcomes. */
export class AutoNoteReviews {
  private active = new Set<string>();
  private approvalPreparing = new Map<string, { cancelled: boolean }>();
  private approvalReviews = new Map<
    string,
    {
      id: string;
      revision: number;
      approvalId: string;
      detail: AutoNoteExactReview;
      started: number;
      mono: number;
      expires: number;
      cancelled: boolean;
      used: boolean;
    }
  >();
  constructor(
    private store: Store,
    private owner: Owner,
    private connector: AutoNoteConnector,
    private sources: AutoNoteTasks,
    private approval?: AutoNoteApprovalConnector,
  ) {}
  get busy() {
    return this.active.size > 0;
  }
  private async exclusive<T>(id: string, fn: () => Promise<T>) {
    if (this.active.has(id)) throw new StoreError("CONFLICT");
    this.active.add(id);
    try {
      return await fn();
    } finally {
      this.active.delete(id);
    }
  }
  cancelApproval(id: string) {
    const preparing = this.approvalPreparing.get(id);
    if (preparing) preparing.cancelled = true;
    for (const [token, review] of this.approvalReviews) {
      if (review.id === id) {
        review.cancelled = true;
        this.approvalReviews.delete(token);
      }
    }
    return { cancelled: true };
  }
  async reviewApproval(id: string) {
    return this.exclusive(id, async () => {
      this.cancelApproval(id);
      const preparing = { cancelled: false };
      this.approvalPreparing.set(id, preparing);
      try {
        if (
          !this.approval ||
          this.approvalReviews.size + this.approvalPreparing.size > 100
        )
          throw new StoreError("CAPACITY");
        const item = this.store.autoNoteReview(this.owner, id);
        if (
          item.state !== "prepared" ||
          !item.response ||
          item.response.receipt
        )
          throw new StoreError("CONFLICT");
        const binding = this.store.sourceBinding(this.owner, item.taskId);
        if (!binding) throw new StoreError("INVALID_INPUT");
        await this.sources.validate(binding);
        const inspected = await this.approval.inspect(
          item.grantId,
          item.response.reviewId,
        );
        if ("receipt" in inspected.detail) throw new StoreError("CONFLICT");
        const detail = inspected.detail;
        if (
          JSON.stringify(detail.proposal) !== JSON.stringify(item.proposal) ||
          detail.digest !== item.response.digest ||
          detail.expiresAt !== item.response.expiresAt ||
          createHash("sha256")
            .update(JSON.stringify(item.proposal))
            .digest("hex") !== detail.digest ||
          this.store.autoNoteReview(this.owner, id).revision !==
            item.revision ||
          this.store.get(this.owner, item.taskId).revision !== item.taskRevision
        )
          throw new StoreError("CONFLICT");
        const started = Date.now(),
          token = randomUUID(),
          expires = Math.min(
            started + 60000,
            Date.parse(detail.expiresAt),
            Date.parse(inspected.approvalExpiresAt),
          );
        if (expires <= started) throw new StoreError("CONFLICT");
        const review = {
          id,
          revision: item.revision,
          approvalId: inspected.approvalId,
          detail,
          started,
          mono: performance.now(),
          expires,
          cancelled: false,
          used: false,
        };
        inspected.check();
        if (preparing.cancelled) throw new StoreError("CONFLICT");
        this.approvalReviews.set(token, review);
        setTimeout(() => {
          review.cancelled = true;
          this.approvalReviews.delete(token);
        }, expires - started).unref();
        return {
          reviewToken: token,
          expiresAt: new Date(expires).toISOString(),
          approvalId: review.approvalId,
          detail,
        };
      } finally {
        this.approvalPreparing.delete(id);
      }
    });
  }
  async approve(id: string, raw: unknown) {
    const input = z
      .strictObject({
        reviewToken: z.uuid(),
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(id, async () => {
      const review = this.approvalReviews.get(input.reviewToken);
      if (!review || review.id !== id || review.used || !this.approval)
        throw new StoreError("CONFLICT");
      review.used = true;
      const guard = () => {
        const now = Date.now(),
          elapsed = performance.now() - review.mono;
        if (
          review.cancelled ||
          now < review.started ||
          now >= review.expires ||
          elapsed < 0 ||
          elapsed >= review.expires - review.started
        )
          throw new StoreError("CONFLICT");
        const item = this.store.autoNoteReview(this.owner, id);
        if (
          item.revision !== review.revision ||
          item.state !== "prepared" ||
          this.store.get(this.owner, item.taskId).revision !== item.taskRevision
        )
          throw new StoreError("CONFLICT");
        return item;
      };
      try {
        let item = guard();
        const binding = this.store.sourceBinding(this.owner, item.taskId);
        if (!binding) throw new StoreError("INVALID_INPUT");
        await this.sources.validate(binding);
        guard();
        const receipt = await this.approval.saveExact(
          item.grantId,
          review.approvalId,
          review.detail,
          () => {
            guard();
            item = this.store.markAutoNoteApprovalAttempt(
              this.owner,
              id,
              review.revision,
              {
                approvalId: review.approvalId,
                reviewedHash: createHash("sha256")
                  .update(JSON.stringify(review.detail))
                  .digest("hex"),
                requestedAt: new Date().toISOString(),
              },
            );
          },
        );
        return this.store.settleAutoNoteReview(this.owner, id, item.revision, {
          response: { ...item.response!, receipt, deleted: false },
        });
      } finally {
        review.cancelled = true;
        this.approvalReviews.delete(input.reviewToken);
      }
    });
  }
  async reserve(taskId: string, raw: unknown) {
    const { operationId } = z
      .strictObject({ operationId: z.uuid() })
      .parse(raw);
    return this.exclusive(operationId, async () => {
      const binding = this.store.sourceBinding(this.owner, taskId);
      if (!binding) throw new StoreError("INVALID_INPUT");
      await this.sources.validate(binding);
      const permission = await this.connector.reviewStatus(
        binding.authority.grantId,
      );
      if (!permission.enabled) throw new StoreError("INVALID_INPUT");
      const task = this.store.get(this.owner, taskId),
        result = task.result as {
          autonote?: { summary?: unknown; actions?: unknown };
        } | null;
      const item = z.object({
        text: z.string(),
        evidence: z.array(z.string()),
      });
      const draft = z
        .object({
          summary: z.array(item),
          actions: z.array(
            item.extend({
              owner: z.string().nullable(),
              dueDate: z.string().nullable(),
            }),
          ),
        })
        .parse(result?.autonote);
      const proposal = autoNoteProposalSchema.parse({
        operationId,
        meetingId: binding.refs[0]!.resourceId,
        version: Number(binding.refs[0]!.revision),
        projectionHash: binding.projectionHash,
        ...draft,
      });
      return this.store.reserveAutoNoteReview(this.owner, taskId, proposal);
    });
  }
  async prepare(id: string) {
    return this.exclusive(id, async () => {
      let item = this.store.autoNoteReview(this.owner, id);
      if (item.response || ["saved", "deleted"].includes(item.state))
        return item;
      const binding = this.store.sourceBinding(this.owner, item.taskId);
      if (!binding) throw new StoreError("INVALID_INPUT");
      await this.sources.validate(binding);
      // Persist uncertainty before dispatch. A crash or lost response cannot be labelled unsent.
      item = this.store.settleAutoNoteReview(this.owner, id, item.revision, {
        uncertain: true,
      });
      const { reviewUrl: _url, ...response } =
        await this.connector.prepareReview(item.grantId, item.proposal);
      return this.store.settleAutoNoteReview(this.owner, id, item.revision, {
        response: { ...response, deleted: false },
      });
    });
  }
  async reconcile(id: string) {
    return this.exclusive(id, async () => {
      let item = this.store.autoNoteReview(this.owner, id);
      if (["saved", "deleted"].includes(item.state)) return item;
      if (item.state === "local") throw new StoreError("INVALID_INPUT");
      item = this.store.settleAutoNoteReview(this.owner, id, item.revision, {
        uncertain: true,
      });
      // A saved receipt must survive source version changes caused by the save itself.
      const { reviewUrl: _url, ...response } =
        await this.connector.reconcileReview(item.grantId, item.proposal);
      return this.store.settleAutoNoteReview(this.owner, id, item.revision, {
        response,
      });
    });
  }
}
