import { ModelError, type Ollama } from "../../modules/models/ollama.js";
import type { SourceTasks } from "../../modules/connectors/source-tasks.js";
import type { MemoryStore } from "../../modules/memory/store.js";
import type { ResumeAccess } from "../../modules/storage/remote-resumes.js";
import {
  StoreError,
  type Store,
  type Owner,
} from "../../modules/storage/store.js";
import { conversationTaskAccess } from "./conversation-access.js";

/** Fresh local source/model checks before the resume transaction. The existing
 * source guard bounds both clocks and rechecks local dependencies through commit.
 * Model availability is not reserved; the worker independently checks the digest. */
export function resumeTaskAccess(
  store: Store,
  owner: Owner,
  sources: SourceTasks,
  runtime: Pick<Ollama, "pin">,
  memory?: MemoryStore,
  now = Date.now,
  mono = () => performance.now(),
): ResumeAccess {
  const scope = { ...owner };
  const sourceAccess = conversationTaskAccess(
    store,
    scope,
    sources,
    memory,
    now,
    mono,
  );
  return async (task, profile, approvedDigest) => {
    if (store.db.inTransaction) throw new StoreError("CONFLICT");
    const current = store.get(scope, task.id);
    if (
      current.revision !== task.revision ||
      current.status !== "paused" ||
      JSON.stringify(current.input) !== JSON.stringify(task.input) ||
      JSON.stringify(store.profile(scope, task.input.modelProfileId)) !==
        JSON.stringify(profile)
    )
      throw new StoreError("CONFLICT");
    const encodedProfile = JSON.stringify(profile);
    const checkSource = await sourceAccess(task.id);
    checkSource();
    const pinned = await runtime.pin(
      structuredClone(profile),
      AbortSignal.timeout(10000),
    );
    if (
      pinned.digest !== approvedDigest ||
      JSON.stringify(pinned.profile) !== encodedProfile
    )
      throw new ModelError("MODEL_CHANGED");
    if (store.get(scope, task.id).revision !== task.revision)
      throw new StoreError("CONFLICT");
    const check = () => {
      checkSource();
      if (
        JSON.stringify(store.profile(scope, task.input.modelProfileId)) !==
        encodedProfile
      )
        throw new StoreError("CONFLICT");
    };
    check();
    return check;
  };
}
