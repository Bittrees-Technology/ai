import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type { PeerStatus } from "./private-peer-state.js";
export type CheckRecord = {
  id: string;
  role: "challenge" | "response";
  revision: number;
  locked: boolean;
  state: "preparing" | "pending" | "verified" | "stopped";
  peerId: string;
  expiresAt: number;
  verifiedAt: number | null;
};
export type CheckStatus = {
  available: boolean;
  enabled: boolean;
  checks: CheckRecord[];
};
export type CheckAction =
  "begin" | "respond" | "complete" | "resume" | "envelope" | "stop";
export const checkActionLabels: Record<CheckAction, string> = {
  begin: "Start device check",
  respond: "Create check reply",
  complete: "Verify check reply",
  resume: "Resume saved preparation",
  envelope: "Show encrypted code",
  stop: "Stop saved exchange",
};
type Review = {
  action: CheckAction;
  peerId: string;
  fingerprint: string | null;
  id: string | null;
  role: CheckRecord["role"];
  expiresAt: number;
  body: unknown;
};
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class PrivateCheckPanelState {
  state: {
    status: CheckStatus | null;
    peers: PeerStatus | null;
    review: Review | null;
    output: {
      code: string;
      peerId: string;
      role: CheckRecord["role"];
      expiresAt: number;
    } | null;
    busy: boolean;
    error: string;
    notice: string;
  } = {
    status: null,
    peers: null,
    review: null,
    output: null,
    busy: false,
    error: "",
    notice: "",
  };
  private generation = 0;
  constructor(
    private api: Api,
    private changed: () => void,
    private now = Date.now,
  ) {}
  private set(p: Partial<PrivateCheckPanelState["state"]>) {
    this.state = { ...this.state, ...p };
    this.changed();
  }
  hide() {
    this.generation++;
    this.set({ review: null, output: null, error: "", notice: "" });
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
          peers: null,
          review: null,
          output: null,
          error:
            "The exchange could not be confirmed. Refresh saved checks before trying again. A change may already be saved; no automatic retry was made.",
        });
    } finally {
      this.set({ busy: false });
    }
  }
  async refresh() {
    this.hide();
    return this.act(async (current) => {
      const [status, peers] = await Promise.all([
        this.api("/v1/private-peer-checks"),
        this.api("/v1/private-peers"),
      ]);
      if (current()) this.set({ status, peers });
    });
  }
  private livePeer(id: string) {
    const { status, peers } = this.state;
    if (
      !status?.enabled ||
      !peers?.canSetup ||
      !peers.hasSelectedKey ||
      peers.needsFreshPairing
    )
      throw Error("DENIED");
    const peer = peers.peers.find((p) => p.peerId === id && !p.revoked);
    if (!peer) throw Error("DENIED");
    return peer;
  }
  prepare(action: CheckAction, value: string, incoming = "") {
    if (this.state.busy) return;
    this.hide();
    try {
      const record = this.state.status?.checks.find((c) => c.id === value);
      let peerId = value,
        id: string | null = null,
        role: CheckRecord["role"] = "challenge";
      let body: unknown,
        expiresAt = this.now() + 300000,
        fingerprint: string | null = null;
      if (action === "begin") {
        fingerprint = this.livePeer(value).fingerprint;
        body = {
          peerId,
          expectedKeyRevision: this.state.peers!.keyRevision,
          expectedPeerRevision: this.state.peers!.revision,
          confirmed: true,
        };
      } else if (action === "respond" || action === "complete") {
        fingerprint = this.livePeer(value).fingerprint;
        if (incoming.length > 65536) throw Error("DENIED");
        const envelope = privateEnvelopeSchema.parse(JSON.parse(incoming));
        if (envelope.header.senderId !== value) throw Error("DENIED");
        if (action === "complete") {
          const original = this.state.status?.checks.find(
            (c) => c.id === envelope.header.operationId,
          );
          if (
            !original ||
            original.role !== "challenge" ||
            original.peerId !== value ||
            original.locked ||
            !["pending", "verified"].includes(original.state)
          )
            throw Error("DENIED");
          id = original.id;
          expiresAt = Math.min(expiresAt, original.expiresAt);
        } else role = "response";
        expiresAt = Math.min(expiresAt, envelope.header.expiresAt);
        body = { envelope, confirmed: true };
      } else {
        if (
          !record ||
          record.state === "stopped" ||
          record.state === "verified"
        )
          throw Error("DENIED");
        peerId = record.peerId;
        id = record.id;
        role = record.role;
        if (action === "stop")
          body = { id, expectedRevision: record.revision, confirmed: true };
        else {
          fingerprint = this.livePeer(peerId).fingerprint;
          if (
            record.locked ||
            record.state !== (action === "resume" ? "preparing" : "pending")
          )
            throw Error("DENIED");
          expiresAt = Math.min(expiresAt, record.expiresAt);
          body = { id, confirmed: true };
        }
      }
      if (expiresAt <= this.now()) throw Error("DENIED");
      this.set({
        review: { action, peerId, fingerprint, id, role, expiresAt, body },
      });
    } catch {
      this.set({
        error:
          "This check is unavailable or the code does not match the selected device. Refresh saved checks and use the complete, unexpired code.",
      });
    }
  }
  async confirm(acknowledged: boolean) {
    const review = this.state.review;
    if (!review || !acknowledged || this.state.busy) return;
    if (review.expiresAt <= this.now()) {
      this.hide();
      this.set({
        error: "This review expired. Refresh saved checks and review again.",
      });
      return;
    }
    return this.act(async (current) => {
      this.set({ review: null, output: null });
      const result = await this.api(
        `/v1/private-peer-checks/${review.action}`,
        "POST",
        review.body,
      );
      if (!current()) return;
      if (review.action === "envelope") {
        const envelope: PrivateEnvelope = privateEnvelopeSchema.parse(result);
        if (envelope.header.expiresAt > this.now())
          this.set({
            output: {
              code: JSON.stringify(envelope),
              peerId: review.peerId,
              role: review.role,
              expiresAt: Math.min(review.expiresAt, envelope.header.expiresAt),
            },
          });
      } else {
        const record = result as CheckRecord;
        this.set({
          status: this.state.status
            ? {
                ...this.state.status,
                checks: [
                  ...this.state.status.checks.filter((c) => c.id !== record.id),
                  record,
                ],
              }
            : null,
          notice:
            review.action === "complete"
              ? "Reply verified on this Mac. This is a saved result, not a live connection check. The other device must check this Mac separately. Review task permissions separately."
              : review.action === "stop"
                ? "Exchange stopped locally. Previously shared codes and copies on the other device are unchanged."
                : "Exchange saved. Select Show code below to retrieve its encrypted code. Each device must start and complete its own check.",
        });
      }
    });
  }
}
