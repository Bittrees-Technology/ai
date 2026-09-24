export type ConversationDirections = {
  messagesToMac: boolean;
  messagesToBrowser: boolean;
  questionsToBrowser: boolean;
  answersToMac: boolean;
};
export type ConversationChoices = {
  peerId: string;
  peerKeyEpoch: number;
  conversationId: string;
  inboxId: string;
  permissions: ConversationDirections;
  expiresAt: number;
};
export type ConversationPermissionStatus = {
  available: boolean;
  canSetup: boolean;
  revision: number;
  keyRevision: number;
  peerRevision: number;
  needsFreshPairing: boolean;
  hasSelectedKey: boolean;
  peers: { peerId: string; keyEpoch: number; fingerprint: string }[];
  grants: { id: string; choices: ConversationChoices; state: string }[];
};
export type ConversationPermissionReview = {
  id: string;
  action: "grant" | "revoke";
  expiresAt: number;
  peerId: string;
  permissionId: string | null;
  choices: ConversationChoices;
  binding: { ownerId: string; deviceId: string };
  fingerprint: string;
};
export const emptyConversationForm = () => ({
  peerId: "",
  minutes: 15 as 15 | 60,
  permissions: {
    messagesToMac: false,
    messagesToBrowser: false,
    questionsToBrowser: false,
    answersToMac: false,
  },
});
export type ConversationForm = ReturnType<typeof emptyConversationForm>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const endpoint = "/v1/private-conversation-permissions";
export class ConversationPermissionPanelState {
  status: ConversationPermissionStatus | null = null;
  review: ConversationPermissionReview | null = null;
  busy = false;
  error = "";
  notice = "";
  private generation = 0;
  private disposed = false;
  private received = { wall: 0, mono: 0 };
  private scope: { inboxId: string; conversationId: string };
  constructor(
    private api: Api,
    scope: { inboxId: string; conversationId: string },
    private changed: () => void,
    private now = Date.now,
    private mono = () => performance.now(),
  ) {
    this.scope = { ...scope };
  }
  private render() {
    if (!this.disposed) this.changed();
  }
  hide() {
    this.generation++;
    this.review = null;
    this.status = null;
    this.error = "";
    this.notice = "";
    this.render();
  }
  dispose() {
    this.disposed = true;
    this.hide();
  }
  invalidateReview() {
    this.generation++;
    this.review = null;
    this.error = "";
    this.notice = "";
    this.render();
  }
  private validReview() {
    return (
      this.review &&
      this.now() >= this.received.wall &&
      this.now() < this.review.expiresAt &&
      this.mono() >= this.received.mono &&
      this.mono() - this.received.mono <
        this.review.expiresAt - this.received.wall
    );
  }
  expire() {
    if (this.review && !this.validReview()) {
      this.invalidateReview();
      this.notice =
        "This review expired. Review the conversation permissions again.";
      this.render();
    }
  }
  private async act(work: (current: () => boolean) => Promise<void>) {
    if (this.busy || this.disposed) return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.render();
    const current = () => generation === this.generation && !this.disposed;
    try {
      await work(current);
    } catch {
      if (current()) {
        this.status = null;
        this.review = null;
        this.error =
          "The change could not be confirmed. Refresh saved conversation choices before reviewing again. No automatic retry was made.";
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }
  async refresh() {
    this.invalidateReview();
    return this.act(async (current) => {
      const status = await this.api(endpoint);
      if (current()) this.status = status;
    });
  }
  private accept(review: ConversationPermissionReview, current: () => boolean) {
    if (
      !current() ||
      review.expiresAt <= this.now() ||
      review.expiresAt > this.now() + 300000 ||
      review.choices.inboxId !== this.scope.inboxId ||
      review.choices.conversationId !== this.scope.conversationId
    )
      return;
    this.received = { wall: this.now(), mono: this.mono() };
    this.review = review;
  }
  async prepare(form: ConversationForm) {
    const s = this.status,
      peer = s?.peers.find((p) => p.peerId === form.peerId);
    if (!s || !peer || !s.canSetup || !s.hasSelectedKey || s.needsFreshPairing)
      return;
    this.invalidateReview();
    const request = {
      action: "grant",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      expectedPeerRevision: s.peerRevision,
      peerId: peer.peerId,
      peerKeyEpoch: peer.keyEpoch,
      ...this.scope,
      minutes: form.minutes,
      permissions: { ...form.permissions },
    };
    return this.act(async (current) =>
      this.accept(
        await this.api(endpoint + "/review", "POST", request),
        current,
      ),
    );
  }
  async revoke(permissionId: string) {
    const s = this.status,
      g = s?.grants.find((g) => g.id === permissionId);
    if (
      !s ||
      !g ||
      g.state === "revoked" ||
      g.choices.inboxId !== this.scope.inboxId ||
      g.choices.conversationId !== this.scope.conversationId
    )
      return;
    this.invalidateReview();
    return this.act(async (current) =>
      this.accept(
        await this.api(endpoint + "/review", "POST", {
          action: "revoke",
          expectedRevision: s.revision,
          permissionId,
        }),
        current,
      ),
    );
  }
  async confirm(ack: boolean, available: () => boolean) {
    if (!ack || !available() || !this.validReview()) {
      this.expire();
      return;
    }
    const review = this.review!;
    return this.act(async (current) => {
      this.review = null;
      const status = await this.api(endpoint + "/confirm", "POST", {
        reviewId: review.id,
        confirmed: true,
        acknowledged: true,
      });
      if (current() && available()) {
        this.status = status;
        this.notice =
          review.action === "grant"
            ? "Conversation choices saved on this Mac. No messages were sent."
            : "Conversation access revoked on this Mac. Existing messages and previously shared copies remain.";
      }
    });
  }
}
