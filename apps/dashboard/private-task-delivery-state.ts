import { privateRelaySelectionSchema } from "../../modules/remote/private-relay-queue.js";
import { z } from "zod";
import {
  privateRelayStatusSchema,
  type RelayRecord,
} from "./private-relay-state.js";
import {
  privateRelayPageSchema,
  privateRelayStorageReceiptSchema,
} from "../../modules/remote/private-relay-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const acceptedSchema = z.strictObject({
  operationId: z.uuid(),
  taskId: z.uuid(),
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  acceptedAt: positive,
});
const responseSchema = z.strictObject({
  id: z.uuid(),
  revision: positive,
  kind: z.enum(["accepted", "result"]),
  locked: z.boolean(),
  state: z.enum(["preparing", "pending", "stopped"]),
  operationId: z.uuid(),
  peerId: z.uuid(),
  expiresAt: positive,
  attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  delivery: z
    .strictObject({
      state: z.enum(["stored", "received", "deleted"]),
      observedAt: positive,
      attempt: positive,
    })
    .nullable()
    .optional(),
});
const tasksSchema = z.strictObject({
  available: z.boolean(),
  enabled: z.boolean(),
  transportActive: z.literal(false),
  acceptedTasks: z.array(acceptedSchema).max(1024),
  responses: z.array(responseSchema).max(1024),
});
const transportSchema = z.strictObject({
  transportOnly: z.literal(true),
  receipt: privateRelayStorageReceiptSchema,
  duplicate: z.boolean(),
});
const receivedSchema = z
  .strictObject({
    received: z
      .strictObject({
        status: z.literal("accepted-locally"),
        taskId: z.uuid(),
        operationId: z.uuid(),
        messageId: z.uuid(),
      })
      .nullable(),
    nextCursor: z
      .strictObject({ storedAt: positive, messageId: z.uuid() })
      .nullable(),
    transport: transportSchema.optional(),
  })
  .refine((v) => (v.received ? !!v.transport : !v.transport));
const queueItemSchema = z
  .strictObject({
    selection: privateRelaySelectionSchema,
    cursor: privateRelayPageSchema.shape.after.unwrap(),
    expiresAt: positive,
  })
  .refine(
    (v) =>
      v.cursor.messageId === v.selection.messageId &&
      v.cursor.storedAt === v.selection.storedAt,
  );
const queueInspectionSchema = z
  .strictObject({
    transportOnly: z.literal(true),
    item: queueItemSchema.nullable(),
    nextCursor: privateRelayPageSchema.shape.after,
  })
  .refine(
    (v) =>
      !v.nextCursor ||
      (!!v.item &&
        v.nextCursor.messageId === v.item.cursor.messageId &&
        v.nextCursor.storedAt === v.item.cursor.storedAt),
  );
type Queue = {
  connection: RelayRecord;
  after: z.infer<typeof privateRelayPageSchema>["after"];
  item: z.infer<typeof queueItemSchema> | null;
  visited: number;
  checked: boolean;
};
type Snapshot = {
  relay: z.infer<typeof privateRelayStatusSchema>;
  tasks: z.infer<typeof tasksSchema>;
};
export type DeliveryAction =
  | "check"
  | "inspect"
  | "next"
  | "selected"
  | "accepted"
  | "result"
  | "send"
  | "stop";
