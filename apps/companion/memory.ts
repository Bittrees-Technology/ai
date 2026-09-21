import type { AccessCheck } from "../../modules/memory/store.js";
import { Store, StoreError } from "../../modules/storage/store.js";

/** Personal pilot: only completed, unchanged local tasks establish memory provenance. */
export function localMemoryAccess(store: Store): AccessCheck {
  return async (owner, sources) =>
    sources.every((source) => {
      if (source.app !== "local" || source.tenantId !== owner.tenantId)
        return false;
      try {
        const task = store.get(owner, source.resourceId);
        return (
          task.status === "completed" &&
          task.input.sourceRefs.length === 0 &&
          String(task.revision) === source.revision
        );
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return false;
        throw error;
      }
    });
}
