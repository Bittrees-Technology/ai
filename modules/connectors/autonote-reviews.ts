import { z } from "zod";
import { Store, StoreError, type Owner } from "../storage/store.js";
import { AutoNoteConnector } from "./autonote.js";
import { AutoNoteTasks } from "./autonote-tasks.js";
import { autoNoteProposalSchema } from "./autonote-review-contracts.js";
/** Durable immutable drafts; only AutoNote's source session can approve their save. */
export class AutoNoteReviews {
  private active = new Set<string>();
  constructor(
    private store: Store,
    private owner: Owner,
    private connector: AutoNoteConnector,
    private sources: AutoNoteTasks,
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
