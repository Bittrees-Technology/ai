import { z } from "zod";
const uuid = z.uuid().regex(/^[a-f0-9-]+$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const privateBindingSchema = z.strictObject({
  ownerId: uuid,
  deviceId: uuid,
  credentialEpoch: positive,
  expiresAt: positive,
});
export type PrivateBinding = z.infer<typeof privateBindingSchema>;
export const privateInvitationSchema = z.strictObject({
  version: z.literal(1),
  ownerId: uuid,
  recipientId: uuid,
  peerId: uuid,
  keyEpoch: positive,
  publicKey: z
    .string()
    .length(87)
    .regex(/^[A-Za-z0-9_-]+$/),
  nonce: uuid,
  issuedAt: positive,
  expiresAt: positive,
});
export type PrivateInvitation = z.infer<typeof privateInvitationSchema>;
const text = new TextEncoder();
export function privateInvitationBytes(i: PrivateInvitation) {
  return text.encode(
    JSON.stringify([
      "org.bittrees.ai/private-peer-review/v1",
      i.version,
      i.ownerId,
      i.recipientId,
      i.peerId,
      i.keyEpoch,
      i.publicKey,
      i.nonce,
      i.issuedAt,
      i.expiresAt,
    ]),
  );
}
export function privateInvitationTime(i: PrivateInvitation, now: number) {
  return (
    Number.isSafeInteger(now) &&
    now > 0 &&
    i.recipientId !== i.peerId &&
    i.issuedAt <= now + 30000 &&
    i.expiresAt > now &&
    i.expiresAt > i.issuedAt &&
    i.expiresAt - i.issuedAt <= 300000
  );
}
export async function inspectPrivateInvitation(raw: unknown, now: number) {
  const invitation = privateInvitationSchema.parse(raw);
  if (!privateInvitationTime(invitation, now))
    throw Error("INVALID_INVITATION");
  const bytes = Uint8Array.from(
    atob(invitation.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (bytes.length !== 65 || bytes[0] !== 4 || encoded !== invitation.publicKey)
    throw Error("INVALID_INVITATION");
  // HPKE serializes public keys; only this already-public material is extractable.
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const hex = (b: ArrayBuffer) =>
    Array.from(new Uint8Array(b), (n) => n.toString(16).padStart(2, "0")).join(
      "",
    );
  const fingerprint = hex(
    await crypto.subtle.digest("SHA-256", privateInvitationBytes(invitation)),
  );
  const keyHash = hex(await crypto.subtle.digest("SHA-256", bytes));
  return { invitation, publicKey, fingerprint, keyHash };
}
