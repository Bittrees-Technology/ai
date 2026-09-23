import { z } from "zod";
import { StoreError, type Store, type Owner } from "./store.js";
import type { Vault } from "./vault.js";

const review = z.strictObject({
  outcome: z.enum(["accepted", "edited", "rejected"]),
  note: z.string().trim().max(2000),
});
const request = z.strictObject({
  expectedTaskRevision: z.number().int().positive(),
  runId: z.string().min(1).max(128),
  expectedReviewRevision: z.number().int().nonnegative(),
  operationId: z.uuid(),
  review: review.nullable(),
  confirmed: z.literal(true),
});
type Entry = {
  taskRevision: number;
  runId: string;
  resultFingerprint: string;
  operationFingerprint: string;
  operationId: string;
  review: z.infer<typeof review> | null;
  updatedAt: number;
};
/** Human reports only. No model callable, authorization, training or scoring hooks. */
export class TaskFeedback {
  constructor(
    private store: Store,
    private vault: Vault,
    private now: () => number,
  ) {}
  private purpose(owner: Owner, id: string) {
    return JSON.stringify(["task-feedback", owner.tenantId, owner.userId, id]);
  }
  private record(owner: Owner, id: string) {
    this.store.get(owner, id);
    const row = this.store.db
      .prepare("SELECT revision,payload FROM task_feedback WHERE task_id=?")
      .get(id) as { revision: number; payload: Buffer } | undefined;
    return row
      ? {
          revision: row.revision,
          value: this.vault.open<Entry>(row.payload, this.purpose(owner, id)),
        }
      : null;
  }
  private snapshot(owner: Owner, id: string) {
    const task = this.store.get(owner, id);
    const run = this.store.runHistory(owner, id).at(-1);
    if (
      task.status !== "completed" ||
      task.result == null ||
      !run ||
      run.outcome !== "completed" ||
      !run.model ||
      run.finished_at === null
    )
      throw new StoreError("CONFLICT");
    return {
      task,
      run,
      resultFingerprint: this.vault.fingerprint(task.result),
    };
  }
  read(owner: Owner, id: string) {
    const snapshot = this.snapshot(owner, id),
      previous = this.record(owner, id);
    if (
      previous &&
      (previous.value.taskRevision !== snapshot.task.revision ||
        previous.value.runId !== snapshot.run.id ||
        previous.value.resultFingerprint !== snapshot.resultFingerprint)
    )
      throw new StoreError("CONFLICT");
    return {
      taskId: id,
      taskRevision: snapshot.task.revision,
      runId: snapshot.run.id,
      model: snapshot.run.model,
      durationMs: Math.max(
        0,
        snapshot.run.finished_at! - snapshot.run.started_at,
      ),
      reviewRevision: previous?.revision ?? 0,
      review: previous?.value.review ?? null,
      updatedAt: previous?.value.updatedAt ?? null,
    };
  }
  save(owner: Owner, id: string, raw: unknown) {
    const input = request.parse(raw);
    return this.store.db
      .transaction(() => {
        const current = this.read(owner, id);
        if (
          current.taskRevision !== input.expectedTaskRevision ||
          current.runId !== input.runId
        )
          throw new StoreError("CONFLICT");
        const fingerprint = this.vault.fingerprint(input),
          previous = this.record(owner, id);
        // Exact lost-response retries return the same review; they never add votes.
        if (previous?.value.operationFingerprint === fingerprint)
          return current;
        if (previous?.value.operationId === input.operationId)
          throw new StoreError("CONFLICT");
        if (input.expectedReviewRevision !== current.reviewRevision)
          throw new StoreError("CONFLICT");
        const entry: Entry = {
          taskRevision: current.taskRevision,
          runId: current.runId,
          resultFingerprint: this.snapshot(owner, id).resultFingerprint,
          operationFingerprint: fingerprint,
          operationId: input.operationId,
          review: input.review,
          updatedAt: this.now(),
        };
        this.store.db
          .prepare(
            "INSERT INTO task_feedback(task_id,revision,payload) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
          )
          .run(
            id,
            current.reviewRevision + 1,
            this.vault.seal(entry, this.purpose(owner, id)),
          );
        return this.read(owner, id);
      })
      .immediate();
  }
  exportTask(owner: Owner, id: string) {
    const previous = this.record(owner, id);
    return previous?.value.review ? this.read(owner, id) : null;
  }
  /** Bulk export omits connected-source reviews; their task export checks live access. */
  exportLocal(owner: Owner) {
    const rows = this.store.db
      .prepare(
        "SELECT f.task_id FROM task_feedback f JOIN tasks t ON t.id=f.task_id WHERE t.user_id=? AND t.tenant_id=? ORDER BY f.task_id",
      )
      .all(owner.userId, owner.tenantId) as { task_id: string }[];
    return rows.flatMap(({ task_id }) => {
      const task = this.store.get(owner, task_id);
      if (
        task.input.sourceRefs.length ||
        this.store.sourceBinding(owner, task_id)
      )
        return [];
      const value = this.read(owner, task_id);
      return value.review ? [value] : [];
    });
  }
}
