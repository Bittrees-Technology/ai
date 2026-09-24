import type { InboxMessage } from "./inbox-message-state.js";

/** A bounded display lease, never a source permission or cached task result. */
export class InboxTaskReview {
  content: string | null = null;
  busy = false;
  private generation = 0;
  private wall = 0;
  private mono = 0;
  constructor(
    private api: (path: string) => Promise<InboxMessage>,
    private changed = () => {},
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  clear() {
    this.generation++;
    this.content = null;
    this.busy = false;
    this.changed();
  }
  expire() {
    if ((this.content !== null || this.busy) && !this.current()) this.clear();
  }
  private current() {
    return (
      this.now() >= this.wall &&
      this.now() - this.wall < 15000 &&
      this.monotonic() >= this.mono &&
      this.monotonic() - this.mono < 15000
    );
  }
  async read(message: InboxMessage, available: () => boolean) {
    if (this.busy || !message.input.requestId || !available()) return;
    this.clear();
    const generation = this.generation;
    this.wall = this.now();
    this.mono = this.monotonic();
    this.busy = true;
    this.changed();
    try {
      const result = await this.api(
        "/v1/messages/" + encodeURIComponent(message.id),
      );
      if (generation !== this.generation || !available() || !this.current())
        return;
      if (
        result.id !== message.id ||
        result.input.requestId !== message.input.requestId ||
        result.input.conversationId !== message.input.conversationId ||
        result.input.recipientInboxId !== message.input.recipientInboxId ||
        result.taskAccess === "unavailable"
      )
        throw Error("UNAVAILABLE");
      this.content = result.input.content;
    } catch {
      if (generation === this.generation && available()) {
        this.content = null;
        throw Error(
          "Task message could not be opened. Refresh and check access again.",
        );
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
}
