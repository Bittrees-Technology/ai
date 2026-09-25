import type { z } from "zod";
import { memorySelectionSchema } from "../../modules/contracts/index.js";
import type { SourceTasks } from "../../modules/connectors/source-tasks.js";
import type { MemoryStore } from "../../modules/memory/store.js";
import { Store, StoreError, type Owner } from "../../modules/storage/store.js";
import { taskDependencyGuard } from "./memory.js";
import { sourceMemoryAccess } from "./source-memory.js";

/** One explicit creation operation; no content or permission cached for later tasks. */
export async function memorySelectionGuard(
  store: Store,
  owner: Owner,
  memory: MemoryStore | undefined,
  sources: SourceTasks,
  raw: z.infer<typeof memorySelectionSchema> | undefined,
  destination: string,
) {
  if (!raw) return () => {};
  const selection = memorySelectionSchema.parse(raw);
  if (!memory || selection.destination !== destination)
    throw new StoreError("INVALID_INPUT");
  const access = sourceMemoryAccess(store, sources, () => memory);
  const checks: Array<() => void> = [];
  for (const selected of selection.memories) {
    const item = await memory.get(owner, selected.id);
    if (item.revision !== selected.revision || item.state !== "approved")
      throw new StoreError("CONFLICT");
    const refs = memory.dependencySources(
      owner,
      selected.id,
      selected.revision,
      destination,
    );
    if (!(await access(owner, refs))) throw new StoreError("NOT_FOUND");
    for (const ref of refs)
      checks.push(
        await taskDependencyGuard(
          store,
          owner,
          ref.resourceId,
          memory,
          sources,
          Date.now,
          () => performance.now(),
          destination,
        ),
      );
    checks.push(() => {
      memory.dependencySources(
        owner,
        selected.id,
        selected.revision,
        destination,
      );
      if (!access.current!(owner, refs)) throw new StoreError("NOT_FOUND");
    });
  }
  const current = () => {
    for (const check of checks) check();
  };
  current();
  return current;
}
