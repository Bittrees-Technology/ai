import { z } from "zod";
import { browserResumeGrantSchema } from "./browser-resume-consent.js";
import {
  privateResumeCommandSchema,
  privateResumeReceiptSchema,
} from "./private-resume-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
} from "./private-envelope.js";
import { BrowserOutboxError } from "./browser-outbox-state.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Storage validation only. None of these records supplies current authority.
 * The delivery controller must revalidate consent and replay in its commit transaction. */
export const browserResumeDeliveryValueSchema = z
  .strictObject({
    state: z.enum(["preparing", "ready", "accepted"]),
    stopped: z.boolean(),
    grant: browserResumeGrantSchema,
    request: privateResumeCommandSchema,
    header: privateHeaderSchema,
    envelope: privateEnvelopeSchema.nullable(),
    receipt: privateResumeReceiptSchema.nullable(),
    receiptEnvelope: privateEnvelopeSchema.nullable(),
    requestHash: hex,
  })
  .refine((v) => {
    const c = v.request.command,
      g = v.grant,
      h = v.header;
    if (
      g.revoked ||
      c.id !== h.operationId ||
      c.deviceId !== g.choices.peerId ||
      c.permissionId !== g.choices.permissionId ||
      c.taskId !== g.choices.taskId ||
      c.expectedRevision !== g.choices.taskRevision ||
      Date.parse(c.issuedAt) !== h.issuedAt ||
      Date.parse(c.expiresAt) !== h.expiresAt ||
      h.issuedAt < g.approvedAt ||
      h.expiresAt <= h.issuedAt ||
      h.expiresAt > g.choices.expiresAt ||
      h.ownerId !== g.local.binding.ownerId ||
      h.senderId !== g.local.binding.deviceId ||
      h.recipientId !== g.choices.peerId ||
      h.senderId === h.recipientId ||
      h.senderKeyEpoch !== g.local.keyEpoch ||
      h.recipientKeyEpoch !== g.choices.peerKeyEpoch ||
      (v.state === "preparing" ? !!v.envelope : !v.envelope) ||
      (v.envelope && !same(v.envelope.header, h))
    )
      return false;
    if (v.state !== "accepted")
      return v.receipt === null && v.receiptEnvelope === null;
    if (!v.receipt || !v.receiptEnvelope) return false;
    const r = v.receipt.receipt,
      rh = v.receiptEnvelope.header;
    return (
      r.id === c.id &&
      r.deviceId === c.deviceId &&
      r.permissionId === c.permissionId &&
      r.taskId === c.taskId &&
      r.taskRevision === c.expectedRevision + 1 &&
      Date.parse(r.completedAt) >= h.issuedAt &&
      Date.parse(r.completedAt) <= rh.issuedAt &&
      rh.operationId === h.operationId &&
      rh.ownerId === h.ownerId &&
      rh.senderId === h.recipientId &&
      rh.recipientId === h.senderId &&
      rh.senderKeyEpoch === h.recipientKeyEpoch &&
      rh.recipientKeyEpoch === h.senderKeyEpoch &&
      rh.issuedAt >= h.issuedAt &&
      rh.expiresAt > rh.issuedAt &&
      rh.expiresAt <= g.offer.expiresAt
    );
  });
export type BrowserResumeDeliveryValue = z.infer<
  typeof browserResumeDeliveryValueSchema
>;
export const browserResumeDeliveryRowSchema = z.strictObject({
  scope: hex,
  id: hex,
  deviceHash: hex,
  revision: positive,
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(270000),
  key: z.unknown(),
});
export type BrowserResumeDeliveryRow = z.infer<
  typeof browserResumeDeliveryRowSchema
>;
export type BrowserResumeDeliveryEntry = {
  row: BrowserResumeDeliveryRow;
  value: BrowserResumeDeliveryValue;
};
function encode(bytes: Uint8Array) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 4096)
    result += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(result)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(bytes) !== value) throw Error();
  return bytes;
}
function key(raw: unknown): CryptoKey {
  if (
    !(raw instanceof CryptoKey) ||
    raw.type !== "secret" ||
    raw.extractable ||
    raw.algorithm.name !== "AES-GCM" ||
    (raw.algorithm as AesKeyAlgorithm).length !== 256 ||
    !same([...raw.usages].sort(), ["decrypt", "encrypt"])
  )
    throw Error();
  return raw;
}
const aad = (
  r: Pick<BrowserResumeDeliveryRow, "scope" | "id" | "deviceHash" | "revision">,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "browser-resume-delivery:v1",
      r.scope,
      r.id,
      r.deviceHash,
      r.revision,
    ]),
  );
export function readBrowserResumeDeliveryRow(
  raw: unknown,
): BrowserResumeDeliveryRow {
  try {
    const row = browserResumeDeliveryRowSchema.parse(raw);
    key(row.key);
    return row;
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  }
}
export async function sealBrowserResumeDeliveryRow(
  metadata: Pick<
    BrowserResumeDeliveryRow,
    "scope" | "id" | "deviceHash" | "revision"
  >,
  value: BrowserResumeDeliveryValue,
  retained?: unknown,
): Promise<BrowserResumeDeliveryRow> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(browserResumeDeliveryValueSchema.parse(value)),
  );
  try {
    if (bytes.length > 200000) throw new BrowserOutboxError("CAPACITY");
    const storedKey = retained
      ? key(retained)
      : await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(metadata) },
      storedKey,
      bytes,
    );
    return browserResumeDeliveryRowSchema.parse({
      ...metadata,
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
      key: storedKey,
    });
  } finally {
    bytes.fill(0);
  }
}
export async function openBrowserResumeDeliveryRow(
  raw: unknown,
): Promise<BrowserResumeDeliveryEntry> {
  const row = readBrowserResumeDeliveryRow(raw);
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(row.iv), additionalData: aad(row) },
        key(row.key),
        decode(row.ciphertext),
      ),
    );
    if (bytes.length > 200000) throw Error();
    return {
      row,
      value: browserResumeDeliveryValueSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ),
    };
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  } finally {
    bytes?.fill(0);
  }
}
