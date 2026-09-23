import type { MailSendConnector } from "../../modules/connectors/mail-send.js";
import type { MailSendRecord } from "../../modules/storage/mail-sends.js";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Reply = MailSendRecord["envelope"]["reply"];
export type MailCompose = {
  wallet: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments: MailSendRecord["envelope"]["attachments"];
  reply: Reply;
};
export const emptyMail = (): MailCompose => ({
  wallet: "",
  from: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  attachments: [],
  reply: null,
});
type Prepared = Awaited<ReturnType<MailSendConnector["prepare"]>>;
type Review = Awaited<ReturnType<MailSendConnector["prepareSend"]>>;
export class MailSendController {
  status:
    | ({ available: boolean } & Partial<
        Awaited<ReturnType<MailSendConnector["status"]>>
      >)
    | null = null;
  draft = emptyMail();
  busy = false;
  error = "";
  notice = "";
  code = "";
  confirmed = false;
  forgetConfirmed = false;
  deleteConfirmed = false;
  pending: Pick<Prepared, "operationId" | "expiresAt"> | null = null;
  file: Prepared["reviewFile"] | null = null;
  review: Review | null = null;
  history: Awaited<ReturnType<MailSendConnector["history"]>> | null = null;
  record: MailSendRecord | null = null;
  private epoch = 0;
  private submitted = new Set<string>();
  constructor(
    private api: Api,
    private changed: () => void = () => {},
    private now = Date.now,
  ) {}
  private cancel(id: string) {
    void this.api("/v1/connections/mail-send/cancel", "POST", { id }).catch(
      () => {},
    );
  }
  private clearReview() {
    if (this.review) this.cancel(this.review.id);
    this.review = null;
    this.confirmed = false;
  }
  hide() {
    this.epoch++;
    this.clearReview();
    this.file = null;
    this.code = "";
    this.history = null;
    this.record = null;
    this.deleteConfirmed = false;
    this.forgetConfirmed = false;
    this.error = "";
    this.notice = "";
    this.changed();
  }
  dispose() {
    this.hide();
    this.draft = emptyMail();
    this.pending = null;
  }
  private async run(
    fn: (epoch: number) => Promise<void>,
    failure = "This request could not be completed. Refresh the connection or check the saved message history.",
  ) {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.changed();
    try {
      await fn(epoch);
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearReview();
        this.error =
          error instanceof Error && error.message === "CAPACITY"
            ? "Saved Mail history is full. Export and explicitly delete older records before preparing another message."
            : failure;
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  private post(action: string, body: unknown) {
    return this.api("/v1/connections/mail-send/" + action, "POST", body);
  }
  refresh() {
    this.hide();
    return this.run(async (epoch) => {
      const status = await this.api("/v1/connections/mail-send");
      if (epoch === this.epoch) this.status = status;
    });
  }
  edit<K extends keyof MailCompose>(key: K, value: MailCompose[K]) {
    if (this.busy) return;
    this.clearReview();
    this.draft = { ...this.draft, [key]: value };
    this.changed();
  }
  clearDraft() {
    if (this.busy) return;
    this.draft = emptyMail();
    this.changed();
  }
  setCode(value: string) {
    this.code = value;
    this.changed();
  }
  setConfirmed(value: boolean) {
    this.confirmed = !!this.review && value;
    this.changed();
  }
  setDelete(value: boolean) {
    this.deleteConfirmed = value;
    this.changed();
  }
  setForget(value: boolean) {
    this.forgetConfirmed = value;
    this.changed();
  }
  files(files: File[]) {
    return this.run(async (epoch) => {
      if (files.length > 4 || files.reduce((n, f) => n + f.size, 0) > 1048576)
        throw Error();
      const attachments = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size) throw Error();
        let content = "";
        for (let i = 0; i < bytes.length; i += 8192)
          content += String.fromCharCode(...bytes.subarray(i, i + 8192));
        attachments.push({
          filename: file.name,
          contentType: "application/octet-stream" as const,
          content: btoa(content),
        });
      }
      if (epoch === this.epoch) {
        this.clearReview();
        this.draft = { ...this.draft, attachments };
      }
    }, "Choose up to four files totaling one MiB. Files were not changed; choose them again to retry.");
  }
  private acceptPrepared(p: Prepared) {
    if (Date.parse(p.expiresAt) <= this.now()) throw Error();
    this.pending = { operationId: p.operationId, expiresAt: p.expiresAt };
    this.file = p.reviewFile;
    this.code = "";
    this.record = null;
    this.history = null;
  }
  prepare() {
    return this.run(async (epoch) => {
      this.clearReview();
      this.pending = null;
      this.file = null;
      const d = structuredClone(this.draft),
        recipients = (text: string) =>
          text
            .split(/[,;\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
      const p = await this.post("prepare", {
        identity: {
          wallet: d.wallet.trim().toLowerCase(),
          mailbox: d.from.trim(),
        },
        message: {
          from: d.from.trim(),
          to: recipients(d.to),
          cc: recipients(d.cc),
          bcc: recipients(d.bcc),
          subject: d.subject,
          text: d.text,
          attachments: d.attachments,
          reply: d.reply,
        },
      });
      if (epoch === this.epoch) {
        this.acceptPrepared(p);
        this.draft = emptyMail();
        this.notice =
          "Message saved on this Mac. Download its review file, then approve this exact message in Mail. Nothing has been sent.";
      }
    }, "The message was not prepared here. Check the sender wallet, mailbox, recipients, message length and file limits. If the response was lost, check saved history before starting again.");
  }
  reconnect(id: string) {
    return this.run(async (epoch) => {
      this.clearReview();
      this.pending = null;
      this.file = null;
      const p = await this.post("reconnect", { operationId: id });
      if (epoch === this.epoch) {
        this.acceptPrepared(p);
        this.notice =
          "A new approval file is ready for this same saved message. It does not resend the message.";
      }
    });
  }
  finish() {
    if (this.busy) return Promise.resolve();
    if (
      !this.pending ||
      this.now() >= Date.parse(this.pending.expiresAt) ||
      !/^[a-f0-9]{64}$/.test(this.code.trim())
    )
      return Promise.resolve();
    const operationId = this.pending.operationId,
      code = this.code.trim();
    this.pending = null;
    this.file = null;
    this.code = "";
    return this.run(async (epoch) => {
      await this.post("finish", { operationId, code });
      const status = await this.api("/v1/connections/mail-send");
      if (epoch === this.epoch) {
        this.status = status;
        this.notice =
          "Mail permission saved. Load the saved message and review it here before any send request.";
      }
    }, "Approval could not be confirmed. Refresh connection status; if needed, use saved history to prepare a new approval file for the same message.");
  }
  loadHistory() {
    this.clearReview();
    return this.run(async (epoch) => {
      const h = await this.api("/v1/connections/mail-send/history");
      if (epoch === this.epoch) {
        this.history = h;
        this.record = null;
        this.deleteConfirmed = false;
      }
    });
  }
  load(id: string) {
    this.clearReview();
    this.record = null;
    this.deleteConfirmed = false;
    return this.run(async (epoch) => {
      const r = await this.api(
        "/v1/connections/mail-send/history/" + encodeURIComponent(id),
      );
      if (r.envelope.operationId !== id) throw Error();
      if (epoch === this.epoch) this.record = r;
    });
  }
  unconfirmed() {
    return (
      !!this.record &&
      this.submitted.has(this.record.envelope.operationId) &&
      !this.record.submittedAt &&
      !this.record.receipt
    );
  }
  canSend() {
    const r = this.record,
      g = this.status?.connection;
    return (
      !!r &&
      !!g &&
      g.state === "stored" &&
      Date.parse(g.expiresAt) > this.now() &&
      g.operationId === r.envelope.operationId &&
      !g.previouslySubmitted &&
      !r.reconciliationOnly &&
      !r.submittedAt &&
      r.sourceSubmission !== "reserved" &&
      !r.receipt &&
      !this.submitted.has(r.envelope.operationId)
    );
  }
  reviewSend() {
    if (!this.canSend() || !this.record) return Promise.resolve();
    const original = structuredClone(this.record);
    this.clearReview();
    return this.run(async (epoch) => {
      const review: Review = await this.post("review", {
        operationId: original.envelope.operationId,
      });
      if (epoch !== this.epoch) {
        this.cancel(review.id);
        return;
      }
      if (
        review.operationId !== original.envelope.operationId ||
        JSON.stringify(review.envelope) !== JSON.stringify(original.envelope) ||
        JSON.stringify(review.identity) !== JSON.stringify(original.identity) ||
        Date.parse(review.expiresAt) <= this.now()
      ) {
        this.cancel(review.id);
        throw Error();
      }
      this.review = review;
    });
  }
  confirm() {
    if (
      this.busy ||
      !this.confirmed ||
      !this.review ||
      Date.parse(this.review.expiresAt) <= this.now() ||
      !this.canSend()
    )
      return Promise.resolve();
    const review = this.review;
    this.review = null;
    this.confirmed = false;
    this.submitted.add(review.operationId);
    return this.run(async (epoch) => {
      const r = await this.post("confirm", { id: review.id, confirmed: true });
      if (epoch === this.epoch) {
        this.record = r;
        this.notice =
          "Request recorded. Read the historical status below; SMTP acceptance does not confirm delivery.";
      }
    }, "The send outcome is unconfirmed. Do not create a replacement message. Check this saved message’s status; a status check never resends it.");
  }
  reconcile() {
    if (!this.record) return Promise.resolve();
    const operationId = this.record.envelope.operationId;
    this.clearReview();
    return this.run(async (epoch) => {
      const r = await this.post("reconcile", { operationId });
      if (epoch === this.epoch) this.record = r;
    }, "Status is unavailable. Keep this saved message and obtain fresh approval for the same message if permission expired. Do not resend it.");
  }
  disconnect() {
    this.clearReview();
    this.pending = null;
    this.file = null;
    this.code = "";
    return this.run(async (epoch) => {
      try {
        await this.post("disconnect", {});
      } finally {
        const s = await this.api("/v1/connections/mail-send");
        if (epoch === this.epoch) this.status = s;
      }
    }, "Disconnect could not be confirmed. Refresh status; permission may be suspended locally. Revoke it in Mail or explicitly forget it here.");
  }
  forget() {
    if (!this.forgetConfirmed) return Promise.resolve();
    this.hide();
    this.pending = null;
    return this.run(async (epoch) => {
      await this.post("forget", { confirmed: true });
      if (epoch === this.epoch) {
        this.status = { available: true, connection: null };
        this.notice =
          "Local permission removed. Mail permission and source work were not cancelled.";
      }
    });
  }
  remove() {
    if (!this.record || !this.deleteConfirmed) return Promise.resolve();
    const operationId = this.record.envelope.operationId;
    this.clearReview();
    this.deleteConfirmed = false;
    return this.run(async (epoch) => {
      await this.post("delete", {
        operationId,
        confirmed: true,
        forgetSendTracking: true,
      });
      if (epoch === this.epoch) {
        this.status = null;
        this.record = null;
        this.history = null;
        if (this.pending?.operationId === operationId) {
          this.pending = null;
          this.file = null;
          this.code = "";
        }
        this.notice =
          "Local tracking deleted. This does not cancel source work, recall mail or revoke source permission.";
      }
      const s = await this.api("/v1/connections/mail-send");
      if (epoch === this.epoch) this.status = s;
    });
  }
  expire() {
    let changed = false;
    if (this.review && Date.parse(this.review.expiresAt) <= this.now()) {
      this.clearReview();
      changed = true;
    }
    if (this.pending && Date.parse(this.pending.expiresAt) <= this.now()) {
      this.pending = null;
      this.file = null;
      this.code = "";
      changed = true;
    }
    if (
      this.status?.connection?.state === "stored" &&
      Date.parse(this.status.connection.expiresAt) <= this.now()
    ) {
      this.status.connection.state = "expired";
      this.clearReview();
      changed = true;
    }
    if (changed) this.changed();
  }
}
