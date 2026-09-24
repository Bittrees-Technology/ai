import type { InboxMessage } from "./inbox-message-state.js";
import {
  taskQuestionViewSchema,
  taskAnswerReceiptSchema,
  type TaskQuestionView,
} from "../../modules/contracts/task-answer.js";

type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<unknown>;
/** A short-lived local answer review; never source authority or a remote grant. */
export class TaskAnswerController {
  question: TaskQuestionView | null = null;
  draft = "";
  review: { question: TaskQuestionView; content: string; key: string } | null =
    null;
  confirmed = false;
  busy = false;
  sending = false;
  notice = "";
  private generation = 0;
  private wall = 0;
  private mono = 0;
  constructor(
    private api: Api,
    private changed = () => {},
    private now = Date.now,
    private monotonic = () => performance.now(),
    private key = () => crypto.randomUUID(),
  ) {}
  clear() {
    this.generation++;
    this.question = this.review = null;
    this.draft = "";
    this.confirmed = false;
    this.busy = false;
    this.notice = this.sending
      ? "Saving was already requested. Reopen the question to check after it finishes."
      : "";
    this.changed();
  }
  private current() {
    return (
      this.now() >= this.wall &&
      this.now() - this.wall < 120000 &&
      this.monotonic() >= this.mono &&
      this.monotonic() - this.mono < 120000 &&
      (!this.question || this.now() < this.question.deadline)
    );
  }
  expire() {
    if ((this.question || this.busy) && !this.current()) {
      this.clear();
      this.notice =
        "Answer review expired. Reopen the question to check its current state.";
      this.changed();
    }
  }
  edit(content: string) {
    this.expire();
    if (!this.question || this.busy || this.sending || this.review) return;
    this.draft = content;
    this.confirmed = false;
    this.changed();
  }
  acknowledge(value: boolean) {
    this.expire();
    this.confirmed = !!this.review && value;
    this.changed();
  }
  private async read(message: InboxMessage) {
    const q = taskQuestionViewSchema.parse(
      await this.api(
        `/v1/messages/${encodeURIComponent(message.id)}/task-question`,
      ),
    );
    if (
      q.questionId !== message.id ||
      q.taskId !== message.input.requestId ||
      q.inboxId !== message.input.recipientInboxId ||
      q.conversationId !== message.input.conversationId ||
      (q.canAnswer &&
        (q.replyId !== null ||
          !["awaiting_input", "paused"].includes(q.status)))
    )
      throw Error("QUESTION_CHANGED");
    return q;
  }
  async open(message: InboxMessage, available: () => boolean) {
    if (this.busy || this.sending || !available()) return;
    this.clear();
    const generation = this.generation;
    this.wall = this.now();
    this.mono = this.monotonic();
    this.busy = true;
    this.changed();
    try {
      const q = await this.read(message);
      if (generation !== this.generation) return;
      if (!available() || !this.current()) {
        this.clear();
        return;
      }
      if (q.replyId)
        this.notice =
          "An answer is already saved for this question. No answer was sent from this review.";
      else if (!q.canAnswer || q.deadline <= this.now())
        this.notice =
          "This question is not accepting an answer. Refresh the task to check its state.";
      else this.question = q;
    } catch {
      if (generation === this.generation && available())
        this.notice =
          "Question could not be opened. Refresh and check access again.";
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  async prepare(message: InboxMessage, available: () => boolean) {
    this.expire();
    const initial = this.question,
      content = this.draft;
    if (
      !initial ||
      this.review ||
      this.busy ||
      this.sending ||
      !available() ||
      !content.trim() ||
      content.length > 32000
    )
      return;
    const generation = this.generation;
    this.busy = true;
    this.notice = "";
    this.changed();
    try {
      const q = await this.read(message);
      if (generation !== this.generation) return;
      if (!available()) {
        this.clear();
        return;
      }
      if (
        !this.current() ||
        !q.canAnswer ||
        q.replyId ||
        q.deadline <= this.now() ||
        q.revision !== initial.revision ||
        q.status !== initial.status ||
        q.question !== initial.question ||
        q.deadline !== initial.deadline
      )
        throw Error("QUESTION_CHANGED");
      this.review = { question: q, content, key: this.key() };
      this.confirmed = false;
    } catch {
      if (generation === this.generation && available()) {
        this.clear();
        this.notice = "Question or access changed. Reopen it before answering.";
      }
    } finally {
      if (generation === this.generation) this.busy = false;
      this.changed();
    }
  }
  async save(available: () => boolean) {
    this.expire();
    const r = this.review;
    if (!r || !this.confirmed || this.busy || this.sending || !available())
      return;
    const generation = this.generation;
    this.review = null;
    this.confirmed = false;
    this.sending = true;
    // Consume the review before dispatch. A lost reply requires a new read,
    // not an automatic retry or a second concurrent submission.
    this.question = null;
    this.draft = "";
    this.changed();
    try {
      const result = taskAnswerReceiptSchema.parse(
        await this.api(
          `/v1/messages/${encodeURIComponent(r.question.questionId)}/task-answer`,
          "POST",
          {
            questionId: r.question.questionId,
            expectedRevision: r.question.revision,
            content: r.content,
            confirmed: true,
          },
          { "Idempotency-Key": r.key },
        ),
      );
      if (
        result.taskId !== r.question.taskId ||
        result.questionId !== r.question.questionId ||
        result.revision <= r.question.revision ||
        (!result.duplicate &&
          (result.revision !== r.question.revision + 1 ||
            result.status !==
              (r.question.status === "paused" ? "paused" : "queued")))
      )
        throw Error("UNCONFIRMED");
      if (generation === this.generation && available())
        this.notice =
          result.status === "paused"
            ? "Answer saved. The task remains paused."
            : "Answer saved. Refresh the task to see its current progress.";
    } catch {
      if (generation === this.generation && available())
        this.notice =
          "Saving could not be confirmed. Reopen the question to check whether an answer is already saved before trying again.";
    } finally {
      this.sending = false;
      this.changed();
    }
  }
}
