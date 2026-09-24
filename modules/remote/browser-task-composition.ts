import { privateEnvelopeSchema } from "./private-envelope.js";
import { z } from "zod";
import { BrowserTaskConsent } from "./browser-task-consent.js";
import { browserTaskBytes } from "./browser-task-preparation.js";
import {
  BrowserOutboxError,
  browserPrivateIdentity,
  type BrowserDeliveryContext,
} from "./browser-outbox-state.js";
import { privateTaskPayloadSchema } from "./private-task-contracts.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const route = { peerId: z.uuid(), peerKeyEpoch: positive };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Guard = {
  generation: number;
  wall: number;
  mono: number;
  expiresAt: number;
};
type Review = Guard & {
  reviewId: string;
  operationId: string;
  context: BrowserDeliveryContext;
  payload: z.infer<typeof privateTaskPayloadSchema>;
  deliveryExpiresAt: number;
};
/** Exact-content review inside the trusted verified host. No authorized outbox,
 * key handle or callback leaves this object. It does not perform network delivery. */
export class BrowserTaskComposition {
  private generation = 0;
  private closed = false;
  private busy = false;
  private pending: Review | null = null;
  constructor(
    private consents: BrowserTaskConsent,
    private current: () => PrivateBinding | null,
    private freshRegistration: () => PrivateBinding | null = () => null,
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  invalidate() {
    this.generation++;
    this.pending = null;
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  private guard(): Guard {
    const wall = this.now();
    return {
      generation: this.generation,
      wall,
      mono: this.monotonic(),
      expiresAt: wall + 120000,
    };
  }
  private check(g: Guard, context?: BrowserDeliveryContext) {
    const now = this.now(),
      elapsed = this.monotonic() - g.mono;
    if (
      this.closed ||
      g.generation !== this.generation ||
      !Number.isSafeInteger(now) ||
      now < g.wall ||
      now >= g.expiresAt ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= g.expiresAt - g.wall ||
      (context && !same(this.current(), context.binding))
    )
      throw new BrowserOutboxError("DENIED");
  }
  private async exclusive<T>(fn: (g: Guard) => Promise<T>) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const g = this.guard();
    try {
      this.check(g);
      const value = await fn(g);
      this.check(g);
      return value;
    } finally {
      this.busy = false;
    }
  }
  initialize(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            ...route,
            expectedRevision: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            confirmed: z.literal(true),
          })
          .parse(raw),
        sender = await this.consents.authorize(
          input.peerId,
          input.peerKeyEpoch,
          this.freshRegistration,
          () => this.check(g),
        );
      try {
        return await sender.outbox.initialize({
          expectedRevision: input.expectedRevision,
          confirmed: true,
        });
      } finally {
        sender.outbox.close();
      }
    });
  }
  prepare(raw: unknown) {
    return this.exclusive(async (g) => {
      this.pending = null;
      const input = z
          .strictObject({ ...route, payload: privateTaskPayloadSchema })
          .parse(raw),
        bytes = browserTaskBytes(input.payload);
      bytes.fill(0);
      const sender = await this.consents.authorize(
        input.peerId,
        input.peerKeyEpoch,
        this.freshRegistration,
        () => this.check(g),
      );
      try {
        const history = await sender.outbox.export(),
          identity = await browserPrivateIdentity(sender.context.binding);
        if (
          !history.meta ||
          history.meta.locked ||
          history.meta.deviceHash !== identity.deviceHash
        )
          throw new BrowserOutboxError("SETUP_REQUIRED");
        this.check(g, sender.context);
        const review: Review = {
          ...g,
          expiresAt: Math.min(g.expiresAt, sender.taskDeadline),
          reviewId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          context: sender.context,
          payload: structuredClone(input.payload),
          deliveryExpiresAt: sender.taskDeadline,
        };
        this.pending = review;
        return structuredClone({
          reviewId: review.reviewId,
          operationId: review.operationId,
          context: review.context,
          payload: review.payload,
          expiresAt: review.expiresAt,
          deliveryExpiresAt: review.deliveryExpiresAt,
        });
      } finally {
        sender.outbox.close();
      }
    });
  }
  confirm(raw: unknown) {
    return this.exclusive(async () => {
      const review = this.pending;
      // Consume before parsing or any await: failed confirmation cannot replay.
      this.pending = null;
      const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .parse(raw);
      if (!review || review.reviewId !== input.reviewId)
        throw new BrowserOutboxError("CONFLICT");
      this.check(review, review.context);
      const sender = await this.consents.authorize(
        review.context.peerId,
        review.context.peerKeyEpoch,
        this.freshRegistration,
        () => this.check(review, review.context),
      );
      try {
        if (!same(sender.context, review.context))
          throw new BrowserOutboxError("CONFLICT");
        const reserved = await sender.reserveTask({
          id: review.operationId,
          payload: review.payload,
          expiresAt: review.deliveryExpiresAt,
        });
        return await sender.resumeTask({
          id: reserved.id,
          expectedRevision: reserved.revision,
        });
      } finally {
        sender.outbox.close();
      }
    });
  }
  resume(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            ...route,
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        sender = await this.consents.authorize(
          input.peerId,
          input.peerKeyEpoch,
          this.freshRegistration,
          () => this.check(g),
        );
      try {
        return await sender.resumeTask({
          id: input.id,
          expectedRevision: input.expectedRevision,
        });
      } finally {
        sender.outbox.close();
      }
    });
  }
  envelope(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            ...route,
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        sender = await this.consents.authorize(
          input.peerId,
          input.peerKeyEpoch,
          this.freshRegistration,
          () => this.check(g),
        );
      try {
        return await sender.outbox.delivery(input.id, input.expectedRevision);
      } finally {
        sender.outbox.close();
      }
    });
  }
  receive(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            ...route,
            kind: z.enum(["receipt", "result"]),
            envelope: privateEnvelopeSchema,
            confirmed: z.literal(true),
          })
          .parse(raw),
        sender = await this.consents.authorize(
          input.peerId,
          input.peerKeyEpoch,
          this.freshRegistration,
          () => this.check(g),
        );
      try {
        return await (input.kind === "receipt"
          ? sender.outbox.acceptReceipt(input.envelope)
          : sender.outbox.acceptResult(input.envelope));
      } finally {
        sender.outbox.close();
      }
    });
  }
  readResult(raw: unknown) {
    return this.exclusive(async (g) => {
      const input = z
          .strictObject({
            ...route,
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          })
          .parse(raw),
        sender = await this.consents.authorize(
          input.peerId,
          input.peerKeyEpoch,
          this.freshRegistration,
          () => this.check(g),
        );
      try {
        return await sender.outbox.readResult({
          id: input.id,
          expectedRevision: input.expectedRevision,
          confirmed: true,
        });
      } finally {
        sender.outbox.close();
      }
    });
  }
}
