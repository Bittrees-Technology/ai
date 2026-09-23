import type {
  NewsArticle,
  NewsConnection,
  NewsPreview,
  NewsEditInput,
  NewsEditReview,
  NewsPublicReview,
  NewsPublicationHistory,
} from "../../modules/connectors/news.js";
import type { NewsPublicationRecord } from "../../modules/storage/news-publications.js";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class NewsConnectionController {
  status: {
    available: boolean;
    publication?: "per_action_review" | "unavailable";
    connection: (NewsConnection & { state: "stored" | "expired" }) | null;
  } | null = null;
  pending: {
    id: string;
    connection: NewsConnection;
    reviewExpiresAt: string;
  } | null = null;
  articles: NewsArticle[] = [];
  checkedAt: string | null = null;
  token = "";
  confirmed = false;
  busy = false;
  error = "";
  preview: NewsPreview | null = null;
  edit: NewsEditInput | null = null;
  editReview: NewsEditReview | null = null;
  curateConfirmed = false;
  notice = "";
  publicReview: NewsPublicReview | null = null;
  publicationConfirmed = false;
  publicationHistory: NewsPublicationHistory | null = null;
  publicationRecord: NewsPublicationRecord | null = null;
  deletePublicationConfirmed = false;
  publicationNotice = "";
  publicationError = "";
  private cancelPublicReview(id: string) {
    void this.api("/v1/connections/news/publication/cancel", "POST", {
      id,
    }).catch(() => {});
  }
  clearPublication() {
    if (this.publicReview) this.cancelPublicReview(this.publicReview.id);
    this.publicReview = null;
    this.publicationConfirmed = false;
    this.publicationHistory = null;
    this.publicationRecord = null;
    this.deletePublicationConfirmed = false;
    this.publicationNotice = "";
    this.publicationError = "";
  }
  private epoch = 0;
  constructor(
    private api: Api,
    private changed: () => void = () => {},
  ) {}
  hide() {
    this.epoch++;
    this.clearPublication();
    this.token = "";
    this.pending = null;
    this.confirmed = false;
    this.articles = [];
    this.checkedAt = null;
    this.error = "";
    this.preview = null;
    this.edit = null;
    this.editReview = null;
    this.curateConfirmed = false;
    this.notice = "";
    this.changed();
  }
  editToken(token: string) {
    this.hide();
    this.token = token;
    this.changed();
  }
  private async run(fn: (epoch: number) => Promise<void>) {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      await fn(epoch);
    } catch {
      if (epoch === this.epoch) {
        this.articles = [];
        this.checkedAt = null;
        this.preview = null;
        this.edit = null;
        this.editReview = null;
        this.curateConfirmed = false;
        this.error =
          "News could not complete this request. Check your connection in News, then try again.";
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async refresh() {
    this.hide();
    await this.run(async (epoch) => {
      const data = await this.api("/v1/connections/news");
      if (epoch === this.epoch) this.status = data;
    });
  }
  async prepare() {
    const token = this.token;
    this.token = "";
    this.pending = null;
    this.confirmed = false;
    await this.run(async (epoch) => {
      const result = await this.api("/v1/connections/news/review", "POST", {
        token,
      });
      if (epoch === this.epoch) this.pending = result;
    });
  }
  async confirm() {
    if (!this.pending || !this.confirmed) return;
    const pending = this.pending;
    await this.run(async (epoch) => {
      const result = await this.api("/v1/connections/news/confirm", "POST", {
        id: pending.id,
        confirmed: true,
      });
      if (epoch === this.epoch) {
        this.status = { available: true, ...result };
        this.pending = null;
        this.confirmed = false;
      }
    });
  }
  async read() {
    this.articles = [];
    this.checkedAt = null;
    await this.run(async (epoch) => {
      const result = await this.api(
        "/v1/connections/news/articles",
        "POST",
        {},
      );
      if (epoch === this.epoch) {
        this.articles = result.items;
        this.checkedAt = result.checkedAt;
      }
    });
  }
  async forget() {
    this.hide();
    await this.run(async (epoch) => {
      await this.api("/v1/connections/news/forget", "POST", {
        confirmed: true,
      });
      if (epoch === this.epoch)
        this.status = { available: true, connection: null };
    });
  }
  async cancel() {
    this.hide();
    await this.run(async () => {
      await this.api("/v1/connections/news/cancel", "POST", {});
    });
  }
  async loadPreview() {
    this.clearPublication();
    this.edit = null;
    this.editReview = null;
    this.curateConfirmed = false;
    this.preview = null;
    this.notice = "";
    await this.run(async (epoch) => {
      const result = await this.api("/v1/connections/news/preview", "POST", {});
      if (epoch === this.epoch) this.preview = result;
    });
  }
  chooseStory(itemId: string) {
    this.clearPublication();
    if (this.busy || !this.preview) return;
    const item = this.preview.front.find((i) => i.id === itemId);
    if (!item) return;
    this.edit = {
      revision: this.preview.revision,
      itemId,
      title: item.title,
      summary: item.summary ?? item.excerpt,
    };
    this.editReview = null;
    this.curateConfirmed = false;
    this.notice = "";
    this.changed();
  }
  changeStory(field: "title" | "summary", value: string) {
    if (this.busy || !this.edit) return;
    this.edit = { ...this.edit, [field]: value };
    this.editReview = null;
    this.curateConfirmed = false;
    this.changed();
  }
  async reviewStory() {
    this.clearPublication();
    if (!this.edit) return;
    const input = { ...this.edit };
    this.editReview = null;
    this.curateConfirmed = false;
    this.notice = "";
    await this.run(async (epoch) => {
      const result = await this.api(
        "/v1/connections/news/curation/review",
        "POST",
        input,
      );
      if (epoch === this.epoch) this.editReview = result;
    });
  }
  async saveStory() {
    this.clearPublication();
    if (!this.editReview || !this.curateConfirmed) return;
    const id = this.editReview.id;
    await this.run(async (epoch) => {
      this.editReview = null;
      this.edit = null;
      this.preview = null;
      this.curateConfirmed = false;
      this.articles = [];
      this.checkedAt = null;
      try {
        const result = await this.api(
          "/v1/connections/news/curation/confirm",
          "POST",
          { id, confirmed: true, curate: true },
        );
        if (epoch === this.epoch) {
          this.preview = result.preview;
          this.notice =
            "Saved to your private News preview. Nothing was published or sent.";
        }
      } catch {
        if (epoch === this.epoch)
          this.error =
            "The save could not be confirmed. Load your private preview to check its current text before reviewing another edit. The save will not be retried automatically.";
      }
    });
  }

  async reviewPublication() {
    if (this.busy) return;
    this.hide();
    await this.run(async (epoch) => {
      try {
        const result = await this.api(
          "/v1/connections/news/publication/review",
          "POST",
          {},
        );
        if (epoch === this.epoch) this.publicReview = result;
        else this.cancelPublicReview(result.id);
      } catch {
        if (epoch === this.epoch)
          this.publicationError =
            "A public review could not be loaded. Load publication history to check any unconfirmed operation, or check the preview and publishing permission in News.";
      }
    });
  }
  async cancelPublication() {
    this.hide();
  }
  async publish() {
    if (
      this.busy ||
      !this.publicReview ||
      !this.publicationConfirmed ||
      !this.publicReview.source.eligibility.eligible
    )
      return;
    const pending = this.publicReview;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.hide();
      return;
    }
    // This is the sole write call. Focus loss after dispatch cannot undo the source commit.
    this.publicReview = null;
    this.publicationConfirmed = false;
    this.publicationHistory = null;
    this.publicationRecord = null;
    this.publicationNotice =
      "Publication requested. Closing this view cannot cancel an accepted request.";
    await this.run(async (epoch) => {
      try {
        const record = await this.api(
          "/v1/connections/news/publication/confirm",
          "POST",
          { id: pending.id, confirmed: true, audience: "public" },
        );
        if (epoch === this.epoch) {
          this.publicationRecord = record;
          this.publicationNotice =
            "Publication recorded. The receipt confirms a past publication, not its current visibility or delivery.";
        }
      } catch {
        if (epoch === this.epoch) {
          this.publicationNotice = "";
          this.publicationError =
            "Publication could not be confirmed. Load publication history, then check the receipt if an entry exists. Nothing will be resent automatically; an absent record does not prove a request failed.";
        }
      }
    });
  }
  async loadPublicationHistory() {
    if (this.busy) return;
    this.clearPublication();
    await this.run(async (epoch) => {
      try {
        const result = await this.api(
          "/v1/connections/news/publication/history",
        );
        if (epoch === this.epoch) this.publicationHistory = result.items;
      } catch {
        if (epoch === this.epoch)
          this.publicationError =
            "Publication history could not be read on this Mac. No source request was resent.";
      }
    });
  }
  async openPublication(operationId: string) {
    if (this.busy) return;
    this.publicationRecord = null;
    this.deletePublicationConfirmed = false;
    this.publicationError = "";
    await this.run(async (epoch) => {
      try {
        const record = await this.api(
          "/v1/connections/news/publication/history/" +
            encodeURIComponent(operationId),
        );
        if (epoch === this.epoch) this.publicationRecord = record;
      } catch {
        if (epoch === this.epoch)
          this.publicationError =
            "This local publication record could not be read. Nothing was resent.";
      }
    });
  }
  async checkPublicationReceipt() {
    if (this.busy || !this.publicationRecord) return;
    const operationId = this.publicationRecord.operationId;
    this.deletePublicationConfirmed = false;
    this.publicationError = "";
    await this.run(async (epoch) => {
      try {
        const record = await this.api(
          "/v1/connections/news/publication/reconcile",
          "POST",
          { operationId },
        );
        if (epoch === this.epoch) {
          this.publicationRecord = record;
          this.publicationHistory =
            this.publicationHistory?.map((r) =>
              r.operationId === operationId
                ? {
                    ...r,
                    receipt: record.receipt,
                    lastCheckedAt: record.lastCheckedAt,
                  }
                : r,
            ) ?? null;
          this.publicationNotice = record.receipt
            ? "Historical publication receipt found. Current visibility and delivery are not verified."
            : "No receipt was found. This remains unconfirmed; the request may still be in flight. Nothing was resent.";
        }
      } catch {
        if (epoch === this.epoch)
          this.publicationError =
            "The receipt could not be checked. Reconnect a valid read key for this News account if needed. The operation remains tracked; nothing was resent.";
      }
    });
  }
  async deletePublication() {
    if (
      this.busy ||
      !this.publicationRecord ||
      !this.deletePublicationConfirmed
    )
      return;
    const operationId = this.publicationRecord.operationId;
    this.deletePublicationConfirmed = false;
    this.publicationError = "";
    await this.run(async (epoch) => {
      try {
        await this.api("/v1/connections/news/publication/delete", "POST", {
          operationId,
          confirmed: true,
          forgetPublicationTracking: true,
        });
        if (epoch === this.epoch) {
          this.publicationRecord = null;
          this.publicationHistory =
            this.publicationHistory?.filter(
              (r) => r.operationId !== operationId,
            ) ?? null;
          this.publicationNotice =
            "Local publication record deleted. News content and saved backup copies were not removed; any accepted publication continues.";
        }
      } catch {
        if (epoch === this.epoch)
          this.publicationError =
            "Local deletion could not be confirmed. Reload publication history to check. Nothing was published or withdrawn by this request.";
      }
    });
  }
}
