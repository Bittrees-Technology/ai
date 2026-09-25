export type SuggestionReview = {
  taskId: string;
  revision: number;
  parentId: string;
  parentRevision: number;
  candidates: {
    type: string;
    text: string;
    evidence: { source: string; quote: string }[];
  }[];
};
type Api = (path: string, method: string, body?: unknown) => Promise<any>;
export class MemorySuggestionController {
  busy = false;
  prepared = false;
  queuedId = "";
  source: { request: string; result: string } | null = null;
  review: SuggestionReview | null = null;
  saved = new Set<number>();
  private epoch = 0;
  private intent: {
    expectedRevision: number;
    modelProfileId: string;
    invocationId: string;
    confirmed: true;
  } | null = null;
  constructor(
    private api: Api,
    readonly taskId: string,
    private revision: number,
    private changed = () => {},
    private uuid = () => crypto.randomUUID(),
  ) {}
  prepare(profileId: string) {
    if (this.busy || !profileId) return;
    if (!this.intent || this.intent.modelProfileId !== profileId)
      this.intent = {
        expectedRevision: this.revision,
        modelProfileId: profileId,
        invocationId: this.uuid(),
        confirmed: true,
      };
    this.prepared = true;
    this.changed();
  }
  async prepareSource(profileId: string) {
    if (this.busy || !profileId) return;
    this.hide();
    await this.run(
      () => this.api(`/v1/requests/${this.taskId}/export`, "GET"),
      (data) => {
        const task = data.task;
        if (
          task?.id !== this.taskId ||
          task.revision !== this.revision ||
          task.status !== "completed" ||
          typeof task.input?.prompt !== "string" ||
          typeof task.result?.text !== "string" ||
          !task.result.text
        )
          throw Error(
            "The source changed. Open the current draft and try again.",
          );
        this.source = { request: task.input.prompt, result: task.result.text };
        if (!this.intent || this.intent.modelProfileId !== profileId)
          this.intent = {
            expectedRevision: this.revision,
            modelProfileId: profileId,
            invocationId: this.uuid(),
            confirmed: true,
          };
        this.prepared = true;
      },
    );
  }
  hide() {
    this.epoch++;
    this.prepared = false;
    this.source = null;
    this.review = null;
    this.saved.clear();
    this.changed();
  }
  private async run(work: () => Promise<any>, accept: (value: any) => void) {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.changed();
    try {
      const value = await work();
      if (epoch === this.epoch) accept(value);
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async request() {
    if (!this.prepared || !this.intent || this.queuedId) return;
    const intent = { ...this.intent };
    await this.run(
      () =>
        this.api(
          `/v1/requests/${this.taskId}/memory-suggestions`,
          "POST",
          intent,
        ),
      (task) => {
        this.source = null;
        this.queuedId = task.id;
        this.prepared = false;
      },
    );
  }
  async load() {
    if (this.busy) return;
    this.review = null;
    this.saved.clear();
    await this.run(
      () => this.api(`/v1/requests/${this.taskId}/memory-suggestions`, "GET"),
      (value) => {
        this.review = value;
        this.saved.clear();
      },
    );
  }
  async save(index: number) {
    const review = this.review;
    if (!review || !review.candidates[index] || this.saved.has(index)) return;
    await this.run(
      () =>
        this.api(
          `/v1/requests/${this.taskId}/memory-suggestions/save`,
          "POST",
          { expectedRevision: review.revision, index, confirmed: true },
        ),
      () => {
        this.saved.add(index);
      },
    );
  }
}
