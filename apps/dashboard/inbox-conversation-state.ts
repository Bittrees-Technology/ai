export class InboxConversationController {
  items: { id: string; preview: string; updatedAt: number }[] = [];
  nextCursor: string | null = null;
  busy = false;
  private epoch = 0;
  private inbox = "";
  constructor(
    private api: (path: string) => Promise<any>,
    private changed = () => {},
  ) {}
  clear(inbox = "") {
    this.epoch++;
    this.inbox = inbox;
    this.items = [];
    this.nextCursor = null;
    this.busy = false;
    this.changed();
  }
  async refresh(inbox: string) {
    this.clear(inbox);
    if (inbox) await this.load(null);
  }
  async more() {
    if (this.nextCursor && !this.busy) await this.load(this.nextCursor);
  }
  private async load(cursor: string | null) {
    const epoch = this.epoch;
    this.busy = true;
    this.changed();
    try {
      const page = await this.api(
        `/v1/inboxes/${encodeURIComponent(this.inbox)}/conversations` +
          (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
      );
      if (epoch !== this.epoch) return;
      this.items = [
        ...new Map(
          [...this.items, ...page.items].map((item) => [item.id, item]),
        ).values(),
      ];
      this.nextCursor = page.nextCursor;
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.changed();
      }
    }
  }
}
