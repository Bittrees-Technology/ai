import type {
  NewsArticle,
  NewsConnection,
  NewsPreview,
  NewsEditInput,
  NewsEditReview,
} from "../../modules/connectors/news.js";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class NewsConnectionController {
  status: {
    available: boolean;
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
  private epoch = 0;
  constructor(
    private api: Api,
    private changed: () => void = () => {},
  ) {}
  hide() {
    this.epoch++;
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
}
