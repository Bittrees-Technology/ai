import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { EnrollmentHTTPS } from "../task-sync/enrollment-https.js";
import { enrollmentOperationId } from "../task-sync/enrollment-journal.js";
import { validateHistoricalEnrollmentReceipt } from "../task-sync/enrollment-response.js";
import { EnrollmentResponseVerifier } from "../task-sync/enrollment-verifier.js";
import { enrollmentSessionScopeDigest } from "../task-sync/enrollment-session.js";
import type { EnrollmentReview } from "../task-sync/enrollment-transport-plan.js";
import type { Vault } from "../storage/vault.js";
import type { CentralEnrollmentRecord } from "./central-enrollment-owner.js";
import { centralEnrollmentSigner } from "./central-enrollment-signer.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = {
  version: z.literal(1),
  id: z.uuid(),
  operationId: z.uuid(),
  candidateDigest: hex,
  expiresAt: z.iso.datetime(),
  checkedAt: z.int().positive(),
};
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...envelope, status: z.literal("not-committed") }),
  z.strictObject({
    ...envelope,
    status: z.literal("committed"),
    result: z.unknown(),
  }),
]);
export const centralEnrollmentSettlement = z.strictObject({
  operationId: z.uuid(),
  operationKind: z.literal("start").optional(),
  candidateDigest: hex,
  requestDigest: hex,
  outcome: z.enum(["not-committed", "committed"]),
  responseDigest: hex,
  checkedAt: z.int().positive(),
  recoveryEpoch: z.uuid(),
});
const operationSchema = z.strictObject({
  operationId: z.uuid(),
  epoch: z.uuid(),
  kind: z.enum(["start", "complete"]),
  requestDigest: hex,
  state: z.enum(["reserved", "confirmed"]),
  responseDigest: hex.optional(),
});
const sessionSchema = z.object({
  epoch: z.uuid(),
  scopeDigest: hex,
  requestId: z.uuid(),
  pollSecretHash: hex,
  enrollmentRequestDigest: hex.optional(),
  start: z.unknown(),
  challenge: z.unknown().optional(),
  challengeReviewExpiresAt: z.int().positive().optional(),
  completion: z.unknown().optional(),
});
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha256(canonical(value));

/** A single protected read of the original outcome under fresh native consent.
 * No caller-supplied source identity, credentials, URL, or mutation is accepted. */
