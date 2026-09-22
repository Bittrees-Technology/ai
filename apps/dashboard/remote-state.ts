export type RemoteTask = {
  id: string;
  revision: number;
  status: string;
  input: { prompt?: string };
};
export type RemoteConnection = {
  deviceId: string;
  ownerId: string;
  expiresAt: number;
  state: string;
  pendingDelivery: boolean;
  backgroundReceiving?: boolean;
  controls?: "unavailable" | "disabled" | "enabled" | "confirmation_required";
};
export type RemoteState = {
  available: boolean | null;
  connection: RemoteConnection | null;
  receiver?: {
    state: string;
    lastCheckedAt: number | null;
    nextCheckAt: number | null;
    received: number;
  };
  pending: { id: string; approvalCode: string; expiresAt: number } | null;
  tasks: RemoteTask[];
  tasksLoaded: boolean;
  selected: string[];
  reviewed: boolean;
  busy: boolean;
  error: string;
  notice: string;
};
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
const messages: Record<string, string> = {
  CONTROL_CONFIRMATION_REQUIRED:
    "Disable the incomplete permission, approve pause/cancel on ai.bittrees.org, then confirm it here again.",
  PAIRING_REQUIRED:
    "Remove this local connection, revoke the old device on ai.bittrees.org, then pair again.",
  PENDING_DELIVERY:
    "A previous delivery needs attention. Retry it before sharing new statuses.",
  STORAGE_UNAVAILABLE:
    "The Mac could not read or save this connection. Check Keychain access and reopen the companion.",
  DENIED:
    "Remote access was denied. Check the device connection on ai.bittrees.org.",
  BUSY: "Another connection action is still running.",
  CONFLICT:
    "A selected task changed. Load the tasks and review your selection again.",
  NOT_FOUND: "A selected task is no longer available. Load the tasks again.",
};
/** View state has no durable credentials; focus loss invalidates all outstanding preview responses. */
export class RemotePanelState {
  state: RemoteState = {
    available: null,
    connection: null,
    pending: null,
    tasks: [],
    tasksLoaded: false,
    selected: [],
    reviewed: false,
    busy: false,
    error: "",
    notice: "",
  };
  private epoch = 0;
  constructor(
    private api: Api,
    private changed: (s: RemoteState) => void,
    private now = Date.now,
  ) {}
  private set(patch: Partial<RemoteState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  hide() {
    this.epoch++;
    this.set({
      pending: null,
      tasks: [],
      tasksLoaded: false,
      selected: [],
      reviewed: false,
      notice: "",
      error: "",
    });
  }
  select(id: string) {
    if (this.state.busy) return;
    this.set({
      selected: this.state.selected.includes(id)
        ? this.state.selected.filter((x) => x !== id)
        : [...this.state.selected, id],
      reviewed: false,
    });
  }
  review(value: boolean) {
    if (!this.state.busy) this.set({ reviewed: value });
  }
  private async act(fn: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const epoch = this.epoch;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await fn(() => this.epoch === epoch);
    } catch (e) {
      if (this.epoch === epoch)
        this.set({
          error:
            messages[e instanceof Error ? e.message : ""] ??
            "This action could not be completed. Refresh the connection before trying again.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  async refresh() {
    return this.act(async (current) => {
      const status = await this.api("/v1/remote");
      if (current())
        this.set({
          receiver: status.receiver,
          available: status.available,
          connection: status.connection,
        });
    });
  }
  async begin() {
    return this.act(async (current) => {
      this.set({ pending: null });
      const pending = await this.api("/v1/remote/begin", "POST", {
        confirmed: true,
      });
      if (current() && pending.expiresAt > this.now()) this.set({ pending });
    });
  }
  async finish(account: string) {
    return this.act(async (current) => {
      this.set({ pending: null });
      const connection = await this.api("/v1/remote/finish", "POST", {
        expectedOwnerId: account.trim(),
        confirmed: true,
      });
      if (current())
        this.set({
          connection,
          notice:
            "This Mac is paired. No task statuses have been shared automatically.",
        });
    });
  }
  async loadTasks() {
    return this.act(async (current) => {
      this.set({
        tasks: [],
        tasksLoaded: false,
        selected: [],
        reviewed: false,
      });
      const result = await this.api("/v1/requests");
      if (current()) this.set({ tasks: result.items, tasksLoaded: true });
    });
  }
  async publish() {
    if (!this.state.reviewed || !this.state.selected.length) return;
    const tasks = this.state.tasks
      .filter((t) => this.state.selected.includes(t.id))
      .map((t) => ({ id: t.id, revision: t.revision }));
    return this.act(async (current) => {
      this.set({ reviewed: false });
      await this.api("/v1/remote/publish", "POST", { confirmed: true, tasks });
      const status = await this.api("/v1/remote");
      if (current())
        this.set({
          connection: status.connection,
          tasks: [],
          tasksLoaded: false,
          selected: [],
          notice: "Selected task statuses shared.",
        });
    });
  }
  async retry() {
    return this.act(async (current) => {
      await this.api("/v1/remote/retry", "POST", { confirmed: true });
      const status = await this.api("/v1/remote");
      if (current())
        this.set({
          connection: status.connection,
          notice: "Previous status delivery confirmed.",
        });
    });
  }
  async controls(action: "enable" | "disable" | "check", confirmed: boolean) {
    if (!confirmed) return;
    return this.act(async (current) => {
      const result = await this.api(`/v1/remote/controls/${action}`, "POST", {
        confirmed: true,
      });
      const status = await this.api("/v1/remote");
      if (current())
        this.set({
          connection: status.connection,
          notice:
            action === "enable"
              ? "Remote pause/cancel enabled. Check manually or separately opt in to background receiving."
              : action === "disable"
                ? "Pause/cancel disabled on this Mac and the remote service."
                : `${result.receipts.length} command receipt(s) confirmed. Refresh Tasks to see current work.`,
        });
    });
  }
  async receiving(enabled: boolean, confirmed: boolean) {
    if (!confirmed) return;
    return this.act(async (current) => {
      await this.api("/v1/remote/controls/receiving", "POST", {
        enabled,
        confirmed: true,
      });
      const status = await this.api("/v1/remote");
      if (current())
        this.set({
          connection: status.connection,
          receiver: status.receiver,
          notice: enabled
            ? "Background receiving enabled while this companion is running. It resumes after restart while permission remains valid."
            : "Background receiving stopped. Manual command checks remain available.",
        });
    });
  }
  async rotate() {
    return this.act(async (current) => {
      const connection = await this.api("/v1/remote/rotate", "POST", {
        confirmed: true,
      });
      if (current())
        this.set({
          connection,
          notice: "Connection key replaced. Its expiry is unchanged.",
        });
    });
  }
  async forget() {
    return this.act(async (current) => {
      await this.api("/v1/remote/local", "DELETE", undefined, {
        "X-Confirm-Delete": "local-remote-connection-only",
      });
      if (current())
        this.set({
          receiver: undefined,
          connection: null,
          pending: null,
          tasks: [],
          tasksLoaded: false,
          selected: [],
          reviewed: false,
          notice:
            "Removed from this Mac. Revoke the device on ai.bittrees.org to remove remote access and stored status.",
        });
    });
  }
}
