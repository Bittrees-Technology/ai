import { z } from "zod";
import { StoreError, type Store, type Owner } from "./store.js";
import type { Vault } from "./vault.js";
import {
  prepareMemoryCandidates,
  readMemoryCandidates,
} from "../memory/candidates.js";
const request = z.strictObject({
  expectedRevision: z.number().int().positive(),
  modelProfileId: z.string().min(1).max(128),
  invocationId: z.uuid(),
  confirmed: z.literal(true),
});
type Binding = {
  parentId: string;
  parentRevision: number;
  sourceHash: string;
  promptVersion: number;
};
/** Only this boundary creates extraction bindings; generic task tags confer no authority. */
export class MemoryExtractions {
  constructor(
    private store: Store,
    private vault: Vault,
  ) {}
  private purpose(owner: Owner, id: string) {
    return JSON.stringify([
      "memory-extraction",
      owner.tenantId,
      owner.userId,
      id,
    ]);
  }
  private binding(owner: Owner, id: string) {
    this.store.get(owner, id);
    const row = this.store.db
      .prepare("SELECT payload FROM memory_extractions WHERE task_id=?")
      .get(id) as { payload: Buffer } | undefined;
    return row
      ? this.vault.open<Binding>(row.payload, this.purpose(owner, id))
      : null;
  }
  /** Recorded provenance only; callers must check the parent's current access. */
  dependency(owner: Owner, id: string) {
    const value = this.binding(owner, id);
    return value
      ? { parentId: value.parentId, parentRevision: value.parentRevision }
      : null;
  }
  private source(
    owner: Owner,
    id: string,
    revision: number,
    checkAccess?: () => void,
  ) {
    checkAccess?.();
    const parent = this.store.get(owner, id);
    const result = z
      .object({ text: z.string().min(1) })
      .safeParse(parent.result);
    if (
      parent.status !== "completed" ||
      parent.revision !== revision ||
      (!checkAccess &&
        (parent.input.sourceRefs.length ||
          this.store.sourceBinding(owner, id))) ||
      this.binding(owner, id) ||
      !result.success
    )
      throw new StoreError("CONFLICT");
    return { requestText: parent.input.prompt, resultText: result.data.text };
  }
  create(
    owner: Owner,
    parentId: string,
    raw: unknown,
    checkAccess?: () => void,
  ) {
    const input = request.parse(raw);
    return this.store.db
      .transaction(() => {
        const source = this.source(
          owner,
          parentId,
          input.expectedRevision,
          checkAccess,
        );
        const prepared = prepareMemoryCandidates(source);
        this.store.profile(owner, input.modelProfileId);
        const key = "memory-candidates:" + input.invocationId;
        const prior = this.store.db
          .prepare(
            "SELECT task_id FROM idempotency WHERE user_id=? AND tenant_id=? AND key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          { task_id: string } | undefined;
        const expected: Binding = {
          parentId,
          parentRevision: input.expectedRevision,
          sourceHash: prepared.sourceHash,
          promptVersion: prepared.promptVersion,
        };
        if (
          prior &&
          JSON.stringify(this.binding(owner, prior.task_id)) !==
            JSON.stringify(expected)
        )
          throw new StoreError("CONFLICT");
        const task = this.store.create(
          owner,
          {
            conversationId: input.invocationId,
            kind: "query",
            prompt: prepared.prompt,
            modelProfileId: input.modelProfileId,
          },
          key,
        );
        if (prior) return task;
        this.store.db
          .prepare("INSERT INTO memory_extractions VALUES(?,?)")
          .run(
            task.id,
            this.vault.seal(expected, this.purpose(owner, task.id)),
          );
        const count = this.store.db
          .prepare(
            "SELECT count(*) AS n FROM memory_extractions m JOIN tasks t ON t.id=m.task_id WHERE t.user_id=? AND t.tenant_id=? AND t.status NOT IN ('completed','failed','cancelled','expired')",
          )
          .get(owner.userId, owner.tenantId) as { n: number };
        if (count.n > 20) throw new StoreError("CAPACITY");
        return task;
      })
      .immediate();
  }
  export(owner: Owner) {
    const rows = this.store.db
      .prepare(
        `SELECT m.task_id FROM memory_extractions m JOIN tasks t ON t.id=m.task_id WHERE t.user_id=? AND t.tenant_id=? ORDER BY t.created_at,t.id`,
      )
      .all(owner.userId, owner.tenantId) as { task_id: string }[];
    // Historical export must survive failed work and future prompt revisions.
    // It exports recorded provenance, never a fresh execution permission.
    return rows.map(({ task_id }) => ({
      taskId: task_id,
      ...this.binding(owner, task_id)!,
      runs: this.store.runHistory(owner, task_id),
    }));
  }
  review(owner: Owner, id: string, checkAccess?: () => void) {
    const context = this.context(owner, id, checkAccess);
    const task = this.store.get(owner, id);
    if (!context || task.status !== "completed")
      throw new StoreError("CONFLICT");
    const result = readMemoryCandidates(
      task.result,
      context.source,
      context.sourceHash,
    );
    return {
      taskId: id,
      revision: task.revision,
      parentId: context.parentId,
      parentRevision: context.parentRevision,
      ...result,
    };
  }
  context(owner: Owner, id: string, checkAccess?: () => void) {
    const binding = this.binding(owner, id);
    if (!binding) return null;
    const source = this.source(
      owner,
      binding.parentId,
      binding.parentRevision,
      checkAccess,
    );
    const prepared = prepareMemoryCandidates(source);
    const task = this.store.get(owner, id);
    if (
      prepared.sourceHash !== binding.sourceHash ||
      prepared.promptVersion !== binding.promptVersion ||
      task.input.prompt !== prepared.prompt ||
      task.input.sourceRefs.length ||
      task.input.memoryIds?.length
    )
      throw new StoreError("CONFLICT");
    return { ...binding, source };
  }
}
