import { z } from "zod";
import { privateEnvelopeSchema } from "./private-envelope.js";

/** Shared wire payloads. Answering a challenge is not a task permission and does
 * not establish that the responder completed its own independent peer check. */
export const peerChallengeSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("peer.key.challenge"),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const peerResponseSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("peer.key.response"),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Preserve the original Mac transcript serialization, including every header
 * field and ciphertext byte. Schema parsing supplies deterministic key order. */
export function peerEnvelopeCanonical(raw: unknown) {
  return JSON.stringify(privateEnvelopeSchema.parse(raw));
}

/** Portable counterpart to the Mac's synchronous transcript hash. */
export async function hashPeerEnvelope(raw: unknown) {
  const bytes = new TextEncoder().encode(peerEnvelopeCanonical(raw));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
