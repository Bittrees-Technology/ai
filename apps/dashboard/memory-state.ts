export type MemoryMatch = {
  id: string;
  text: string;
  type: string;
  verified: false;
  sources: {
    app: string;
    resourceId: string;
    revision: string;
    tenantId: string;
  }[];
  why: {
    relevance: number;
    freshness: number;
    usefulness: number;
    pinned: boolean;
    provenance: string;
    reviewed: boolean;
  };
};
export class MemorySearchController {
  query = "";
  results: MemoryMatch[] = [];
  searched = false;
  busy = false;
  private epoch = 0;
  constructor(
    private api: (path: string, method: string, body: unknown) => Promise<any>,
    private changed: () => void = () => {},
  ) {}
  edit(query: string) {
    this.epoch++;
    this.query = query;
    this.results = [];
    this.searched = false;
    this.changed();
  }
  hide() {
    this.edit("");
  }
  async search() {
    if (this.busy || !this.query.trim() || this.query.length > 512) return;
    const epoch = this.epoch;
    this.busy = true;
    this.results = [];
    this.searched = false;
    this.changed();
    try {
      const result = await this.api("/v1/memories/search", "POST", {
        query: this.query.trim(),
      });
      if (epoch !== this.epoch) return;
      this.results = result.items;
      this.searched = true;
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