export function centralEnrollmentReconciliation(options: {
  db: Database.Database;
  vault: Vault;
  centralStatePath: string;
  current: () => EnrollmentReview | null;
  admitted: () => boolean;
  credential: () => string;
  pinnedSigner: string;
  reserveCost?: () => void;
  resolve?: ConstructorParameters<typeof EnrollmentHTTPS>[2];
  send?: ConstructorParameters<typeof EnrollmentHTTPS>[3];
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (original: CentralEnrollmentRecord, signal: AbortSignal) => {
    const { review, candidate, handoff } = original;
    const fresh = options.current();
    if (
      !fresh ||
      !candidate ||
      !handoff ||
      handoff.status === "complete" ||
      fresh.epoch === review.epoch ||
      review.expiresAt > now() ||
      Date.parse(handoff.expiresAt) + 120000 > now() ||
      enrollmentSessionScopeDigest({
        ...fresh,
        epoch: review.epoch,
        expiresAt: review.expiresAt,
      }) !== enrollmentSessionScopeDigest(review)
    )
      throw Error(
        "Original expired handoff and fresh matching native review required",
      );
    const freshDigest = enrollmentSessionScopeDigest(fresh);
    const admit = (epoch: string) => {
      const current = options.current(),
        at = now();
      if (
        !options.admitted() ||
        !current ||
        epoch !== fresh.epoch ||
        current.expiresAt <= at ||
        current.expiresAt > at + 300000 ||
        enrollmentSessionScopeDigest(current) !== freshDigest
      )
        throw Error("Native reconciliation admission changed");
    };
    admit(fresh.epoch);
    signal.throwIfAborted();
    const read = (sql: string, id: string, aad: string) => {
      const row = options.db.prepare(sql).get(id) as
        { value?: Buffer } | undefined;
      if (!row) return undefined;
      if (!Buffer.isBuffer(row.value) || row.value.length > 160000)
        throw Error("Original enrollment journal entry required");
      return options.vault.open(row.value, aad + id);
    };
    const readOperation = (id: string) =>
      read(
        "SELECT value FROM enrollment_operations WHERE id=?",
        id,
        "enrollment-operation:",
      );
    const completionId = enrollmentOperationId(review.epoch, "complete");
    const completion = readOperation(completionId);
    const checkingStart = completion === undefined;
    const operationId = checkingStart
      ? enrollmentOperationId(review.epoch, "start")
      : completionId;
    const operation = operationSchema.parse(
      checkingStart ? readOperation(operationId) : completion,
    );
    const session = sessionSchema.parse(
      read(
        "SELECT value FROM enrollment_sessions WHERE epoch=?",
        review.epoch,
        "enrollment-session:",
      ),
    );
    const start = {
      id: handoff.id,
      pollSecret: handoff.pollSecret,
      reviewUrl: handoff.reviewUrl,
      expiresAt: handoff.expiresAt,
    };
    if (
      operation.operationId !== operationId ||
      operation.epoch !== review.epoch ||
      operation.kind !== (checkingStart ? "start" : "complete") ||
      (operation.state === "confirmed") !== Boolean(operation.responseDigest) ||
      session.epoch !== review.epoch ||
      session.scopeDigest !== enrollmentSessionScopeDigest(review) ||
      session.requestId !== handoff.id ||
      session.pollSecretHash !== digest(handoff.pollSecret) ||
      digest(session.start) !== digest(start)
    )
      throw Error("Original enrollment journals disagree");
    if (
      checkingStart
        ? operation.state !== "confirmed" ||
          operation.responseDigest !== digest(start) ||
          session.completion !== undefined
        : !session.enrollmentRequestDigest ||
          session.enrollmentRequestDigest !== digest(session.challenge)
    )
      throw Error("Original enrollment mutation evidence disagrees");
    const challengeDeadline = recordChallengeDeadline(
      original,
      session.challengeReviewExpiresAt,
    );
    const signer = centralEnrollmentSigner(
      options.centralStatePath,
      options.vault,
      () => {
        admit(fresh.epoch);
        return {
          ...fresh,
          purpose: "central-workflows",
          credentialId: sha256(fresh.publicKey),
        };
      },
      now,
    );
    const transport = new EnrollmentHTTPS(
      admit,
      options.credential,
      options.resolve,
      options.send,
    );
    const readSource = async (url: string, body: unknown) => {
      admit(fresh.epoch);
      signal.throwIfAborted();
      options.reserveCost?.();
      const bytes = await transport.dispatch(
        {
          method: "POST",
          url,
          redirect: "error",
          maximumResponseBytes: 64000,
          timeoutMs: Math.min(15000, fresh.expiresAt - now()),
          epoch: fresh.epoch,
          body,
        },
        signal,
      );
      admit(fresh.epoch);
      signal.throwIfAborted();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    };
    const verifier = new EnrollmentResponseVerifier(
      () => fresh,
      () => undefined,
      options.pinnedSigner,
      now,
    );
    verifier.verify(
      { operation: "heartbeat" },
      await readSource("https://ai.bittrees.org/api/workflows", {
        action: "device",
        input: { action: "heartbeat" },
      }),
    );
    const request = {
      version: 1,
      id: handoff.id,
      operationId,
      candidateDigest: digest(candidate),
      pollSecretHash: sha256(handoff.pollSecret),
      issuedAt: now(),
      ...(checkingStart ? { operation: "start" as const } : {}),
    };
    const packet = signer.reconcile(request);
    const response = responseSchema.parse(
      await readSource("https://roles.bittrees.org/api/mcp/runtime/reconcile", {
        ...packet,
        pollSecret: handoff.pollSecret,
      }),
    );
    if (
      response.id !== request.id ||
      response.operationId !== operationId ||
      response.candidateDigest !== request.candidateDigest ||
      response.expiresAt !== handoff.expiresAt ||
      response.checkedAt < Date.parse(handoff.expiresAt) + 120000 ||
      Math.abs(now() - response.checkedAt) > 30000
    )
      throw Error("Roles reconciliation differs from the original enrollment");
    if (
      (checkingStart && response.status !== "not-committed") ||
      (!checkingStart &&
        response.status === "not-committed" &&
        (operation.state === "confirmed" || session.completion))
    )
      throw Error("Roles outcome conflicts with a saved native completion");
    const result =
      response.status === "committed" && session.enrollmentRequestDigest
        ? validateHistoricalEnrollmentReceipt(
            { status: "complete", result: response.result },
            {
              ...review,
              expiresAt: challengeDeadline,
              enrollmentRequestDigest: session.enrollmentRequestDigest,
            },
            session.challenge,
          )
        : null;
    if (
      result &&
      ((operation.responseDigest &&
        operation.responseDigest !== digest(result)) ||
        (session.completion && digest(session.completion) !== digest(result)))
    )
      throw Error("Roles receipt conflicts with a saved native completion");
    return {
      settlement: centralEnrollmentSettlement.parse({
        operationId,
        ...(checkingStart ? { operationKind: "start" } : {}),
        candidateDigest: request.candidateDigest,
        requestDigest: operation.requestDigest,
        outcome: response.status,
        responseDigest: digest(response),
        checkedAt: response.checkedAt,
        recoveryEpoch: fresh.epoch,
      }),
      result: result?.result,
    };
  };
}

function recordChallengeDeadline(
  record: CentralEnrollmentRecord,
  deadline?: number,
) {
  if (!record.deferredFrom || deadline === undefined)
    return record.review.expiresAt;
  if (
    deadline < record.review.expiresAt ||
    !record.handoff ||
    deadline > Date.parse(record.handoff.expiresAt)
  )
    throw Error(
      "Deferred completion review exceeds the original Roles deadline",
    );
  return deadline;
}
