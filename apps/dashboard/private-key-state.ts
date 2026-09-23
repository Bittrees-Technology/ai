export type KeyAction =
  "create" | "replace" | "resume" | "remove" | "revoke" | "cleanup";
export type KeyStatus = {
  available: boolean;
  canSetup: boolean;
  state: {
    revision: number;
    needsFreshPairing: boolean;
    pendingKeyDeletionCount: number;
    slots: {
      id: string;
      keyEpoch: number;
      createdAt: number;
      state: string;
      publicKey: string | null;
    }[];
  };
};
export type KeyReview = {
  id: string;
  action: KeyAction;
  keyId?: string;
  expiresAt: number;
  binding: { ownerId: string; deviceId: string } | null;
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const errors: Record<string, string> = {
  DENIED: "The key change was not authorized. Refresh and review it again.",
  CONFLICT: "The saved keys changed. Refresh before reviewing another change.",
  REPAIR_REQUIRED:
    "These keys need fresh pairing after restore or deletion. This development build cannot complete that recovery yet.",
  PAIRING_REQUIRED:
    "Pair this Mac with ai.bittrees.org before setting up a device key.",
  STORAGE_UNAVAILABLE:
    "Key storage could not be confirmed. Refresh to see any unfinished setup or cleanup before trying again.",
  CREATION_INCOMPLETE:
    "The interrupted key was not saved. Review a replacement key; the old slot will not be reused.",
  CAPACITY:
    "The retained-key limit has been reached. Existing keys were preserved.",
  BUSY: "Another key or connection action is still running.",
};
export class PrivateKeyPanelState {
  state: {
    status: KeyStatus | null;
    review: KeyReview | null;
    busy: boolean;
    error: string;
    notice: string;
  } = { status: null, review: null, busy: false, error: "", notice: "" };
  private generation = 0;
  constructor(
    private api: Api,
    private changed: (state: PrivateKeyPanelState["state"]) => void,
    private now = Date.now,
  ) {}
  private set(p: Partial<PrivateKeyPanelState["state"]>) {
    this.state = { ...this.state, ...p };
    this.changed(this.state);
  }
  hide() {
    this.generation++;
    this.set({ review: null, error: "", notice: "" });
  }
  private async act(fn: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await fn(() => generation === this.generation);
    } catch (e) {
      if (generation === this.generation)
        this.set({
          review: null,
          status: null,
          error:
            errors[e instanceof Error ? e.message : ""] ??
            "The change could not be confirmed. Refresh saved keys before trying again.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  async refresh() {
    return this.act(async (current) => {
      this.set({ review: null });
      const status = await this.api("/v1/private-keys");
      if (current()) this.set({ status });
    });
  }
  async prepare(action: KeyAction, keyId?: string) {
    const status = this.state.status;
    if (!status) return;
    return this.act(async (current) => {
      this.set({ review: null });
      const review = await this.api("/v1/private-keys/review", "POST", {
        action,
        expectedRevision: status.state.revision,
        ...(keyId ? { keyId } : {}),
      });
      if (current() && review.expiresAt > this.now()) this.set({ review });
    });
  }
  async confirm(acknowledged: boolean) {
    const review = this.state.review;
    if (!acknowledged || !review) return;
    if (review.expiresAt <= this.now()) {
      this.set({
        review: null,
        error: "This review expired. Review the key change again.",
      });
      return;
    }
    return this.act(async (current) => {
      this.set({ review: null });
      const status = await this.api("/v1/private-keys/confirm", "POST", {
        reviewId: review.id,
        confirmed: true,
        acknowledged: true,
      });
      if (current())
        this.set({
          status,
          notice: ["create", "replace", "resume"].includes(review.action)
            ? "Device key saved on this Mac. Private task access is not enabled."
            : review.action === "revoke"
              ? "Key disabled locally. Remote revocation is a separate action."
              : "Local key cleanup completed. Remote copies and prior exports are unchanged.",
        });
    });
  }
}
