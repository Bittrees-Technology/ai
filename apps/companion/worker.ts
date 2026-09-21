import { Store, StoreError, type Owner } from "../../modules/storage/store.js";
import {
  ModelError,
  type PinnedModel,
  type Ollama,
} from "../../modules/models/ollama.js";
export interface Runtime {
  pin: Ollama["pin"];
  generate: Ollama["generate"];
}
export class LocalWorker {
  private active: { id: string; abort: AbortController } | null = null;
  constructor(
    private store: Store,
    private owner: Owner,
    private runtime: Runtime,
    private resolveProfile: (id: string) => unknown,
    private workerId = "local-worker",
  ) {}
  cancel(id: string) {
    if (this.active?.id === id) this.active.abort.abort();
  }
  async runOnce(): Promise<boolean> {
    if (this.active) return false;
    const claim = this.store.claim(this.owner, this.workerId);
    if (!claim) return false;
    const abort = new AbortController();
    this.active = { id: claim.task.id, abort };
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(
          this.owner,
          claim.task.id,
          this.workerId,
          claim.generation,
        );
      } catch {
        abort.abort();
      }
    }, 5000);
    heartbeat.unref();
    try {
      if (claim.task.input.sourceRefs.length)
        throw new Error("Source adapters are not enabled");
      const pinned: PinnedModel = await this.runtime.pin(
        this.resolveProfile(claim.task.input.modelProfileId),
        abort.signal,
      );
      this.store.recordModel(
        this.owner,
        claim.task.id,
        this.workerId,
        claim.generation,
        pinned,
      );
      const text = await this.runtime.generate(
        pinned,
        claim.task.input.prompt,
        abort.signal,
      );
      if (abort.signal.aborted) throw abort.signal.reason;
      this.store.complete(
        this.owner,
        claim.task.id,
        this.workerId,
        claim.generation,
        { text, model: pinned, kind: "unreviewed_draft" },
      );
    } catch (error) {
      try {
        this.store.fail(
          this.owner,
          claim.task.id,
          this.workerId,
          claim.generation,
          error instanceof ModelError && error.code === "MODEL_UNAVAILABLE",
        );
      } catch (stale) {
        if (!(
          stale instanceof StoreError &&
          ["STALE_CLAIM", "NOT_FOUND"].includes(stale.code)
        ))
          throw stale;
      }
    } finally {
      clearInterval(heartbeat);
      this.active = null;
    }
    return true;
  }
}
