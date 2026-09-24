import { z } from "zod";
import { privateBindingSchema } from "../../modules/remote/private-peer-contracts.js";
import { privateRelayGrantSchema } from "../../modules/remote/private-relay-enrollment.js";
import type { PrivateRelayGrant } from "../../modules/remote/private-relay-enrollment.js";
export type RelayAction =
  "accept" | "stop" | "reconcile" | "revoke" | "remove" | "cleanup";
export type RelayRecord = {
  id: string;
  revision: number;
  locked: boolean;
  phase: string;
  binding: {
    ownerId: string;
    deviceId: string;
    credentialEpoch: number;
    expiresAt: number;
  } | null;
  permission: PrivateRelayGrant | null;
};
export type RelayStatus = {
  available: boolean;
  canSetup: boolean;
  canCheckRemote: boolean;
  transportActive: false;
  state: { version: number; restoreAuthority: false; items: RelayRecord[] };
};
export type RelayReview = {
  id: string;
  action: RelayAction;
  expiresAt: number;
  binding: RelayRecord["binding"];
  permission: PrivateRelayGrant | null;
  record: RelayRecord | null;
  cleanupAfter: string | null;
};
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.strictObject({
  id: z.uuid(),
  revision: positive,
  locked: z.boolean(),
  phase: z.enum([
    "accepting",
    "storing",
    "active",
    "stopped",
    "deleting",
    "deleted",
  ]),
  binding: privateBindingSchema.nullable(),
  permission: privateRelayGrantSchema.nullable(),
});
const statusSchema = z.object({
  available: z.boolean(),
  canSetup: z.boolean(),
  canCheckRemote: z.boolean(),
  transportActive: z.literal(false),
  state: z.strictObject({
    version: z.literal(1),
    restoreAuthority: z.literal(false),
    items: z.array(recordSchema).max(1000),
  }),
});
const reviewSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum([
    "accept",
    "stop",
    "reconcile",
    "revoke",
    "remove",
    "cleanup",
  ]),
  expiresAt: positive,
  binding: privateBindingSchema.nullable(),
  permission: privateRelayGrantSchema.nullable(),
  record: recordSchema.nullable(),
  cleanupAfter: z.uuid().nullable(),
});
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const errors: Record<string, string> = {
  DENIED: "This change was not authorized. Refresh and review it again.",
  CONFLICT: "This connection changed. Refresh before reviewing another change.",
  BUSY: "Another connection action is still running.",
  CAPACITY:
    "The saved connection limit has been reached. Existing connections are unchanged.",
  PAIRING_REQUIRED:
    "Pair this Mac with ai.bittrees.org before checking its remote permission.",
  STORAGE_UNAVAILABLE:
    "Credential storage could not be confirmed. Refresh to check for unfinished setup or cleanup.",
  INVALID_INPUT: "Check the approval ID and review the change again.",
};
export class PrivateRelayPanelState {
  state: {
    status: RelayStatus | null;
    review: RelayReview | null;
    busy: boolean;
    error: string;
    notice: string;
    cleanupAfter: string | null;
  } = {
    status: null,
    review: null,
    busy: false,
    error: "",
    notice: "",
    cleanupAfter: null,
  };
  private generation = 0;
  constructor(
    private api: Api,
    private changed: (state: PrivateRelayPanelState["state"]) => void,
    private now = Date.now,
  ) {}
  private set(value: Partial<PrivateRelayPanelState["state"]>) {
    this.state = { ...this.state, ...value };
    this.changed(this.state);
  }
  hide() {
    this.generation++;
    this.set({ review: null, error: "", notice: "" });
    // A separate immediate host fence cancels a delayed setup even if its UI response is discarded.
    void this.api("/v1/private-relay/cancel-review", "POST", {
      confirmed: true,
    }).catch(() => {});
  }
  private async act(action: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await action(() => generation === this.generation);
    } catch (e) {
      if (generation === this.generation)
        this.set({
          review: null,
          status: null,
          error:
            errors[e instanceof Error ? e.message : ""] ??
            "This change could not be confirmed. Refresh the saved connection before trying again; remote revocation is not confirmed.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  refresh() {
    return this.act(async (current) => {
      this.set({ review: null, cleanupAfter: null });
      const status = await this.api("/v1/private-relay");
      if (current()) this.set({ status: statusSchema.parse(status) });
    });
  }
  prepare(action: RelayAction, record?: RelayRecord, permissionId?: string) {
    return this.act(async (current) => {
      this.set({ review: null });
      const body =
        action === "accept"
          ? { action, permissionId: permissionId?.trim() }
          : action === "cleanup"
            ? { action, after: this.state.cleanupAfter }
            : { action, id: record?.id, expectedRevision: record?.revision };
      const review = await this.api("/v1/private-relay/review", "POST", body);
      if (current()) {
        const parsed = reviewSchema.parse(review);
        if (parsed.action !== action) throw Error("INVALID_RESPONSE");
        if (parsed.expiresAt > this.now()) this.set({ review: parsed });
      }
    });
  }
  confirm(acknowledged: boolean) {
    const review = this.state.review;
    if (!review || !acknowledged) return Promise.resolve();
    if (review.expiresAt <= this.now()) {
      this.set({
        review: null,
        error: "This review expired. Review the connection change again.",
      });
      return Promise.resolve();
    }
    return this.act(async (current) => {
      this.set({ review: null });
      const response = await this.api("/v1/private-relay/confirm", "POST", {
        reviewId: review.id,
        confirmed: true,
        acknowledged: true,
      });
      if (!current()) return;
      const safeStatus = statusSchema.parse(response);
      let notice: string;
      if (response.completedAction !== review.action)
        throw Error("INVALID_RESPONSE");
      switch (review.action) {
        case "accept":
          notice =
            "Connection saved on this Mac. Automatic message delivery is not enabled.";
          break;
        case "stop":
          notice =
            "Connection stopped on this Mac. Remote revocation is not confirmed.";
          break;
        case "revoke":
          if (response.result?.remoteRevocationConfirmed !== true)
            throw Error("INVALID_RESPONSE");
          notice = "Remote revocation confirmed. This Mac remains stopped.";
          break;
        case "remove":
          if (response.result?.credentialAbsentObserved !== true)
            throw Error("INVALID_RESPONSE");
          notice =
            "Credential removal checked on this Mac. Remote revocation is not confirmed.";
          break;
        case "cleanup":
          notice = response.result?.nextCursor
            ? "Cleanup batch checked. Continue with the next batch."
            : "Requested cleanup checked. No more batches remain.";
          break;
        default:
          notice = response.result?.repairRequired
            ? "Remote permission exists, but this Mac remains stopped. Revoke that permission and review a new approval."
            : "Remote permission checked. Saved connection state refreshed.";
      }
      this.set({
        status: safeStatus,
        notice,
        cleanupAfter:
          review.action === "cleanup" ? response.result.nextCursor : null,
      });
    });
  }
}
