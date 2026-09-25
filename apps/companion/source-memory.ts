import type { AccessCheck, MemoryStore } from "../../modules/memory/store.js";
import { Store, type Owner } from "../../modules/storage/store.js";
import type { SourceTasks } from "../../modules/connectors/source-tasks.js";
import { localMemoryAccess, taskDependencyGuard } from "./memory.js";

/** Source-backed task provenance for memory review/search. Each asynchronous
 * access obtains fresh source authorization; current is only its final local
 * mutation fence, never an independent permission or a task-reuse grant.
 * Task readers and execution separately obtain fresh dependency guards. */
export function sourceMemoryAccess(
  store: Store,
  sources: Pick<SourceTasks, "commitGuard">,
  memory?: () => MemoryStore | undefined,
  now: () => number = Date.now,
): AccessCheck {
  const local = localMemoryAccess(store, memory);
  type Refs = Parameters<AccessCheck>[1];
  const proofs = new Map<string, { check: () => boolean }>();
  const identity = (owner: Owner, refs: Refs) =>
    JSON.stringify([owner.userId, owner.tenantId, refs]);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const localOnly = (owner: Owner, refs: Refs) => local.current!(owner, refs);
  const current: NonNullable<AccessCheck["current"]> = (owner, refs) => {
    if (localOnly(owner, refs)) return true;
    return proofs.get(identity(owner, refs))?.check() ?? false;
  };
  const access = async (owner: Owner, refs: Refs) => {
    if (localOnly(owner, refs)) return true;
    const key = identity(owner, refs);
    // Starting a refresh removes earlier authority for this exact provenance.
    const ticket = { check: () => false };
    proofs.delete(key);
    proofs.set(key, ticket);
    if (proofs.size > 2048) proofs.delete(proofs.keys().next().value!);
    const started = now(),
      guards: Array<() => boolean> = [];
    try {
      if (!refs.length || refs.length > 32) return false;
      for (const ref of refs) {
        if (ref.app !== "local" || ref.tenantId !== owner.tenantId)
          return false;
        const task = store.get(owner, ref.resourceId);
        if (
          task.status !== "completed" ||
          String(task.revision) !== ref.revision
        )
          return false;
        const binding = store.sourceBinding(owner, task.id);
        if (
          binding
            ? !same(task.input.sourceRefs, binding.refs)
            : task.input.sourceRefs.length > 0
        )
          return false;
        const dependencies = await taskDependencyGuard(
          store,
          owner,
          task.id,
          memory?.(),
          sources,
          now,
        );
        const taskId = task.id,
          taskRevision = task.revision;
        const sourceCurrent = binding
          ? await sources.commitGuard(binding)
          : () => {};
        guards.push(() => {
          sourceCurrent();
          dependencies();
          const latest = store.get(owner, taskId);
          return (
            latest.status === "completed" &&
            latest.revision === taskRevision &&
            same(store.sourceBinding(owner, taskId), binding) &&
            same(latest.input.sourceRefs, binding?.refs ?? [])
          );
        });
      }
      const check = () => {
        try {
          return (
            proofs.get(key) === ticket &&
            now() >= started &&
            now() - started <= 15000 &&
            guards.every((g) => g())
          );
        } catch {
          return false;
        }
      };
      ticket.check = check;
      if (!check()) {
        if (proofs.get(key) === ticket) proofs.delete(key);
        return false;
      }
      return true;
    } catch {
      if (proofs.get(key) === ticket) proofs.delete(key);
      return false;
    }
  };
  return Object.assign(access, { current });
}
