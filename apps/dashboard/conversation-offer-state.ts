import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type {
  ConversationChoices,
  ConversationPermissionStatus,
} from "./conversation-permission-state.js";
export type ConversationOfferItem = {
  id: string;
  revision: number;
  permissionId: string;
  choices: ConversationChoices;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  state: string;
};
export type ConversationOfferReview = {
  id: string;
  action: "create" | "reveal" | "stop";
  expiresAt: number;
  offerId: string | null;
  offerExpiresAt: number;
  permissionId: string;
  choices: ConversationChoices;
  fingerprint: string;
  binding: { ownerId: string; deviceId: string };
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const endpoint = "/v1/private-conversation-offers";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export class ConversationOfferPanelState {
  status: {
    available: boolean;
    canSetup: boolean;
    offers: ConversationOfferItem[];
  } | null = null;
  review: ConversationOfferReview | null = null;
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
  discard() {
    this.generation++;
    this.review = null;
    this.error = "";
    this.notice = "";
    this.render();
  }
  private valid(r: ConversationOfferReview, received = this.received) {
    return (
      this.now() >= received.wall &&
      this.now() < r.expiresAt &&
      this.mono() >= received.mono &&
      this.mono() - received.mono < r.expiresAt - received.wall
    );
  }
  expire() {
    if (this.review && !this.valid(this.review)) {
      this.discard();
      this.notice =
        "This offer review expired. Review the saved offer or create a new one.";
      this.render();
    }
  }
  private matches(c: ConversationChoices) {
    return (
      c.inboxId === this.scope.inboxId &&
      c.conversationId === this.scope.conversationId
    );
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
        this.review = null;
        this.status = null;
        this.error =
          "The offer change could not be confirmed. Refresh saved offers before reviewing again. No automatic retry was made.";
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }
  refresh() {
    this.discard();
    return this.act(async (current) => {
      const s = await this.api(endpoint);
      if (current()) this.status = s;
    });
  }
  private accept(
    r: ConversationOfferReview,
    action: ConversationOfferReview["action"],
    choices: ConversationChoices,
    permissionId: string,
    offerId: string | null,
    current: () => boolean,
    expectedDeadline?: number,
  ) {
    if (!current()) return;
    if (
      r.action !== action ||
      !this.matches(r.choices) ||
      !same(r.choices, choices) ||
      r.permissionId !== permissionId ||
      r.offerId !== offerId ||
      (expectedDeadline !== undefined &&
        r.offerExpiresAt !== expectedDeadline) ||
      r.expiresAt <= this.now() ||
      r.expiresAt > this.now() + 120000 ||
      (action !== "stop" &&
        (r.offerExpiresAt < r.expiresAt ||
          r.offerExpiresAt > r.choices.expiresAt ||
          r.offerExpiresAt > this.now() + 300000))
    )
      throw Error("REVIEW_CHANGED");
    this.received = { wall: this.now(), mono: this.mono() };
    this.review = r;
  }
  create(permissionId: string, permissions: ConversationPermissionStatus) {
    const grant = permissions.grants.find((g) => g.id === permissionId);
    if (
      !this.status?.canSetup ||
      !permissions.canSetup ||
      !grant ||
      grant.state !== "saved" ||
      !this.matches(grant.choices) ||
      grant.choices.expiresAt <= this.now()
    )
      return;
    const choices = structuredClone(grant.choices);
    this.discard();
    return this.act(async (current) =>
      this.accept(
        await this.api(endpoint + "/review", "POST", {
          action: "create",
          permissionId,
          expectedConsentRevision: permissions.revision,
        }),
        "create",
        choices,
        permissionId,
        null,
        current,
      ),
    );
  }
  prepare(id: string, action: "reveal" | "stop") {
    const entry = this.status?.offers.find((e) => e.id === id);
    if (
      !entry ||
      !this.matches(entry.choices) ||
      (action === "reveal" &&
        (!this.status?.canSetup ||
          !["ready", "preparing"].includes(entry.state) ||
          entry.expiresAt <= this.now())) ||
      (action === "stop" && entry.state === "stopped")
    )
      return;
    const retained = structuredClone(entry);
    this.discard();
    return this.act(async (current) =>
      this.accept(
        await this.api(endpoint + "/review", "POST", {
          action,
          id,
          expectedRevision: retained.revision,
        }),
        action,
        retained.choices,
        retained.permissionId,
        id,
        current,
        retained.expiresAt,
      ),
    );
  }
  confirm(
    ack: boolean,
    available: () => boolean,
    download: (wire: PrivateEnvelope, id: string) => void,
  ) {
    const r = this.review,
      received = { ...this.received };
    if (!ack || !available() || !r || !this.valid(r)) {
      this.expire();
      return;
    }
    return this.act(async (current) => {
      this.review = null;
      const result = await this.api(endpoint + "/confirm", "POST", {
        reviewId: r.id,
        confirmed: true,
        acknowledged: true,
      });
      if (!current() || !available() || !this.valid(r, received)) return;
      const e = result.offer as ConversationOfferItem;
      if (
        !e ||
        !this.matches(e.choices) ||
        !same(e.choices, r.choices) ||
        e.permissionId !== r.permissionId ||
        (r.offerId !== null && e.id !== r.offerId) ||
        e.expiresAt !== r.offerExpiresAt
      )
        throw Error("RESULT_CHANGED");
      if (r.action === "stop") {
        if (result.envelope !== null || e.state !== "stopped")
          throw Error("RESULT_CHANGED");
      } else {
        const wire = privateEnvelopeSchema.parse(result.envelope);
        if (
          wire.header.operationId !== e.id ||
          wire.header.ownerId !== r.binding.ownerId ||
          wire.header.senderId !== r.binding.deviceId ||
          wire.header.recipientId !== r.choices.peerId ||
          wire.header.recipientKeyEpoch !== r.choices.peerKeyEpoch ||
          wire.header.expiresAt !== r.offerExpiresAt ||
          wire.header.expiresAt <= this.now() ||
          e.state !== "ready"
        )
          throw Error("RESULT_CHANGED");
        download(wire, e.id);
      }
      if (!current() || !available()) return;
      if (this.status)
        this.status = {
          ...this.status,
          offers: [...this.status.offers.filter((v) => v.id !== e.id), e],
        };
      this.notice =
        r.action === "stop"
          ? "Future downloads stopped. Copies already downloaded remain; revoke conversation access to stop future sharing."
          : "Offer download started. The paired browser must review its own conversation access. No messages were sent.";
    });
  }
}
