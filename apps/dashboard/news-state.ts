import type {
  NewsArticle,
  NewsConnection,
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
    this.changed();
  }
  edit(token: string) {
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
}
