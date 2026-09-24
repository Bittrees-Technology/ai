export type InboxMessage = {
  id: string;
  sequence: number;
  createdAt: number;
  receipts: { kind: string }[];
  taskAccess?: "unavailable";
  input: {
    content: string;
    conversationId: string;
    recipientInboxId: string;
    requestId?: string;
    replyToId?: string;
    replyExpected: boolean;
    replyDueAt?: string;
  };
};
export class InboxMessageController {
  messages: InboxMessage[] = [];
  checkins: { message_id: string; status: string }[] = [];
  more = false;
  busy = false;
  private epoch = 0;
  private cursor = 0;
  private inbox = "";
  private conversation = "";
  constructor(
    private api: (path: string) => Promise<any>,
    private changed = () => {},
  ) {}
  select(inbox = "", conversation = "") {
    this.epoch++;
    this.inbox = inbox;
    this.conversation = conversation;
    this.messages = [];
    this.checkins = [];
    this.cursor = 0;
    this.more = false;
    this.busy = false;
    this.changed();
  }
  private merge(items: InboxMessage[]) {
    const merged = new Map(this.messages.map((m) => [m.id, m]));
    for (const item of items) {
      if (
        item.input.recipientInboxId !== this.inbox ||
        item.input.conversationId !== this.conversation
      )
        continue;
      const prior = merged.get(item.id);
      merged.set(item.id, {
        ...item,
        input: item.input.requestId
          ? { ...item.input, content: "Task-linked message" }
          : item.input,
        receipts: [
          ...new Map(
            [...(prior?.receipts ?? []), ...item.receipts].map((r) => [
              r.kind,
              r,
            ]),
          ).values(),
        ],
      });
    }
    this.messages = [...merged.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
  }
  saved(message: InboxMessage) {
    this.merge([message]);
    this.changed();
  }
  receipt(id: string, kind: string) {
    this.messages = this.messages.map((m) =>
      m.id === id && !m.receipts.some((r) => r.kind === kind)
        ? { ...m, receipts: [...m.receipts, { kind }] }
        : m,
    );
    this.changed();
  }
  async load(manual = false) {
    if (this.busy || !this.inbox || !this.conversation) return;
    const epoch = this.epoch;
    // Keep check-ins current even while the user has unloaded message pages.
    const fetchMessages = manual || !this.more;
    this.busy = true;
    this.changed();
    try {
      const [data, checks] = await Promise.all([
        fetchMessages
          ? this.api(
              `/v1/messages?inboxId=${encodeURIComponent(this.inbox)}&conversationId=${encodeURIComponent(this.conversation)}&after=${this.cursor}`,
            )
          : Promise.resolve(null),
        this.api("/v1/checkins"),
      ]);
      if (epoch !== this.epoch) return;
      if (data) {
        this.merge(data.items);
        this.cursor = data.items.at(-1)?.sequence ?? this.cursor;
        this.more = data.items.length === 100;
      }
      this.checkins = checks.items;
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
