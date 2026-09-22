import type { LocalTemplate } from "../../modules/storage/templates.js";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class TemplateController {
  items: LocalTemplate[] = [];
  draft: LocalTemplate | null = null;
  confirmed = false;
  busy = false;
  private epoch = 0;
  private pending: {
    id: string;
    revision: number;
    invocationId: string;
  } | null = null;
  constructor(
    private api: Api,
    private changed: () => void = () => {},
  ) {}
  hide() {
    this.epoch++;
    this.items = [];
    this.draft = null;
    this.confirmed = false;
    this.changed();
  }
  select(item?: LocalTemplate) {
    if (this.busy) return;
    this.draft = item
      ? structuredClone(item)
      : {
          id: crypto.randomUUID(),
          revision: 0,
          definition: {
            name: "",
            kind: "query",
            prompt: "",
            modelProfileId: "",
          },
        };
    this.confirmed = false;
    this.changed();
  }
  edit(change: Partial<LocalTemplate["definition"]>) {
    if (!this.draft || this.busy) return;
    this.draft = {
      ...this.draft,
      definition: { ...this.draft.definition, ...change },
    };
    this.confirmed = false;
    this.changed();
  }
  confirm(value: boolean) {
    this.confirmed = value;
    this.changed();
  }
  get saved() {
    return (
      !!this.draft &&
      this.items.some(
        (item) =>
          item.id === this.draft?.id &&
          item.revision === this.draft?.revision &&
          JSON.stringify(item.definition) ===
            JSON.stringify(this.draft?.definition),
      )
    );
  }
  private async operation<T>(
    work: () => Promise<T>,
    apply: (value: T) => void,
  ): Promise<T | undefined> {
    if (this.busy) throw Error("CONFLICT");
    const epoch = this.epoch;
    this.busy = true;
    this.changed();
    try {
      const result = await work();
      if (epoch !== this.epoch) return undefined;
      apply(result);
      return result;
    } catch (error) {
      if (epoch === this.epoch) throw error;
      return undefined;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async load() {
    this.draft = null;
    this.confirmed = false;
    return this.operation(
      () => this.api("/v1/templates"),
      (result) => {
        this.items = result.items;
      },
    );
  }
  async save() {
    if (!this.draft || !this.confirmed) throw Error("INVALID_INPUT");
    const draft = structuredClone(this.draft);
    return this.operation(
      () =>
        this.api("/v1/templates", "PUT", {
          id: draft.id,
          expectedRevision: draft.revision,
          definition: draft.definition,
          confirmed: true,
        }),
      (result: LocalTemplate) => {
        this.items = [
          ...this.items.filter((item) => item.id !== result.id),
          result,
        ];
        this.draft = result;
        this.confirmed = false;
      },
    );
  }
  async run() {
    if (!this.draft || !this.confirmed || !this.saved)
      throw Error("INVALID_INPUT");
    const { id, revision } = this.draft;
    if (this.pending?.id !== id || this.pending?.revision !== revision)
      this.pending = { id, revision, invocationId: crypto.randomUUID() };
    const intent = this.pending;
    return this.operation(
      () =>
        this.api(`/v1/templates/${id}/run`, "POST", {
          expectedRevision: revision,
          invocationId: intent.invocationId,
          confirmed: true,
        }),
      () => {
        this.pending = null;
        this.confirmed = false;
      },
    );
  }
  async remove() {
    if (!this.draft || !this.confirmed || !this.saved)
      throw Error("INVALID_INPUT");
    const { id, revision } = this.draft;
    return this.operation(
      () =>
        this.api(`/v1/templates/${id}`, "DELETE", {
          expectedRevision: revision,
          confirmed: true,
        }),
      () => {
        this.items = this.items.filter((item) => item.id !== id);
        this.draft = null;
        this.confirmed = false;
      },
    );
  }
}
