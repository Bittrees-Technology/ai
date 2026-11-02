import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
export const finitePilotReviewSchema = z
  .strictObject({
    version: z.literal(1),
    reviewId: z.uuid(),
    runId: z.uuid(),
    approvedAt: z.int().positive(),
    expiresAt: z.int().positive(),
  })
  .refine(
    (r) => r.expiresAt > r.approvedAt && r.expiresAt - r.approvedAt <= 900000,
    "Pilot review must expire within fifteen minutes",
  );
const operation = z.strictObject({
  id: z.uuid(),
  count: z.int().min(1).max(2),
});
const stateSchema = z
  .strictObject({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    lastAt: z.int().positive(),
    claim: operation.nullable(),
    renew: operation.nullable(),
    complete: operation.nullable(),
    modelTurns: z.int().min(0).max(1),
    stopped: z.boolean(),
    reason: z.string().max(100).nullable(),
  })
  .refine(
    (s) =>
      (s.claim?.count ?? 0) <= 1 &&
      (s.renew?.count ?? 0) <= 1 &&
      [s.claim, s.renew, s.complete].reduce((n, o) => n + (o?.count ?? 0), 0) <=
        4,
  );
type State = z.infer<typeof stateSchema>;
type Config = {
  finitePilot?: z.infer<typeof finitePilotReviewSchema>;
  tenant: string;
  workspace: string;
  connectionId: string;
  workflowId: string;
  delegationId: string;
  profileId: string;
  mcpToken: string;
};
const digest = (c: Config) =>
  createHash("sha256")
    .update(
      canonical({
        review: c.finitePilot,
        tenant: c.tenant,
        workspace: c.workspace,
        connectionId: c.connectionId,
        workflowId: c.workflowId,
        delegationId: c.delegationId,
        profileId: c.profileId,
        tokenHash: createHash("sha256").update(c.mcpToken).digest("hex"),
      }),
    )
    .digest("hex");
/** A local safety ledger, not cost evidence, enrollment or source authority.
 * Owner supplies the existing encrypted worker store and IMMEDIATE transaction.
 * Never resets counters, changes an approved interval or permits another run. */
export class CentralFinitePilot {
  constructor(
    private store: {
      read(): unknown;
      write(s: State): void;
      atomic<T>(f: () => T): T;
    },
    private now = Date.now,
  ) {}
  snapshot() {
    const raw = this.store.read();
    return raw === null ? null : stateSchema.parse(raw);
  }
  configure(c: Config) {
    this.store.atomic(() => {
      const previous = this.snapshot();
      if (!c.finitePilot) {
        if (previous)
          throw Error("A finite pilot review cannot be removed or reset");
        return;
      }
      const review = finitePilotReviewSchema.parse(c.finitePilot),
        at = this.now();
      if (
        !Number.isSafeInteger(at) ||
        at < review.approvedAt ||
        at >= review.expiresAt
      )
        throw Error("Current finite pilot review required");
      if (previous) {
        this.current(c, previous);
        return;
      }
      this.store.write({
        digest: digest(c),
        lastAt: at,
        claim: null,
        renew: null,
        complete: null,
        modelTurns: 0,
        stopped: false,
        reason: null,
      });
    });
  }
  private current(c: Config, s: State) {
    const review = finitePilotReviewSchema.parse(c.finitePilot),
      at = this.now();
    if (
      s.stopped ||
      s.digest !== digest(c) ||
      !Number.isSafeInteger(at) ||
      at < s.lastAt ||
      at < review.approvedAt ||
      at >= review.expiresAt
    )
      throw Error(
        "Finite pilot stopped, changed, expired or lost clock continuity",
      );
  }
  assert(c: Config) {
    const failure = this.store.atomic(() => {
      const s = this.snapshot();
      if (!c.finitePilot && !s) return null;
      if (!s) return Error("Finite pilot ledger missing");
      try {
        if (!c.finitePilot) throw Error("Finite pilot review missing");
        this.current(c, s);
        s.lastAt = this.now();
        this.store.write(s);
        return null;
      } catch {
        if (!s.stopped) {
          s.stopped = true;
          s.reason = "review-invalid";
          this.store.write(s);
        }
        return Error("Finite pilot review held; no reset is permitted");
      }
    });
    if (failure) throw failure;
  }
  reserve(c: Config, action: string, id: string) {
    if (!c.finitePilot) {
      this.assert(c);
      return;
    }
    this.store.atomic(() => {
      const s = this.snapshot();
      if (!s) throw Error("Finite pilot ledger missing");
      this.current(c, s);
      if (!["claim", "renew", "complete"].includes(action))
        throw Error("Unsupported finite pilot action");
      const kind = action as "claim" | "renew" | "complete",
        old = s[kind];
      z.uuid().parse(id);
      if (
        (old &&
          (old.id !== id || old.count >= (kind === "complete" ? 2 : 1))) ||
        (kind === "renew" && !s.claim) ||
        (kind === "complete" && (!s.renew || s.modelTurns !== 1))
      )
        throw Error(
          "Finite pilot action budget exhausted or operation changed",
        );
      s[kind] = { id, count: (old?.count ?? 0) + 1 };
      s.lastAt = this.now();
      this.store.write(stateSchema.parse(s));
    });
  }
  model(c: Config) {
    if (!c.finitePilot) return;
    this.store.atomic(() => {
      const s = this.snapshot();
      if (!s) throw Error("Finite pilot ledger missing");
      this.current(c, s);
      if (!s.renew || s.modelTurns !== 0)
        throw Error("Finite pilot model-turn budget exhausted");
      s.modelTurns = 1;
      s.lastAt = this.now();
      this.store.write(s);
    });
  }
  canReconcile(c: Config, operationId: string) {
    try {
      this.assert(c);
      const s = this.snapshot();
      return (
        !!c.finitePilot &&
        s?.complete?.count === 1 &&
        s.complete.id === operationId &&
        s.modelTurns === 1
      );
    } catch {
      return false;
    }
  }
  stop(c: Config, reason: string) {
    if (!c.finitePilot) return;
    this.store.atomic(() => {
      const s = this.snapshot();
      if (!s || s.digest !== digest(c))
        throw Error("Finite pilot review changed");
      s.stopped = true;
      s.reason = reason;
      this.store.write(s);
    });
  }
}
