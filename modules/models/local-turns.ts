/** Share the Mac model between workflows without parallel inference or starvation. */
export type ModelTurn = <T>(
  signal: AbortSignal,
  work: () => Promise<T>,
) => Promise<T>;
export const immediateTurn: ModelTurn = async (signal, work) => {
  signal.throwIfAborted();
  return work();
};
export class LocalModelTurns {
  private tail: Promise<void> = Promise.resolve();
  run: ModelTurn = async (signal, work) => {
    signal.throwIfAborted();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Aborting a queued workflow must not release the model held by another.
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
      signal.throwIfAborted();
      return await work();
    } finally {
      signal.removeEventListener("abort", cancel);
      void previous.then(release);
    }
  };
}
