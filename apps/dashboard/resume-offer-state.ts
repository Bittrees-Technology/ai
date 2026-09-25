import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type {
  ResumeChoices,
  ResumePermissionStatus,
  ResumeTaskScope,
} from "./resume-permission-state.js";
export type ResumeOfferItem = {
  id: string;
  revision: number;
  permissionId: string;
  choices: ResumeChoices;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  state: string;
};
export type ResumeOfferReview = {
  id: string;
  action: "create" | "reveal" | "stop";
  expiresAt: number;
  offerId: string | null;
  offerExpiresAt: number;
  permissionId: string;
  choices: ResumeChoices;
  fingerprint: string;
  binding: { ownerId: string; deviceId: string };
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const endpoint = "/v1/private-resume/offers";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export class ResumeOfferPanelState {
  status: {
    available: boolean;
    canSetup: boolean;
    offers: ResumeOfferItem[];
  } | null = null;
  review: ResumeOfferReview | null = null;
  busy = false;
  error = "";
  notice = "";
  private generation = 0;
  private disposed = false;
  private received = { wall: 0, mono: 0 };
  private scope: ResumeTaskScope;
  constructor(
    private api: Api,
    scope: ResumeTaskScope,
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
  private valid(r: ResumeOfferReview, received = this.received) {
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
  private matches(c: ResumeChoices) {
    return c.taskId === this.scope.taskId;
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
    r: ResumeOfferReview,
    action: ResumeOfferReview["action"],
    choices: ResumeChoices,
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
  create(permissionId: string, permissions: ResumePermissionStatus) {
    const grant = permissions.grants.find((g) => g.id === permissionId);
    if (
      !this.status?.canSetup ||
      !permissions.canSetup ||
      this.scope.status !== "paused" ||
      grant?.choices.taskRevision !== this.scope.taskRevision ||
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
        await this.api(endpoint + "/prepare", "POST", {
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
          this.scope.status !== "paused" ||
          entry.choices.taskRevision !== this.scope.taskRevision ||
          !["ready", "preparing"].includes(entry.state) ||
          entry.expiresAt <= this.now())) ||
      (action === "stop" && entry.state === "stopped")
    )
      return;
    const retained = structuredClone(entry);
    this.discard();
    return this.act(async (current) =>
      this.accept(
        await this.api(endpoint + "/prepare", "POST", {
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
      const e = result.offer as ResumeOfferItem;
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
          ? "Further offer downloads stopped. Downloaded copies remain; revoke resume permission to remove access."
          : "Encrypted offer download started. Browser import and resume controls are not available yet.";
    });
  }
}
