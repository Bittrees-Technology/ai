import { ConnectorError } from "../../modules/connectors/crm.js";
import type { SourceTasks } from "../../modules/connectors/source-tasks.js";
import type { MemoryStore } from "../../modules/memory/store.js";
import type { ConversationTaskAccess } from "../../modules/remote/private-conversation-content.js";
import { Store, type Owner } from "../../modules/storage/store.js";
import { localTaskDependencies } from "./memory.js";

/** Host-owned per-operation access: source reads happen outside the SQLite
 * transaction; the returned check is synchronous and valid for at most 10s.
 * This checks the local connector boundary after a fresh source read. It does
 * not provide an atomic transaction with a remote source or monitor its edits. */
export function conversationTaskAccess(
  store: Store,
  owner: Owner,
  sources: SourceTasks,
  memory?: MemoryStore,
  now = Date.now,
  mono = () => performance.now(),
): ConversationTaskAccess {
  const scope = { ...owner };
  return async (id) => {
    const initial = store.get(scope, id),
      binding = store.sourceBinding(scope, id),
      input = JSON.stringify(initial.input),
      source = JSON.stringify(binding),
      memoryToken = memory?.changeToken(),
      started = now(),
      monotonicAt = mono(),
      deadline = Math.min(
        started + 10000,
        binding ? Date.parse(binding.expiresAt) : Infinity,
      );
    const deny = (): never => {
      throw new ConnectorError("SOURCE_DENIED");
    };
    if (store.db.inTransaction || !Number.isFinite(deadline)) deny();
    if (initial.input.sourceRefs.length && !binding) deny();
    if (
      binding &&
      JSON.stringify(binding.refs) !== JSON.stringify(initial.input.sourceRefs)
    )
      deny();
    if (!localTaskDependencies(store, scope, id, memory)) deny();
    const sourceCheck = binding ? await sources.commitGuard(binding) : () => {};
    const check = () => {
      const wall = now(),
        monotonic = mono();
      if (
        wall < started ||
        wall >= deadline ||
        monotonic < monotonicAt ||
        monotonic - monotonicAt >= 10000
      )
        deny();
      sourceCheck();
      const current = store.get(scope, id);
      if (
        JSON.stringify(current.input) !== input ||
        JSON.stringify(store.sourceBinding(scope, id)) !== source ||
        memory?.changeToken() !== memoryToken ||
        !localTaskDependencies(store, scope, id, memory)
      )
        deny();
    };
    // The answer transaction legitimately advances revision after this point.
    // Bind revision across asynchronous reads, then let the content engine and
    // existing answerInput path validate their exact task/question revisions.
    if (store.get(scope, id).revision !== initial.revision) deny();
    check();
    return check;
  };
}
