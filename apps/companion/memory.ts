import type { SourceBinding } from "../../modules/contracts/index.js";
import type { SourceTasks } from "../../modules/connectors/source-tasks.js";
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
  sourceAccess?: (taskId: string, binding: SourceBinding) => boolean,
): boolean {
  const visiting = new Set<string>(),
    checked = new Set<string>();
  let remaining = 1000;
  let destination = "local";
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
    const binding = store.sourceBinding(owner, task.id);
    const sourceAllowed = binding
      ? JSON.stringify(task.input.sourceRefs) ===
          JSON.stringify(binding.refs) && !!sourceAccess?.(task.id, binding)
      : task.input.sourceRefs.length === 0;
    return (
      task.status === "completed" &&
      String(task.revision) === ref.revision &&
      sourceAllowed &&
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
        for (const ref of memory.dependencySources(
          owner,
          memoryId,
          revision,
          destination,
        ))
          if (!source(ref, depth + 1)) return false;
      }
    }
    visiting.delete(id);
    checked.add(id);
    return true;
  };
  try {
    destination =
      store.sourceBinding(owner, taskId)?.authority.sourceApp ?? "local";
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

/** Fresh operation-scoped checks for the entire memory dependency graph.
 * The legacy synchronous walker remains local-only unless this function supplies
 * fresh source checks. A final fence never refreshes or inherits authority. */
export async function taskDependencyGuard(
  store: Store,
  owner: Owner,
  taskId: string,
  memory?: MemoryStore,
  sources?: Partial<Pick<SourceTasks, "commitGuard">>,
  now: () => number = Date.now,
  mono: () => number = () => performance.now(),
): Promise<() => void> {
  if (store.db.inTransaction) throw new StoreError("NOT_FOUND");
  const input = JSON.stringify(store.get(owner, taskId).input);
  const destination = store.sourceBinding(owner, taskId);
  const started = now(),
    monotonic = mono();
  const required = new Map<string, SourceBinding>();
  const collect = (id: string, binding: SourceBinding) => {
    // Each memory in the transitive walk must explicitly permit the root
    // destination. Current source authorization remains independently required.
    required.set(id, binding);
    return true;
  };
  if (!localTaskDependencies(store, owner, taskId, memory, collect))
    throw new StoreError("NOT_FOUND");
  const deadline = Math.min(
    started + 10000,
    destination ? Date.parse(destination.expiresAt) : Infinity,
    ...Array.from(required.values(), (binding) =>
      Date.parse(binding.expiresAt),
    ),
  );
  if (!Number.isFinite(deadline) || deadline <= started)
    throw new StoreError("NOT_FOUND");
  const checks = new Map<string, () => void>();
  for (const [id, binding] of required) {
    if (!sources?.commitGuard) throw new StoreError("NOT_FOUND");
    checks.set(id, await sources.commitGuard(binding));
  }
  const current = (id: string, binding: SourceBinding) => {
    const previous = required.get(id),
      check = checks.get(id);
    if (
      !previous ||
      !check ||
      JSON.stringify(binding) !== JSON.stringify(previous)
    )
      return false;
    check();
    return true;
  };
  const guard = () => {
    const wall = now(),
      elapsed = mono() - monotonic;
    if (
      wall < started ||
      wall >= deadline ||
      elapsed < 0 ||
      elapsed >= 10000 ||
      JSON.stringify(store.get(owner, taskId).input) !== input ||
      JSON.stringify(store.sourceBinding(owner, taskId)) !==
        JSON.stringify(destination) ||
      !localTaskDependencies(store, owner, taskId, memory, current)
    )
      throw new StoreError("NOT_FOUND");
  };
  guard();
  return guard;
}
