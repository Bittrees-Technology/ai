import {
  BrowserDeviceClient,
  type BrowserDeviceContext,
} from "../../modules/remote/browser-device-client.js";
import { BrowserRelayPermissionsClient } from "../../modules/remote/private-relay-client.js";
import type { PrivateRelayGrant } from "../../modules/remote/private-relay-enrollment.js";

type Review = {
  id: string;
  action: "browser" | "mac" | "revoke";
  ownerId: string;
  endpointId: string;
  credentialEpoch: number;
  current: PrivateRelayGrant | null;
  expiresAt: number;
  operationId: string;
  started: number;
  monotonic: number;
  reviewUntil: number;
};
type State = {
  busy: boolean;
  review: Review | null;
  result: PrivateRelayGrant | null;
  items: PrivateRelayGrant[];
  cursor: string | null;
  uncertain: { operationId: string; permissionId: string | null } | null;
  notice: string;
  error: string;
};
/** One-use, account-bound metadata reviews; this controller never dispatches messages. */
export class BrowserRelayControls {
  private state: State = {
    busy: false,
    review: null,
    result: null,
    items: [],
    cursor: null,
    uncertain: null,
    notice: "",
    error: "",
  };
  private contextStamp = "";
  private generation = 0;
  private permissions: BrowserRelayPermissionsClient;
  private browser: BrowserDeviceClient;
  constructor(
    private context: () => BrowserDeviceContext | null,
    private changed: () => void = () => {},
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {
    this.permissions = new BrowserRelayPermissionsClient(
      context,
      transport,
      now,
      monotonic,
    );
    this.browser = new BrowserDeviceClient(context, transport, now, monotonic);
  }
  snapshot() {
    this.sync();
    return structuredClone(this.state);
  }
  sync() {
    const stamp = JSON.stringify(this.context());
    if (stamp === this.contextStamp) return;
    this.generation++;
    this.permissions.invalidate();
    this.browser.invalidate();
    this.contextStamp = stamp;
    this.state = {
      busy: false,
      review: null,
      result: null,
      items: [],
      cursor: null,
      uncertain: null,
      notice: "",
      error: "",
    };
  }
  hide() {
    this.sync();
    this.generation++;
    this.permissions.invalidate();
    this.browser.invalidate();
    this.state.review = null;
    this.state.busy = false;
    this.state.result = null;
    if (this.state.uncertain)
      this.state.notice =
        "A request may have completed. Check its result before reviewing another change.";
    this.changed();
  }
  private live(generation: number, stamp: string) {
    return (
      generation === this.generation &&
      !!this.context() &&
      JSON.stringify(this.context()) === stamp
    );
  }
  private async run(action: (check: () => void) => Promise<void>) {
    this.sync();
    if (this.state.busy || !this.context()) return;
    const generation = ++this.generation,
      stamp = this.contextStamp;
    const check = () => {
      if (!this.live(generation, stamp)) throw Error("DENIED");
    };
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      await action(check);
      check();
    } catch {
      if (this.live(generation, stamp))
        this.state.error = this.state.uncertain
          ? "The result is uncertain. Check the original request; it has not been retried."
          : "This review could not be verified. Refresh the session or device details, then review again.";
    } finally {
      if (this.live(generation, stamp)) {
        this.state.busy = false;
        this.changed();
      }
    }
  }
  private makeReview(
    action: Review["action"],
    endpoint: {
      ownerId: string;
      endpointId: string;
      credentialEpoch: number;
      expiresAt: number;
    },
    current: PrivateRelayGrant | null,
  ) {
    const started = this.now(),
      mono = this.monotonic();
    if (
      !Number.isSafeInteger(started) ||
      started <= 0 ||
      !Number.isFinite(mono)
    )
      throw Error("DENIED");
    const expiresAt =
      action === "revoke"
        ? current!.expiresAt
        : Math.min(started + 3600000, endpoint.expiresAt);
    if (action !== "revoke" && expiresAt <= started) throw Error("DENIED");
    this.state.review = {
      id: crypto.randomUUID(),
      action,
      ownerId: endpoint.ownerId,
      endpointId: endpoint.endpointId,
      credentialEpoch: endpoint.credentialEpoch,
      current: current ? structuredClone(current) : null,
      expiresAt,
      operationId: crypto.randomUUID(),
      started,
      monotonic: mono,
      reviewUntil: Math.min(
        started + 120000,
        action === "revoke" ? Number.MAX_SAFE_INTEGER : expiresAt,
      ),
    };
    this.state.result = null;
    this.state.notice = "";
  }
  reviewBrowser() {
    return this.run(async (check) => {
      this.state.review = null;
      if (this.state.uncertain) throw Error("UNCERTAIN");
      const registration = (await this.browser.inspect()).registration;
      check();
      if (!registration || registration.revokedAt !== null)
        throw Error("DENIED");
      const b = registration.binding;
      const inspected = await this.permissions.inspectEndpoint({
        endpointKind: "browser",
        endpointId: b.deviceId,
        credentialEpoch: b.credentialEpoch,
      });
      check();
      this.makeReview("browser", inspected.endpoint, inspected.permission);
    });
  }
  reviewMac(endpointId: string, credentialEpoch: number) {
    return this.run(async (check) => {
      this.state.review = null;
      if (this.state.uncertain) throw Error("UNCERTAIN");
      const inspected = await this.permissions.inspectEndpoint({
        endpointKind: "mac",
        endpointId,
        credentialEpoch,
      });
      check();
      this.makeReview("mac", inspected.endpoint, inspected.permission);
    });
  }
  reviewRevoke(id: string) {
    return this.run(async (check) => {
      this.state.review = null;
      if (this.state.uncertain) throw Error("UNCERTAIN");
      const grant = await this.permissions.inspect(id);
      check();
      if (grant.state === "revoked") throw Error("DENIED");
      this.makeReview("revoke", grant, grant);
    });
  }
  expireReview() {
    const r = this.state.review;
    if (!r) return;
    const now = this.now(),
      elapsed = this.monotonic() - r.monotonic;
    if (
      !Number.isSafeInteger(now) ||
      now < r.started ||
      now >= r.reviewUntil ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= 120000
    ) {
      this.state.review = null;
      this.state.notice =
        "The review expired. Review the current device again.";
      this.changed();
    }
  }
  confirm(reviewId: string, acknowledged: boolean) {
    this.sync();
    this.expireReview();
    if (this.state.busy) return Promise.resolve();
    const review = this.state.review;
    this.state.review = null;
    if (!review || review.id !== reviewId || acknowledged !== true) {
      this.changed();
      return Promise.resolve();
    }
    return this.run(async (check) => {
      this.state.uncertain = {
        operationId: review.operationId,
        permissionId: review.action === "revoke" ? review.current!.id : null,
      };
      const grant =
        review.action === "revoke"
          ? await this.permissions.revoke({
              id: review.current!.id,
              expectedRevision: review.current!.revision,
              confirmed: true,
            })
          : await this.permissions[
              review.action === "browser" ? "enableBrowser" : "approveMac"
            ]({
              deviceId: review.endpointId,
              credentialEpoch: review.credentialEpoch,
              operationId: review.operationId,
              expected: review.current
                ? { id: review.current.id, revision: review.current.revision }
                : null,
              expiresAt: review.expiresAt,
              confirmed: true,
            });
      check();
      this.state.uncertain = null;
      this.state.result = grant;
      this.state.items = [];
      this.state.cursor = null;
      this.state.notice =
        grant.state === "pending"
          ? "Approval created. Accept it separately on this Mac before the deadline."
          : grant.state === "revoked"
            ? "Remote permission revoked."
            : "Browser permission saved. Automatic message delivery is not enabled.";
    });
  }
  checkUncertain() {
    return this.run(async (check) => {
      const request = this.state.uncertain;
      if (!request) return;
      const grant = request.permissionId
        ? await this.permissions.inspect(request.permissionId)
        : await this.permissions.inspectOperation(request.operationId);
      check();
      this.state.result = grant;
      this.state.uncertain = null;
      this.state.notice =
        "Original request checked. Review the current permission state below; no request was repeated.";
    });
  }
  forgetUncertain(acknowledged: boolean) {
    this.sync();
    if (this.state.busy || !this.state.uncertain || acknowledged !== true)
      return;
    this.state.uncertain = null;
    this.state.result = null;
    this.state.error = "";
    this.state.notice =
      "The original outcome is still unconfirmed. A new review will inspect the current permission before any change.";
    this.changed();
  }
  load(after: string | null = null) {
    return this.run(async (check) => {
      this.state.review = null;
      const page = await this.permissions.list({ after, limit: 20 });
      check();
      this.state.items = page.items;
      this.state.cursor = page.nextCursor;
      this.state.notice = "Showing this page of saved permissions.";
    });
  }
}
