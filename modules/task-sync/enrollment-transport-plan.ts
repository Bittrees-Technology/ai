import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import {
  runtimeEnrollmentSchema,
  runtimeHandoffSchema,
  runtimeAttestationSchema,
} from "./runtime-contract.js";
const signature = z.string().min(1).max(200);
const poll = z.strictObject({
  id: z.uuid(),
  pollSecret: z.string().regex(/^[a-f0-9]{64}$/),
});
export const enrollmentOperation = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("heartbeat") }),
  z.strictObject({
    operation: z.literal("start"),
    request: runtimeHandoffSchema,
    signature,
  }),
  z.strictObject({ operation: z.literal("poll"), ...poll.shape }),
  z.strictObject({
    operation: z.literal("attest"),
    request: runtimeEnrollmentSchema,
    signature,
  }),
  z.strictObject({
    operation: z.literal("complete"),
    ...poll.shape,
    proof: z.strictObject({
      request: runtimeEnrollmentSchema,
      signature,
      attestation: z.strictObject({
        request: runtimeAttestationSchema,
        signature,
      }),
    }),
  }),
]);
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export type EnrollmentReview = Readonly<{
  epoch: string;
  expiresAt: number;
  authorityId: string;
  deviceId: string;
  sourceWorkspace: string;
  principal: string;
  publicKey: string;
  ownerWallet: string;
  requestId?: string;
  pollSecretHash?: string;
}>;
/** Offline-only planner. No fetch, sockets, credentials, runtime registration or authority grants.
 * A future native transport must independently enforce pinned TLS/DNS and response bounds.
 */
export class EnrollmentTransportPlan {
  private readonly deadline: number;
  private readonly epoch: string;
  private starts = 0;
  private calls = 0;
  private readonly binding: string;
  private polls = 0;
  private completions = 0;
  private lastPoll = -Infinity;
  private completeHash?: string;
  constructor(
    private readonly current: () => EnrollmentReview | null,
    private readonly now = Date.now,
  ) {
    const review = current();
    if (
      !review ||
      review.expiresAt <= now() ||
      review.expiresAt > now() + 300000
    )
      throw Error("Explicit bounded enrollment review required");
    this.deadline = review.expiresAt;
    this.epoch = review.epoch;
    this.binding = this.scope(review);
  }
  private scope(r: EnrollmentReview) {
    return hash({
      authorityId: r.authorityId,
      deviceId: r.deviceId,
      sourceWorkspace: r.sourceWorkspace,
      principal: r.principal,
      publicKey: r.publicKey,
      ownerWallet: r.ownerWallet,
    });
  }
  prepare(raw: unknown) {
    const review = this.current();
    if (
      !review ||
      review.epoch !== this.epoch ||
      review.expiresAt !== this.deadline ||
      this.scope(review) !== this.binding ||
      this.calls >= 108 ||
      this.now() >= this.deadline
    )
      throw Error("Enrollment review expired or revoked");
    if (Buffer.byteLength(JSON.stringify(raw)) > 16000)
      throw Error("Enrollment request too large");
    const value = enrollmentOperation.parse(raw);
    let body: unknown, url: string;
    const bind = (
      request:
        | z.infer<typeof runtimeEnrollmentSchema>
        | z.infer<typeof runtimeHandoffSchema>,
    ) => {
      for (const field of [
        "authorityId",
        "deviceId",
        "sourceWorkspace",
        "principal",
        "publicKey",
      ] as const)
        if (request[field] !== review[field])
          throw Error("Reviewed device scope mismatch");
      if (Math.abs(this.now() - request.issuedAt) > 15000)
        throw Error("Stale enrollment request");
    };
    if (value.operation === "start") {
      if (
        value.request.kind !== "enroll" ||
        value.request.ownerWallet !== review.ownerWallet
      )
        throw Error("Enrollment-only scope required");
      bind(value.request);
      if (this.starts)
        throw Error("Reconcile prior start before another session");
      body = { request: value.request, signature: value.signature };
    } else if (value.operation === "attest") {
      bind(value.request);
      body = {
        action: "runtime-attestation",
        input: {
          purpose: "enroll",
          request: value.request,
          signature: value.signature,
        },
      };
    } else if (value.operation === "heartbeat") {
      body = { action: "device", input: { action: "heartbeat" } };
    } else {
      if (
        value.id !== review.requestId ||
        hash(value.pollSecret) !== review.pollSecretHash
      )
        throw Error("Owner request binding mismatch");
      if (value.operation === "poll") {
        if (this.polls >= 100 || this.now() - this.lastPoll < 3000)
          throw Error("Polling bound reached");
        body = { id: value.id, pollSecret: value.pollSecret };
      } else {
        bind(value.proof.request);
        const attestation = value.proof.attestation.request;
        if (
          attestation.purpose !== "enroll" ||
          attestation.deviceId !== review.deviceId ||
          attestation.authorityId !== review.authorityId ||
          attestation.principal !== review.principal ||
          attestation.sourceWorkspace !== review.sourceWorkspace ||
          attestation.ownerWallet !== review.ownerWallet ||
          attestation.requestDigest !== hash(value.proof.request) ||
          attestation.expiresAt <= this.now()
        )
          throw Error("Attestation scope mismatch");
        if (
          this.completions >= 2 ||
          (this.completeHash && this.completeHash !== hash(value))
        )
          throw Error("Reconcile prior completion");
        body = {
          id: value.id,
          pollSecret: value.pollSecret,
          proof: value.proof,
        };
      }
    }
    url = ["heartbeat", "attest"].includes(value.operation)
      ? "https://ai.bittrees.org/api/workflows"
      : "https://roles.bittrees.org/api/mcp/runtime/" + value.operation;
    this.calls++;
    if (value.operation === "start") this.starts++;
    if (value.operation === "poll") {
      this.polls++;
      this.lastPoll = this.now();
    }
    if (value.operation === "complete") {
      this.completions++;
      this.completeHash = hash(value);
    }
    return {
      method: "POST" as const,
      url,
      redirect: "error" as const,
      body,
      timeoutMs: Math.min(15000, this.deadline - this.now()),
      maximumResponseBytes: 64000,
      epoch: this.epoch,
    };
  }
}
