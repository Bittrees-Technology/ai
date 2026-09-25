import { z } from "zod";
import { privateEnvelopeSchema } from "./private-envelope.js";

/** These are authenticated payload types, never an outer relay dispatch hint.
 * An acceptance and a result deliberately use distinct roles for the same task
 * operation. An unrelated family cannot hide a reused message or sequence. */
export const privateReplayTypeSchema = z.enum([
  "peer.key.challenge",
  "peer.key.response",
  "task.submit",
  "task.resume",
  "task.resume.offer",
  "task.resumed",
  "task.accepted",
  "task.result",
  "conversation.offer",
  "conversation.message",
  "conversation.question",
  "conversation.answer",
  "conversation.received",
]);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const privateReplayIdentitySchema = z.strictObject({
  version: z.literal(1),
  type: privateReplayTypeSchema,
  operation: hex,
  message: hex,
  sequence: hex,
  envelope: hex,
});
export type PrivateReplayIdentity = z.infer<typeof privateReplayIdentitySchema>;

export class PrivateReplayError extends Error {
  constructor(readonly code: "CONFLICT" | "STORAGE_UNAVAILABLE") {
    super(code);
  }
}

const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/** Compute before opening a write transaction, AFTER authenticated decryption
 * and strict payload validation. This only builds index candidates: it does not
 * authenticate, authorize, consume replay state, acknowledge or execute anything.
 * Storage must additionally namespace every index by its local owner scope.
 */
export async function privateReplayIdentity(
  rawEnvelope: unknown,
  authenticatedType: z.infer<typeof privateReplayTypeSchema>,
): Promise<PrivateReplayIdentity> {
  const envelope = privateEnvelopeSchema.parse(rawEnvelope),
    type = privateReplayTypeSchema.parse(authenticatedType),
    h = envelope.header;
  const [operation, message, sequence, transcript] = await Promise.all([
    digest(["private-incoming-operation:v1", h.ownerId, type, h.operationId]),
    digest(["private-incoming-message:v1", h.ownerId, h.messageId]),
    digest([
      "private-incoming-sequence:v1",
      h.ownerId,
      h.senderId,
      h.recipientId,
      h.senderKeyEpoch,
      h.recipientKeyEpoch,
      h.sequence,
    ]),
    digest(["private-incoming-envelope:v1", envelope]),
  ]);
  return {
    version: 1,
    type,
    operation,
    message,
    sequence,
    envelope: transcript,
  };
}

/** Given the DISTINCT rows matching operation OR message OR directed sequence
 * in the same owner scope, accept only an exact retained identity as a duplicate.
 * Never substitute semantic plaintext equality for original ciphertext equality.
 * The caller must run this with fresh permission checks, retained outcome lookup
 * and all durable effects in one transaction. Zero rows is only a candidate for
 * first acceptance; missing parents, stale tasks or denied consent must still
 * leave the transaction without a replay record or acknowledgement.
 */
export function classifyPrivateReplay(
  rawCandidate: unknown,
  rawMatches: readonly unknown[],
): "new" | "duplicate" {
  const candidate = privateReplayIdentitySchema.parse(rawCandidate);
  if (rawMatches.length === 0) return "new";
  if (rawMatches.length > 1) throw new PrivateReplayError("CONFLICT");
  const parsed = privateReplayIdentitySchema.safeParse(rawMatches[0]);
  if (!parsed.success) throw new PrivateReplayError("STORAGE_UNAVAILABLE");
  const prior = parsed.data;
  if (
    prior.type !== candidate.type ||
    prior.operation !== candidate.operation ||
    prior.message !== candidate.message ||
    prior.sequence !== candidate.sequence ||
    prior.envelope !== candidate.envelope
  )
    throw new PrivateReplayError("CONFLICT");
  return "duplicate";
}
