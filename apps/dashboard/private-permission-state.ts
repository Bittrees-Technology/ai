export type PermissionChoices = {
  peerId: string;
  peerKeyEpoch: number;
  receiveTasks: boolean;
  sendTasks: boolean;
  sendReceipts: boolean;
  sendResults: boolean;
  modelProfileId: string | null;
  expiresAt: number;
};
export type PermissionStatus = {
  available: boolean;
  canSetup: boolean;
  revision: number;
  keyRevision: number;
  peerRevision: number;
  needsFreshPairing: boolean;
  hasSelectedKey: boolean;
  peers: { peerId: string; keyEpoch: number; fingerprint: string }[];
  profiles: { id: string; model: string }[];
  grants: { id: string; choices: PermissionChoices; state: string }[];
};
export type PermissionReview = {
  id: string;
  action: "grant" | "revoke";
  expiresAt: number;
  peerId: string;
  choices: PermissionChoices | null;
  binding: { ownerId: string; deviceId: string } | null;
  fingerprint: string | null;
  model: string | null;
};
export type PermissionForm = {
  peerId: string;
  receiveTasks: boolean;
  sendTasks: boolean;
  sendReceipts: boolean;
  sendResults: boolean;
  modelProfileId: string | null;
  minutes: 15 | 60;
};
export const emptyPermissionForm = (): PermissionForm => ({
  peerId: "",
  receiveTasks: false,
  sendTasks: false,
  sendReceipts: false,
  sendResults: false,
  modelProfileId: null,
  minutes: 15,
});
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class PrivatePermissionPanelState {
  state: {
    status: PermissionStatus | null;
    review: PermissionReview | null;
    busy: boolean;
    error: string;
    notice: string;
  } = { status: null, review: null, busy: false, error: "", notice: "" };
  private generation = 0;
  constructor(
    private api: Api,
    private changed: (state: PrivatePermissionPanelState["state"]) => void,
    private now = Date.now,
  ) {}
  private set(p: Partial<PrivatePermissionPanelState["state"]>) {
    this.state = { ...this.state, ...p };
    this.changed(this.state);
  }
  hide() {
    this.generation++;
    this.set({ review: null, error: "", notice: "" });
  }
  private async act(work: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await work(() => generation === this.generation);
    } catch {
      if (generation === this.generation)
        this.set({
          status: null,
          review: null,
          error:
            "The permission change could not be confirmed. Refresh saved choices and review again. No automatic retry was made.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  async refresh() {
    return this.act(async (current) => {
      this.set({ review: null });
      const status = await this.api("/v1/private-task-permissions");
      if (current()) this.set({ status });
    });
  }
  async prepare(form: PermissionForm) {
    const status = this.state.status,
      peer = status?.peers.find((p) => p.peerId === form.peerId);
    if (!status || !peer) return;
    return this.act(async (current) => {
      this.set({ review: null });
      const review = await this.api(
        "/v1/private-task-permissions/review",
        "POST",
        {
          action: "grant",
          expectedRevision: status.revision,
          expectedKeyRevision: status.keyRevision,
          expectedPeerRevision: status.peerRevision,
          ...form,
          peerKeyEpoch: peer.keyEpoch,
        },
      );
      if (current() && review.expiresAt > this.now()) this.set({ review });
    });
  }
  async revoke(peerId: string) {
    const status = this.state.status;
    if (!status) return;
    return this.act(async (current) => {
      this.set({ review: null });
      const review = await this.api(
        "/v1/private-task-permissions/review",
        "POST",
        { action: "revoke", expectedRevision: status.revision, peerId },
      );
      if (current() && review.expiresAt > this.now()) this.set({ review });
    });
  }
  async confirm(acknowledged: boolean) {
    const review = this.state.review;
    if (!review || !acknowledged) return;
    if (review.expiresAt <= this.now()) {
      this.set({
        review: null,
        error: "This review expired. Review the permission change again.",
      });
      return;
    }
    return this.act(async (current) => {
      this.set({ review: null });
      const status = await this.api(
        "/v1/private-task-permissions/confirm",
        "POST",
        { reviewId: review.id, confirmed: true, acknowledged: true },
      );
      if (current())
        this.set({
          status,
          notice:
            review.action === "grant"
              ? "Permission choices saved on this Mac. Private task delivery is not active in this build."
              : "Permission revoked on this Mac. Already accepted local tasks and prior copies are unchanged.",
        });
    });
  }
}
