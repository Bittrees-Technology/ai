import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { Vault } from "../storage/vault.js";
import {
  RuntimeHandoff,
  type RuntimeHandoffState,
} from "../task-sync/handoff.js";
import {
  runtimeHandoffSchema,
  runtimeHandoffMessage,
  runtimeEnrollmentMessage,
} from "../task-sync/runtime-contract.js";
import type { EnrollmentReview } from "../task-sync/enrollment-transport-plan.js";
import type { EnrollmentSession } from "../task-sync/enrollment-session.js";
import { validateEnrollmentStart } from "../task-sync/enrollment-response.js";
import { centralEnrollmentSigner } from "./central-enrollment-signer.js";

import {
  centralEnrollmentCommand,
  centralEnrollmentStatus,
} from "./central-enrollment-contract.js";
export { centralEnrollmentCommand } from "./central-enrollment-contract.js";
const reviewSchema = z.strictObject({
  epoch: z.uuid(),
  expiresAt: z.int().positive(),
  principal: z.string(),
  publicKey: z.string().max(300),
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  sourceWorkspace: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
});
const handoffSchema = z.strictObject({
  candidate: runtimeHandoffSchema,
  id: z.uuid(),
  pollSecret: z.string().regex(/^[a-f0-9]{64}$/),
  reviewUrl: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "approved", "complete", "expired", "failed"]),
  result: z.unknown().optional(),
  message: z.string().optional(),
});
const recordSchema = z.strictObject({
  review: reviewSchema,
  candidate: runtimeHandoffSchema.optional(),
  handoff: handoffSchema.optional(),
});
export type CentralEnrollmentRecord = z.infer<typeof recordSchema>;
type NativeSession = Pick<
  EnrollmentSession,
  "execute" | "snapshotForNativeOwner" | "close"
>;
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function binding(review: EnrollmentReview) {
  const {
    epoch: _epoch,
    expiresAt: _expires,
    ...scope
  } = reviewSchema.parse(review);
  return hash(scope);
}
/** Native-only orchestration. The core can ask start/poll/status, never supply a
 * key, request, challenge, polling secret or signature. One durable start marker
 * per existing central identity blocks a fresh POST after uncertainty/restart.
 * Fresh owner reviews may continue the ORIGINAL session inside its ORIGINAL
 * deadline; they cannot replace its nonce, scope, source IDs or retry budget. */
