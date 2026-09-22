import type { LocalTemplate } from "../../modules/storage/templates.js";
type RemotePermission = {
  permissionId: string;
  templateId: string;
  templateRevision: number;
  expiresAt: number;
  maxRuns: number;
  pendingDelivery: boolean;
  backgroundReceiving?: boolean;
  state: string;
};
type RemoteStatus = {
  available: boolean;
  templateReceiver?: {
    state: string;
    lastCheckedAt: number | null;
    nextCheckAt: number | null;
    received: number;
  };
  connection: null | {
    deviceId: string;
    ownerId: string;
    epoch: number;
    expiresAt: number;
    state: string;
    templates: RemotePermission[];
  };
};
type RemoteReview = {
  templateId: string;
  expectedRevision: number;
  maxRuns: number;
  expiresAt: number;
  expectedConnection: { deviceId: string; ownerId: string; epoch: number };
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class TemplateController {
  items: LocalTemplate[] = [];
  draft: LocalTemplate | null = null;
  confirmed = false;
  busy = false;
  remote: RemoteStatus | null = null;
  remoteReview: RemoteReview | null = null;
  remoteConfirmed = false;
  remoteAction: {
    permissionId: string;
    action: "retry" | "revoke" | "check" | "start-receiving" | "stop-receiving";
  } | null = null;
  notice = "";
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
    this.resetRemoteReview();
    this.remote = null;
    this.notice = "";
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
    this.resetRemoteReview();
    this.changed();
  }
  edit(change: Partial<LocalTemplate["definition"]>) {
    if (!this.draft || this.busy) return;
    this.draft = {
      ...this.draft,
      definition: { ...this.draft.definition, ...change },
    };
    this.confirmed = false;
    this.resetRemoteReview();
    this.changed();
  }
  confirm(value: boolean) {
    this.confirmed = value;
    this.changed();
  }
  resetRemoteReview() {
    this.remoteReview = null;
    this.remoteConfirmed = false;
    this.remoteAction = null;
  }
  confirmRemote(value: boolean) {
    this.remoteConfirmed = value;
    this.changed();
  }
  async refreshRemote() {
    this.resetRemoteReview();
    return this.operation(
      () => this.api("/v1/remote"),
      (result: RemoteStatus) => {
        this.remote = result;
        this.notice = "";
      },
    );
  }
  reviewRemote(maxRuns: number, minutes: number, now = Date.now()) {
    const connection = this.remote?.connection;
    if (
      this.busy ||
      !this.saved ||
      !this.draft ||
      !this.remote?.available ||
      connection?.state !== "paired" ||
      connection.expiresAt <= now ||
      !Number.isInteger(maxRuns) ||
      maxRuns < 1 ||
      maxRuns > 20 ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 1440 ||
      connection.templates.some((t) => t.templateId === this.draft!.id)
    )
      throw Error("TEMPLATE_CONFIRMATION_REQUIRED");
    this.resetRemoteReview();
    this.remoteReview = {
      templateId: this.draft.id,
      expectedRevision: this.draft.revision,
      maxRuns,
      expiresAt: Math.min(now + minutes * 60000, connection.expiresAt),
      expectedConnection: {
        deviceId: connection.deviceId,
        ownerId: connection.ownerId,
        epoch: connection.epoch,
      },
    };
    this.changed();
  }
  async shareRemote() {
    const review = this.remoteReview;
    if (
      !review ||
      !this.remoteConfirmed ||
      !this.saved ||
      this.draft?.id !== review.templateId ||
      this.draft.revision !== review.expectedRevision ||
      review.expiresAt <= Date.now()
    )
      throw Error("TEMPLATE_CONFIRMATION_REQUIRED");
    const input = structuredClone(review);
    return this.operation(
      () =>
        this.api("/v1/remote/templates/share", "POST", {
          ...input,
          confirmed: true,
        }),
      (connection) => {
        this.remote = { available: true, connection };
        this.resetRemoteReview();
        this.notice =
          "Permission saved. Match this template code on the remote page. Background template receiving is off; use Check requests here for a delivery pass.";
      },
    );
  }
  reviewRemoteAction(
    permissionId: string,
    action: "retry" | "revoke" | "check" | "start-receiving" | "stop-receiving",
  ) {
    const entry = this.remote?.connection?.templates.find(
      (t) => t.permissionId === permissionId,
    );
    if (
      this.busy ||
      !entry ||
      (action === "retry" && entry.state !== "publication_pending") ||
      ((action === "check" || action === "start-receiving") &&
        entry.state !== "active")
    )
      return;
    this.resetRemoteReview();
    this.remoteAction = { permissionId, action };
    this.changed();
  }
  async applyRemoteAction(confirmed: boolean) {
    const review = this.remoteAction;
    if (!confirmed || !review) return;
    return this.operation(
      async () => {
        const result = await this.api(
          `/v1/remote/templates/${review.action.endsWith("receiving") ? "receiving" : review.action}`,
          "POST",
          {
            permissionId: review.permissionId,
            confirmed: true,
            ...(review.action.endsWith("receiving")
              ? { enabled: review.action === "start-receiving" }
              : {}),
          },
        );
        const remote = await this.api("/v1/remote");
        return { result, remote };
      },
      ({ result, remote }) => {
        this.remote = remote;
        this.resetRemoteReview();
        this.notice =
          review.action === "check"
            ? `${result.receipts.length} receipt(s) returned. Queued means a local task was created; check Tasks for its result.`
            : review.action === "revoke"
              ? "Permission revoked locally and confirmed by the remote service."
              : review.action === "start-receiving"
                ? "Background receiving enabled for this permission while the companion is running. It resumes on restart only while permission remains valid."
                : review.action === "stop-receiving"
                  ? "Background receiving stopped for this permission. Existing tasks continue; revoke permission to cancel unfinished dependent tasks."
                  : "The original permission publication was confirmed.";
      },
    );
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
    this.resetRemoteReview();
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
        this.resetRemoteReview();
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
        this.resetRemoteReview();
      },
    );
  }
}
