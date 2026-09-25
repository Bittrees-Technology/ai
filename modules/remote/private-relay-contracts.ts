import { z } from "zod";
import {
  privateEnvelopeSchema,
  privateEnvelopeLimit,
  type PrivateEnvelope,
} from "./private-envelope.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const privateRelayBodyLimit = 96 * 1024;
const httpsOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && u.origin === value;
    } catch {
      return false;
    }
  });
/** Explicit future-host policy. No defaults and no live configuration are supplied. */
export const privateRelayPolicySchema = z.strictObject({
  version: z.literal(1),
  origin: httpsOrigin,
  chainId: positive,
  receivedContent: z.enum(["delete-after-receipt", "until-deleted"]),
  unreceivedContent: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("until-deleted") }),
    z.strictObject({
      mode: z.literal("bounded"),
      retentionMs: z
        .number()
        .int()
        .min(60000)
        .max(30 * 86400000),
    }),
  ]),
  operationalMetadataMs: z.union([
    z.literal(7 * 86400000),
    z.literal(30 * 86400000),
    z.literal(90 * 86400000),
  ]),
  maxMessagesPerOwner: z.number().int().min(1).max(10000),
  maxBytesPerOwner: z
    .number()
    .int()
    .min(privateRelayBodyLimit)
    .max(1024 * 1024 * 1024),
});
/** Server-authenticated transport grant, independent from status/control/template
 * credentials and from endpoint-local consent to decrypt or execute a task. */
export const privateRelayIdentitySchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("private:relay"),
  ownerId: uuid,
  endpointId: uuid,
  endpointKind: z.enum(["browser", "mac"]),
  credentialEpoch: positive,
  permissionId: uuid,
  expiresAt: positive,
});
export type PrivateRelayIdentity = z.infer<typeof privateRelayIdentitySchema>;
export const privateRelayRecipientSchema = z.strictObject({ endpointId: uuid });
export const privateRelaySubmitSchema = z.strictObject({
  version: z.literal(1),
  envelope: privateEnvelopeSchema,
});
export const privateRelayPageSchema = z.strictObject({
  after: z.strictObject({ storedAt: positive, messageId: uuid }).nullable(),
  limit: z.number().int().min(1).max(20),
});
export const privateRelayAcknowledgeSchema = z.strictObject({
  messageId: uuid,
  envelopeHash: digest,
  expectedRevision: positive,
  confirmed: z.literal(true),
});
export const privateRelayDeleteSchema = z.strictObject({
  messageId: uuid,
  expectedRevision: positive,
  confirmed: z.literal(true),
});
/** Relay storage state is never an endpoint task acceptance or execution receipt. */
export const privateRelayStorageReceiptSchema = z.strictObject({
  version: z.literal(1),
  messageId: uuid,
  envelopeHash: digest,
  revision: positive,
  storedAt: positive,
  state: z.enum(["stored", "received", "deleted"]),
});
export class PrivateRelayInputError extends Error {
  constructor() {
    super("PRIVATE_RELAY_INVALID");
  }
}
function decode(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const canonical = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (canonical !== value) throw new PrivateRelayInputError();
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
/** Structural ingress validation only. Identities MUST come from authenticated,
 * current locked server grants, never request JSON. No key/payload is opened and
 * no cryptographic authenticity, task permission or delivery is inferred. */
export function parsePrivateRelaySubmission(
  raw: unknown,
  rawSender: unknown,
  rawRecipient: unknown,
  now = Date.now(),
): { version: 1; envelope: PrivateEnvelope } {
  try {
    const input = privateRelaySubmitSchema.parse(raw),
      sender = privateRelayIdentitySchema.parse(rawSender),
      recipient = privateRelayIdentitySchema.parse(rawRecipient),
      h = input.envelope.header;
    if (
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      sender.ownerId !== recipient.ownerId ||
      h.ownerId !== sender.ownerId ||
      h.senderId !== sender.endpointId ||
      h.recipientId !== recipient.endpointId ||
      sender.endpointId === recipient.endpointId ||
      sender.endpointKind === recipient.endpointKind ||
      sender.expiresAt <= now ||
      recipient.expiresAt <= now ||
      h.issuedAt > now + 30000 ||
      h.expiresAt <= now ||
      h.expiresAt <= h.issuedAt ||
      h.expiresAt - h.issuedAt > 86400000 ||
      h.expiresAt > Math.min(sender.expiresAt, recipient.expiresAt) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
        privateRelayBodyLimit
    )
      throw new PrivateRelayInputError();
    const enc = decode(input.envelope.enc),
      ciphertext = decode(input.envelope.ciphertext);
    if (
      enc.length !== 65 ||
      enc[0] !== 4 ||
      ciphertext.length < 17 ||
      ciphertext.length > privateEnvelopeLimit + 16
    )
      throw new PrivateRelayInputError();
    return input;
  } catch {
    throw new PrivateRelayInputError();
  }
}

/** Stable exact-envelope identity for upload reconciliation and destination
 * acknowledgement. Hashing grants no authority and is not authentication. */
export async function privateRelayEnvelopeHash(raw: unknown): Promise<string> {
  try {
    const envelope = privateEnvelopeSchema.parse(raw);
    const bytes = new TextEncoder().encode(
      "org.bittrees.ai/private-relay-envelope/v1\0" + JSON.stringify(envelope),
    );
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new PrivateRelayInputError();
  }
}