export const deliveryLabels: Record<DeliveryAction, string> = {
  check: "Check for one task",
  inspect: "Inspect the first queued message",
  next: "Look for a later message",
  selected: "Check the selected message",
  accepted: "Prepare acceptance reply",
  result: "Prepare completed result",
  send: "Send saved reply",
  stop: "Stop reply retries",
};
export const deliveryDescriptions: Record<DeliveryAction, string> = {
  inspect:
    "Inspect one message waiting for this Mac. This shows its delivery reference only; it will not open, accept, delete or acknowledge the message.",
  next: "Look for one message after the selected delivery reference. Leave the selected message in its existing state. This does not delete it or mark it accepted. Return to the start to inspect it again.",
  selected:
    "Check exactly this queued message under current task permission. Accept it only if its content authenticates and permission remains valid. A changed selection stops the action; a reply is not sent.",
  check:
    "Check for one encrypted browser task using this connection. Existing task permission controls whether it can be accepted into local work. This does not mean work is complete or send a reply.",
  accepted:
    "Prepare an encrypted acceptance for this saved task and browser. Task permission and the current connection are checked again. Sending is a separate reviewed action.",
  result:
    "Prepare the completed task result for this browser under separate result-sharing permission. If work is unfinished or permission is missing, no result is prepared. Sending is separate.",
  send: "Send the original saved encrypted reply to its browser through ai.bittrees.org. Server storage or delivery does not prove the browser has authenticated or opened it. Each retry needs another review.",
  stop: "Stop further sending attempts for this saved reply on this Mac. Keep its local history. This cannot recall a message already sent or cancel the task.",
};
type Review = {
  action: DeliveryAction;
  queue?: Queue;
  snapshot: Snapshot;
  connection?: RelayRecord;
  accepted?: z.infer<typeof acceptedSchema>;
  response?: z.infer<typeof responseSchema>;
  wall: number;
  mono: number;
  expiresAt: number;
  generation: number;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export class PrivateTaskDeliveryState {
  state: {
    snapshot: Snapshot | null;
    queue: Queue | null;
    review: Review | null;
    busy: boolean;
    error: string;
    notice: string;
  } = {
    snapshot: null,
    queue: null,
    review: null,
    busy: false,
    error: "",
    notice: "",
  };
  private queue: Queue | null = null;
  private generation = 0;
  private pendingReview: Review | null = null;
  private fence: Promise<unknown> = Promise.resolve();
  constructor(
    private api: Api,
    private changed: () => void,
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  private set(patch: Partial<PrivateTaskDeliveryState["state"]>) {
    this.state = { ...this.state, ...patch };
    this.changed();
  }
  hide() {
    this.generation++;
    this.pendingReview = null;
    this.queue = null;
    this.set({
      snapshot: null,
      queue: null,
      review: null,
      error: "",
      notice: "",
    });
    // Subsequent operations wait for the host cancellation before opening a new scope.
    this.fence = this.fence
      .catch(() => {})
      .then(() =>
        this.api("/v1/private-relay/cancel-review", "POST", {
          confirmed: true,
        }),
      );
    void this.fence.catch(() => {});
  }
  private saveQueue(queue: Queue | null) {
    this.queue = queue ? structuredClone(queue) : null;
    this.set({ queue: this.queue ? structuredClone(this.queue) : null });
  }
  resetQueue() {
    if (this.state.busy) return;
    this.pendingReview = null;
    this.saveQueue(null);
    this.set({
      review: null,
      error: "",
      notice: "Queue view returned to the start. No message was changed.",
    });
  }
  private reconcileQueue(snapshot: Snapshot) {
    if (
      this.queue &&
      (!snapshot.tasks.enabled ||
        !snapshot.relay.canCheckRemote ||
        !snapshot.relay.canSetup ||
        !snapshot.relay.available ||
        !snapshot.tasks.available ||
        !snapshot.relay.state.items.some(
          (r) =>
            same(r, this.queue!.connection) &&
            !r.locked &&
            r.phase === "active" &&
            r.binding!.expiresAt > this.now() &&
            r.permission!.expiresAt > this.now(),
        ))
    )
      this.saveQueue(null);
  }
  private async snapshot() {
    const relay = privateRelayStatusSchema.parse(
      await this.api("/v1/private-relay"),
    );
    const tasks = tasksSchema.parse(await this.api("/v1/private-tasks"));
    return { relay, tasks };
  }
  private async act(fn: (current: () => boolean) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await this.fence;
      const current = () => generation === this.generation;
      if (current()) await fn(current);
    } catch (e) {
      if (generation === this.generation)
        this.set({
          snapshot: null,
          review: null,
          error: `${e instanceof Error && e.message === "CONFLICT" ? "Saved task or connection details changed." : "This task delivery action could not be confirmed."} Refresh history and review again. A lost reply may follow a saved change; nothing will be retried automatically.`,
        });
    } finally {
      this.set({ busy: false });
    }
  }
  activeConnections() {
    const s = this.state.snapshot;
    if (
      !s?.relay.available ||
      !s.relay.canSetup ||
      !s.relay.canCheckRemote ||
      !s.tasks.available ||
      !s.tasks.enabled
    )
      return [];
    return s.relay.state.items.filter((r) => {
      const b = r.binding,
        p = r.permission;
      return (
        !r.locked &&
        r.phase === "active" &&
        !!b &&
        !!p &&
        p.state === "active" &&
        b.expiresAt > this.now() &&
        p.expiresAt > this.now() &&
        p.ownerId === b.ownerId &&
        p.endpointId === b.deviceId &&
        p.credentialEpoch === b.credentialEpoch
      );
    });
  }
  private valid(r: Review) {
    const now = this.now(),
      elapsed = this.monotonic() - r.mono;
    return (
      r.generation === this.generation &&
      Number.isSafeInteger(now) &&
      now >= r.wall &&
      now < r.expiresAt &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < r.expiresAt - r.wall
    );
  }
  refresh() {
    return this.act(async (current) => {
      this.pendingReview = null;
      this.set({ review: null });
      const snapshot = await this.snapshot();
      if (current()) {
        this.reconcileQueue(snapshot);
        this.set({
          snapshot,
          notice:
            "Private task history loaded. Review each delivery action separately.",
        });
      }
    });
  }
  prepare(action: DeliveryAction, connectionId?: string, targetId?: string) {
    if (!this.state.snapshot) return Promise.resolve();
    const before = structuredClone(this.state.snapshot),
      wall = this.now(),
      mono = this.monotonic();
    return this.act(async (current) => {
      this.pendingReview = null;
      this.set({ review: null });
      const snapshot = await this.snapshot();
      if (!current()) return;
      if (!same(before, snapshot)) throw Error("CONFLICT");
      const r: Review = {
        action,
        snapshot,
        wall,
        mono,
        generation: this.generation,
        expiresAt: wall + 120000,
      };
      if (action !== "stop") {
        const connection = this.activeConnections().find(
          (r) => r.id === connectionId,
        );
        if (!connection) throw Error("DENIED");
        r.connection = structuredClone(connection);
        r.expiresAt = Math.min(
          r.expiresAt,
          connection.binding!.expiresAt,
          connection.permission!.expiresAt,
        );
      }
      if (action === "next" || action === "selected") {
        const queue = this.queue;
        if (
          !queue?.item ||
          !same(queue.connection, r.connection) ||
          (action === "next" && queue.visited >= 20) ||
          (action === "selected" && queue.checked)
        )
          throw Error("DENIED");
        r.queue = structuredClone(queue);
        if (action === "selected")
          r.expiresAt = Math.min(r.expiresAt, queue.item.expiresAt);
      }
      if (action === "accepted" || action === "result") {
        r.accepted = snapshot.tasks.acceptedTasks.find(
          (t) => t.operationId === targetId,
        );
        if (!r.accepted) throw Error("DENIED");
      }
      if (action === "send" || action === "stop") {
        r.response = snapshot.tasks.responses.find((t) => t.id === targetId);
        if (
          !r.response ||
          r.response.state === "stopped" ||
          (action === "send" &&
            (r.response.locked || r.response.state !== "pending"))
        )
          throw Error("DENIED");
        if (action === "send")
          r.expiresAt = Math.min(r.expiresAt, r.response.expiresAt);
      }
      if (!this.valid(r)) throw Error("DENIED");
      this.pendingReview = r;
      this.set({
        review: structuredClone(r),
        notice:
          "Review the exact task, browser and connection before confirming.",
      });
    });
  }
  confirm(acknowledged: boolean) {
    const r = this.pendingReview;
    if (!r || !acknowledged || this.state.busy) return Promise.resolve();
    this.pendingReview = null;
    this.set({ review: null });
    return this.act(async (current) => {
      if (!this.valid(r)) throw Error("DENIED");
      const fresh = await this.snapshot();
      if (!current()) return;
      if (!this.valid(r)) throw Error("DENIED");
      if (!same(fresh, r.snapshot)) throw Error("CONFLICT");
      const connection = r.connection
        ? { id: r.connection.id, expectedRevision: r.connection.revision }
        : undefined;
      let notice: string;
      let nextQueue = this.queue;
      if (r.action === "inspect" || r.action === "next") {
        const after = r.action === "next" ? r.queue!.item!.cursor : null;
        const value = queueInspectionSchema.parse(
          await this.api("/v1/private-relay/inspect-task", "POST", {
            ...connection,
            after,
            confirmed: true,
          }),
        );
        if (
          value.item &&
          (value.item.expiresAt <= this.now() ||
            (after &&
              (value.item.cursor.storedAt < after.storedAt ||
                (value.item.cursor.storedAt === after.storedAt &&
                  value.item.cursor.messageId <= after.messageId))))
        )
          throw Error("INVALID_RESPONSE");
        nextQueue = {
          connection: r.connection!,
          after,
          item: value.item,
          visited: r.action === "next" ? r.queue!.visited + 1 : 1,
          checked: false,
        };
        notice = value.item
          ? "Queued message inspected. Its content has not been authenticated or accepted."
          : "No message is currently waiting at this queue position. Return to the start to check again.";
      } else if (r.action === "check" || r.action === "selected") {
        const value = receivedSchema.parse(
          await this.api("/v1/private-relay/check-task", "POST", {
            ...connection,
            after: r.action === "selected" ? r.queue!.after : null,
            ...(r.action === "selected"
              ? { selection: r.queue!.item!.selection }
              : {}),
            confirmed: true,
          }),
        );
        if (
          r.action === "selected" &&
          (!value.received ||
            value.received.messageId !== r.queue!.item!.selection.messageId)
        )
          throw Error("INVALID_RESPONSE");
        nextQueue =
          r.action === "selected" ? { ...r.queue!, checked: true } : null;
        notice = value.received
          ? `Task ${value.received.taskId} accepted locally. Work is not confirmed complete; a reply has not been sent.`
          : "No new browser task is waiting for this Mac.";
      } else if (r.action === "accepted" || r.action === "result") {
        const value = responseSchema.parse(
          await this.api("/v1/private-relay/responses/prepare", "POST", {
            connection,
            response: {
              operationId: r.accepted!.operationId,
              peerId: r.accepted!.peerId,
              kind: r.action,
              confirmed: true,
            },
            confirmed: true,
          }),
        );
        if (
          value.kind !== r.action ||
          value.operationId !== r.accepted!.operationId ||
          value.peerId !== r.accepted!.peerId
        )
          throw Error("INVALID_RESPONSE");
        notice =
          "Encrypted reply prepared on this Mac. Review sending the saved reply separately; nothing was sent automatically.";
      } else if (r.action === "send") {
        const value = transportSchema.parse(
          await this.api("/v1/private-relay/responses/send", "POST", {
            connection,
            response: {
              id: r.response!.id,
              expectedRevision: r.response!.revision,
              confirmed: true,
            },
            confirmed: true,
          }),
        );
        notice =
          value.receipt.state === "deleted"
            ? "The server previously removed this message; no replacement was sent."
            : `Encrypted reply ${value.receipt.state === "received" ? "already delivered" : "stored for delivery"}${value.duplicate ? " (the original message was already recorded)" : ""}. Browser authentication or reading is not confirmed.`;
      } else {
        const value = responseSchema.parse(
          await this.api("/v1/private-tasks/responses/stop", "POST", {
            id: r.response!.id,
            expectedRevision: r.response!.revision,
            confirmed: true,
          }),
        );
        if (value.id !== r.response!.id || value.state !== "stopped")
          throw Error("INVALID_RESPONSE");
        notice =
          "Reply retries stopped on this Mac. Previously sent messages and local task work are unchanged.";
      }
      if (!current()) return;
      if (!this.valid(r)) throw Error("DENIED");
      this.set({ snapshot: null });
      const snapshot = await this.snapshot();
      if (!current()) return;
      if (!this.valid(r)) throw Error("DENIED");
      this.saveQueue(nextQueue);
      this.reconcileQueue(snapshot);
      this.set({ snapshot, notice });
    });
  }
}
