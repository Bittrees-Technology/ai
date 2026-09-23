export type PeerStatus = {
  available: boolean;
  canSetup: boolean;
  revision: number;
  keyRevision: number;
  needsFreshPairing: boolean;
  hasSelectedKey: boolean;
  peers: {
    peerId: string;
    keyEpoch: number;
    fingerprint: string;
    revoked: boolean;
  }[];
};
export type PeerReview = {
  id: string;
  action: "approve" | "revoke";
  expiresAt: number;
  binding: { ownerId: string; deviceId: string } | null;
  fingerprint: string;
  peerId: string;
  keyEpoch: number | null;
  replaces: { keyEpoch: number; fingerprint: string; revoked: boolean } | null;
};
export type PeerInvitation = {
  invitation: { expiresAt: number; [key: string]: unknown };
  fingerprint: string;
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class PrivatePeerPanelState {
  state: {
    status: PeerStatus | null;
    review: PeerReview | null;
    invitation: PeerInvitation | null;
    busy: boolean;
    error: string;
    notice: string;
  } = {
    status: null,
    review: null,
    invitation: null,
    busy: false,
    error: "",
    notice: "",
  };
  private generation = 0;
  constructor(
    private api: Api,
    private changed: (state: PrivatePeerPanelState["state"]) => void,
    private now = Date.now,
  ) {}
  private set(patch: Partial<PrivatePeerPanelState["state"]>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  hide() {
    this.generation++;
    this.set({ review: null, invitation: null, error: "", notice: "" });
  }
  private async act(fn: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await fn(() => generation === this.generation);
    } catch (error) {
      if (generation === this.generation)
        this.set({
          status: null,
          review: null,
          invitation: null,
          error:
            error instanceof Error && error.message === "REPAIR_REQUIRED"
              ? "Restored trust needs fresh pairing. Recovery is not available in this build yet."
              : "The device change could not be confirmed. Refresh saved devices and review again; no automatic retry was made.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  async refresh() {
    return this.act(async (current) => {
      this.set({ review: null, invitation: null });
      const status = await this.api("/v1/private-peers");
      if (current()) this.set({ status });
    });
  }
  async invite(recipientId: string) {
    const status = this.state.status;
    if (!status) return;
    return this.act(async (current) => {
      this.set({ review: null, invitation: null });
      const invitation = await this.api(
        "/v1/private-peers/invitation",
        "POST",
        {
          recipientId: recipientId.trim(),
          expectedKeyRevision: status.keyRevision,
          confirmed: true,
        },
      );
      if (current() && invitation.invitation.expiresAt > this.now())
        this.set({ invitation });
    });
  }
  async prepare(action: "approve" | "revoke", value: string) {
    const status = this.state.status;
    if (!status) return;
    return this.act(async (current) => {
      this.set({ review: null, invitation: null });
      const body =
        action === "approve"
          ? {
              action,
              expectedRevision: status.revision,
              expectedKeyRevision: status.keyRevision,
              invitation: JSON.parse(value),
            }
          : { action, expectedRevision: status.revision, peerId: value };
      const review = await this.api("/v1/private-peers/review", "POST", body);
      if (current() && review.expiresAt > this.now()) this.set({ review });
    });
  }
  async confirm(acknowledged: boolean, comparedFingerprint: string) {
    const review = this.state.review;
    if (!acknowledged || !review) return;
    if (review.expiresAt <= this.now()) {
      this.set({
        review: null,
        error: "This review expired. Review the invitation again.",
      });
      return;
    }
    const compared = comparedFingerprint.replace(/\s/g, "").toLowerCase();
    if (review.action === "approve" && compared !== review.fingerprint) return;
    return this.act(async (current) => {
      this.set({ review: null });
      const status = await this.api("/v1/private-peers/confirm", "POST", {
        reviewId: review.id,
        confirmed: true,
        acknowledged: true,
        ...(review.action === "approve"
          ? { comparedFingerprint: compared }
          : {}),
      });
      if (current())
        this.set({
          status,
          notice:
            review.action === "approve"
              ? "Public key saved on this Mac. The other device must separately review this Mac. Private task access is not enabled."
              : "Device trust revoked on this Mac. Remote copies and permissions are unchanged.",
        });
    });
  }
}
