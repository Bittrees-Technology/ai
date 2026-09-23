import { z } from "zod";
import type { AccessCheck, MemoryStore } from "../../modules/memory/store.js";
import { Store, StoreError, type Owner } from "../../modules/storage/store.js";

const usedMemories = z.object({
  memories: z
    .array(
      z.object({
        id: z.string(),
        revision: z.number().int().positive(),
      }),
    )
    .max(8),
});

/** Synchronous, bounded local provenance walk: no network, content copy or authority widening. */
export function localTaskDependencies(
  store: Store,
  owner: Owner,
  taskId: string,
  memory?: MemoryStore,
): boolean {
  const visiting = new Set<string>(),
    checked = new Set<string>();
  let remaining = 1000;
  const taskToken = store.changeToken(),
    memoryToken = memory?.changeToken();
  const source = (
    ref: {
      app: string;
      tenantId: string;
      resourceId: string;
      revision: string;
    },
    depth: number,
  ): boolean => {
    if (ref.app !== "local" || ref.tenantId !== owner.tenantId) return false;
    const task = store.get(owner, ref.resourceId);
    return (
      task.status === "completed" &&
      String(task.revision) === ref.revision &&
      task.input.sourceRefs.length === 0 &&
      !store.sourceBinding(owner, task.id) &&
      walk(task.id, depth)
    );
  };
  const walk = (id: string, depth: number): boolean => {
    if (depth > 64 || --remaining < 0 || visiting.has(id)) return false;
    if (checked.has(id)) return true;
    visiting.add(id);
    const task = store.get(owner, id);
    const extraction = store.memoryExtractions.dependency(owner, id);
    if (
      extraction &&
      !source(
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: extraction.parentId,
          revision: String(extraction.parentRevision),
        },
        depth + 1,
      )
    )
      return false;
    const ids = task.input.memoryIds ?? [];
    if (ids.length) {
      if (!memory) return false;
      const run = store.runHistory(owner, id).at(-1);
      const recorded = usedMemories.safeParse(run?.model);
      // Completed results need exact versions recorded by the worker. Queued work
      // has not consumed a version yet, so it checks the current approved memory.
      if (
        (task.status === "completed" || run?.model != null) &&
        !recorded.success
      )
        return false;
      const versions = recorded.success ? recorded.data.memories : null;
      if (
        versions &&
        (versions.length !== ids.length ||
          new Set(versions.map((v) => v.id)).size !== ids.length ||
          versions.some((v) => !ids.includes(v.id)))
      )
        return false;
      for (const memoryId of ids) {
        const revision = versions?.find((v) => v.id === memoryId)?.revision;
        for (const ref of memory.dependencySources(owner, memoryId, revision))
          if (!source(ref, depth + 1)) return false;
      }
    }
    visiting.delete(id);
    checked.add(id);
    return true;
  };
  try {
    return (
      walk(taskId, 0) &&
      taskToken === store.changeToken() &&
      memoryToken === memory?.changeToken()
    );
  } catch (error) {
    if (error instanceof StoreError && error.code === "NOT_FOUND") return false;
    throw error;
  }
}

/** Personal pilot: completed, unchanged local tasks and all their local dependencies. */
export function localMemoryAccess(
  store: Store,
  memory?: () => MemoryStore | undefined,
): AccessCheck {
  const current: NonNullable<AccessCheck["current"]> = (owner, sources) =>
    sources.every((source) => {
      if (source.app !== "local" || source.tenantId !== owner.tenantId)
        return false;
      try {
        const task = store.get(owner, source.resourceId);
        return (
          task.status === "completed" &&
          task.input.sourceRefs.length === 0 &&
          !store.sourceBinding(owner, task.id) &&
          String(task.revision) === source.revision &&
          localTaskDependencies(store, owner, task.id, memory?.())
        );
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return false;
        throw error;
      }
    });
  return Object.assign(
    async (owner: Owner, sources: Parameters<AccessCheck>[1]) =>
      current(owner, sources),
    { current },
  );
}
