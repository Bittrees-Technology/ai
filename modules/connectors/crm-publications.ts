import { z } from "zod";
import { Store, StoreError, type Owner } from "../storage/store.js";
import { CrmConnector } from "./crm.js";
import { CrmTasks } from "./crm-tasks.js";
import type { CrmPrepared, CrmReceipt } from "./crm-write-contracts.js";
const editSchema = z.strictObject({
  operationId: z.uuid(),
  targetId: z.uuid(),
  permissionEpoch: z.uuid(),
  kind: z.enum(["notes", "tasks"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  dueDate: z.union([z.iso.date(), z.literal("")]),
});
/** Trusted orchestration only. Source approval is never represented as a local boolean. */
export class CrmPublications {
  private active = new Set<string>();
  constructor(
    private store: Store,
    private owner: Owner,
    private connector: CrmConnector,
    private sources: CrmTasks,
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
  async permission(taskId: string) {
    const binding = this.store.sourceBinding(this.owner, taskId);
    if (!binding) throw new StoreError("INVALID_INPUT");
    await this.sources.validate(binding);
    return this.connector.writeStatus(binding.authority.grantId);
  }
  async reserve(taskId: string, raw: unknown) {
    const edit = editSchema.parse(raw);
    return this.exclusive(edit.operationId, async () => {
      const binding = this.store.sourceBinding(this.owner, taskId);
      if (!binding) throw new StoreError("INVALID_INPUT");
      await this.sources.validate(binding);
      const permission = await this.connector.writeStatus(
        binding.authority.grantId,
      );
      if (
        permission.targetId !== edit.targetId ||
        permission.epoch !== edit.permissionEpoch
      )
        throw new StoreError("CONFLICT");
      if (!permission.kinds.includes(edit.kind))
        throw new StoreError("INVALID_INPUT");
      const { permissionEpoch: _epoch, ...proposal } = edit;
      return this.store.reservePublication(this.owner, taskId, {
        ...proposal,
        targetId: permission.targetId,
        sources: binding.refs.map((r) => ({
          id: r.resourceId,
          version: Number(r.revision),
        })),
        projectionHash: binding.projectionHash,
      });
    });
  }
  async prepare(id: string) {
    return this.exclusive(id, async () => {
      const item = this.store.publication(this.owner, id);
      if (item.prepared || item.receipt) return item;
      let prepared: CrmPrepared;
      try {
        prepared = await this.connector.prepareWrite(
          item.grantId,
          item.proposal,
        );
      } catch (error) {
        this.store.settlePublication(this.owner, id, item.revision, {
          uncertain: true,
        });
        throw error;
      }
      return this.store.settlePublication(this.owner, id, item.revision, {
        prepared: {
          reviewId: prepared.reviewId,
          digest: prepared.digest,
          expiresAt: prepared.expiresAt,
        },
      });
    });
  }
  async publish(id: string) {
    return this.exclusive(id, async () => {
      const item = this.store.publication(this.owner, id);
      if (item.receipt) return item;
      if (!item.prepared) throw new StoreError("INVALID_INPUT");
      let receipt: CrmReceipt;
      try {
        // Reconcile a previously committed receipt even if the source content changed later.
        receipt = await this.connector.publishWrite(item.grantId, {
          reviewId: item.prepared.reviewId,
          digest: item.prepared.digest,
        });
      } catch (error) {
        this.store.settlePublication(this.owner, id, item.revision, {
          uncertain: true,
        });
        throw error;
      }
      return this.store.settlePublication(this.owner, id, item.revision, {
        receipt,
      });
    });
  }
}