export class CentralEnrollmentOwner {
  private readonly handoff: RuntimeHandoff;
  private session?: NativeSession;
  private signer?: ReturnType<typeof centralEnrollmentSigner>;
  private signal?: AbortSignal;
  private busy = false;
  private closing = false;
  private readonly stop = new AbortController();
  constructor(
    private options: {
      path: string;
      vault: Vault;
      current: () => EnrollmentReview | null;
      store: {
        read(): unknown;
        write(record: CentralEnrollmentRecord): void;
        atomic<T>(f: () => T): T;
      };
      session: (current: () => EnrollmentReview | null) => NativeSession;
      now?: () => number;
    },
  ) {
    this.activeReview();
    this.handoff = new RuntimeHandoff(
      () => (this.record()?.handoff as RuntimeHandoffState | null) ?? null,
      (handoff) => this.update((record) => ({ ...record, handoff })),
      () => this.signing().identity(),
      (message) => {
        const startPrefix = "Bittrees native runtime handoff v1\n";
        if (message.startsWith(startPrefix)) {
          const candidate = runtimeHandoffSchema.parse(
            JSON.parse(message.slice(startPrefix.length)),
          );
          if (
            candidate.kind !== "enroll" ||
            runtimeHandoffMessage(candidate) !== message
          )
            throw Error("Exact central start required");
          this.update((record) => {
            if (record.candidate && hash(record.candidate) !== hash(candidate))
              throw Error(
                "Original central enrollment start cannot be replaced",
              );
            return { ...record, candidate };
          });
          return this.signing().startFor(candidate).signature;
        }
        // The signer obtains the challenge only from the native session that
        // authenticated and independently validated the Roles poll response.
        if (!message.startsWith("Bittrees local AI enrollment v1\n"))
          throw Error("Unsupported central enrollment signing purpose");
        const packet = this.signing().approved();
        if (runtimeEnrollmentMessage(packet.request) !== message)
          throw Error("Native approved challenge differs from handoff");
        return packet.signature;
      },
      async () => {
        throw Error("Central native enrollment transport required");
      },
      async () => {
        throw Error("Direct central enrollment fetch forbidden");
      },
      () => this.now(),
      {
        execute: (input, signal) => {
          if (!this.signal)
            throw Error("An explicit central enrollment command is required");
          return this.transport().execute(
            input,
            AbortSignal.any([signal, this.signal, this.stop.signal]),
          );
        },
      },
    );
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private record() {
    const raw = this.options.store.read();
    if (raw === null) return null;
    const record = recordSchema.parse(raw);
    if (record.candidate && record.candidate.kind !== "enroll")
      throw Error("Central enrollment activation is forbidden");
    if (
      record.handoff &&
      (!record.candidate ||
        hash(record.handoff.candidate) !== hash(record.candidate))
    )
      throw Error("Central enrollment continuity invalid");
    return record;
  }
  private activeReview(): EnrollmentReview {
    const current = reviewSchema.parse(this.options.current()),
      record = this.record(),
      now = this.now();
    if (
      this.closing ||
      !Number.isSafeInteger(now) ||
      current.expiresAt <= now ||
      current.expiresAt > now + 300000
    )
      throw Error("Current native central enrollment consent required");
    if (record) {
      if (
        binding(record.review) !== binding(current) ||
        record.review.expiresAt > current.expiresAt
      )
        throw Error("Existing central enrollment binding cannot be replaced");
      // Preserve the original internal journal epoch and its earlier deadline.
      return record.review;
    }
    return current;
  }
  private transport() {
    const review = this.activeReview();
    if (review.expiresAt <= this.now())
      throw Error(
        "Original central enrollment review expired; reconciliation required",
      );
    this.session ??= this.options.session(() => {
      try {
        const value = this.activeReview();
        return value.expiresAt > this.now() ? value : null;
      } catch {
        return null;
      }
    });
    return this.session;
  }
  private signing() {
    this.signer ??= centralEnrollmentSigner(
      this.options.path,
      this.options.vault,
      () => {
        const review = this.activeReview();
        return {
          ...review,
          purpose: "central-workflows",
          credentialId: createHash("sha256")
            .update(review.publicKey)
            .digest("hex"),
          ...(this.session?.snapshotForNativeOwner().challenge
            ? {
                approvedChallenge:
                  this.session.snapshotForNativeOwner().challenge,
              }
            : {}),
        };
      },
      () => this.now(),
    );
    return this.signer;
  }
  private update(
    change: (record: CentralEnrollmentRecord) => CentralEnrollmentRecord,
  ) {
    this.options.store.atomic(() => {
      const old = this.record();
      if (!old) throw Error("Original central enrollment marker required");
      const next = recordSchema.parse(change(old));
      if (
        hash(next.review) !== hash(old.review) ||
        JSON.stringify(next).length > 128000
      )
        throw Error("Central enrollment scope/storage limit changed");
      this.options.store.write(next);
    });
  }
  private summary() {
    const current = this.activeReview(),
      record = this.record();
    const status = this.handoff.status();
    return centralEnrollmentStatus.parse({
      purpose: "central-workflows",
      principal: current.principal,
      credentialId: createHash("sha256")
        .update(current.publicKey)
        .digest("hex"),
      sourceWorkspace: current.sourceWorkspace,
      permissionsGranted: false,
      originalReviewExpiresAt: current.expiresAt,
      originalReviewExpired: current.expiresAt <= this.now(),
      state:
        (status?.message
          ? {
              ...status,
              message:
                "The last reply was not confirmed. Reconcile this original owner review; do not start another enrollment.",
            }
          : status) ??
        (record
          ? {
              status: "held",
              message:
                "Original enrollment start requires reconciliation; no replacement request allowed",
            }
          : { status: "not-started" }),
      enrollment: this.handoff.result(),
    });
  }
  async execute(raw: unknown, signal: AbortSignal) {
    const command = centralEnrollmentCommand.parse(raw);
    signal.throwIfAborted();
    this.activeReview();
    if (command.action === "status") return this.summary();
    if (this.busy) throw Error("Central enrollment operation already active");
    this.busy = true;
    this.signal = signal;
    try {
      let record = this.record();
      if (!record) {
        if (command.action !== "start")
          throw Error("Explicit central enrollment start required");
        const review = this.activeReview();
        // Verify the existing signed device authority before creating an owner
        // request. The native verifier checks the exact ID/device/wallet and
        // rejects paused, revoked or expired authority; no raw activity leaves
        // the native helper.
        await this.transport().execute(
          { operation: "heartbeat" },
          AbortSignal.any([signal, this.stop.signal]),
        );
        this.activeReview();
        this.options.store.atomic(() => {
          if (this.record())
            throw Error("Original central enrollment already reserved");
          this.options.store.write({ review: reviewSchema.parse(review) });
        });
        await this.handoff.start({
          kind: "enroll",
          authorityId: review.authorityId,
          deviceId: review.deviceId,
          sourceWorkspace: review.sourceWorkspace,
          ownerWallet: review.ownerWallet,
        });
      } else {
        if (!record.handoff) {
          // Recover only a receipt already authenticated and saved by the native
          // session. A missing receipt stays held; never issue another start POST.
          const snapshot = this.transport().snapshotForNativeOwner();
          if (!record.candidate || !snapshot.start)
            throw Error(
              "Original central enrollment outcome uncertain; reconcile without another start",
            );
          const start = validateEnrollmentStart(
            snapshot.start,
            record.review,
            this.now(),
          );
          this.update((r) => ({
            ...r,
            handoff: { ...start, candidate: r.candidate!, status: "pending" },
          }));
          record = this.record()!;
        }
        if (
          command.action === "poll" &&
          this.handoff.status()?.status !== "complete"
        ) {
          await this.transport().execute(
            { operation: "heartbeat" },
            AbortSignal.any([signal, this.stop.signal]),
          );
          await this.handoff.tick();
        }
      }
      signal.throwIfAborted();
      return this.summary();
    } finally {
      this.signal = undefined;
      this.busy = false;
    }
  }
  close() {
    if (this.busy)
      throw Error("Drain native central enrollment before closing");
    this.closing = true;
    this.stop.abort();
    this.session?.close();
  }
}
