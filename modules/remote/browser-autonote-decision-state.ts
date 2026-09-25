import { z } from "zod";
import { browserKeyProofSchema } from "./browser-key-lifecycle.js";
import { browserPeerProofSchema } from "./browser-peer-state.js";
import {
  autoNoteApprovalManifestSchema,
  autoNoteApprovalDecisionSchema,
  autoNoteApprovalReceiptSchema,
} from "./private-autonote-approval-contracts.js";
import { privateEnvelopeSchema } from "./private-envelope.js";
import { privateRelayStorageReceiptSchema } from "./private-relay-contracts.js";
import { BrowserOutboxError } from "./browser-outbox-state.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Encrypted local state only. These saved proofs never replace fresh authority checks. */
export const browserAutoNoteDecisionValueSchema = z
  .strictObject({
    manifest: autoNoteApprovalManifestSchema,
    command: autoNoteApprovalDecisionSchema,
    local: browserKeyProofSchema,
    peer: browserPeerProofSchema,
    envelope: privateEnvelopeSchema,
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    transport: privateRelayStorageReceiptSchema.nullable(),
    result: autoNoteApprovalReceiptSchema.nullable(),
    resultEnvelope: privateEnvelopeSchema.nullable(),
    stopped: z.boolean(),
  })
  .refine((v) => {
    const m = v.manifest,
      c = v.command,
      h = v.envelope.header;
    if (
      c.offerId !== m.offerId ||
      c.permissionId !== m.permissionId ||
      c.detailHash !== m.detailHash ||
      c.proposalDigest !== m.proposalDigest ||
      h.operationId !== c.id ||
      h.issuedAt !== c.issuedAt ||
      h.issuedAt < m.issuedAt ||
      h.expiresAt > m.expiresAt ||
      h.expiresAt <= h.issuedAt ||
      h.ownerId !== v.local.binding.ownerId ||
      h.senderId !== v.local.binding.deviceId ||
      h.recipientId !== v.peer.peerId ||
      h.senderKeyEpoch !== v.local.keyEpoch ||
      h.recipientKeyEpoch !== v.peer.keyEpoch ||
      !same(v.peer.key, v.local)
    )
      return false;
    if (
      v.transport &&
      (v.attempts === 0 ||
        v.transport.messageId !== h.messageId ||
        v.transport.storedAt < h.issuedAt)
    )
      return false;
    if (!v.result || !v.resultEnvelope)
      return v.result === null && v.resultEnvelope === null;
    const r = v.result,
      rh = v.resultEnvelope.header;
    return (
      r.decisionId === c.id &&
      r.offerId === c.offerId &&
      r.detailHash === c.detailHash &&
      (c.decision === "reject"
        ? r.status === "rejected"
        : r.status !== "rejected") &&
      (!r.receipt ||
        (r.receipt.operationId === m.operationId &&
          r.receipt.meetingId === m.meetingId)) &&
      rh.operationId === c.id &&
      rh.ownerId === h.ownerId &&
      rh.senderId === h.recipientId &&
      rh.recipientId === h.senderId &&
      rh.senderKeyEpoch === h.recipientKeyEpoch &&
      rh.recipientKeyEpoch === h.senderKeyEpoch &&
      rh.issuedAt >= h.issuedAt &&
      rh.expiresAt > rh.issuedAt &&
      rh.expiresAt <= m.expiresAt
    );
  });
export type BrowserAutoNoteDecisionValue = z.infer<
  typeof browserAutoNoteDecisionValueSchema
>;
export const browserAutoNoteDecisionRowSchema = z.strictObject({
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
export type BrowserAutoNoteDecisionRow = z.infer<
  typeof browserAutoNoteDecisionRowSchema
>;
export type BrowserAutoNoteDecisionEntry = {
  row: BrowserAutoNoteDecisionRow;
  value: BrowserAutoNoteDecisionValue;
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
  r: Pick<
    BrowserAutoNoteDecisionRow,
    "scope" | "id" | "deviceHash" | "revision"
  >,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "browser-autonote-decision:v1",
      r.scope,
      r.id,
      r.deviceHash,
      r.revision,
    ]),
  );
export function readBrowserAutoNoteDecisionRow(
  raw: unknown,
): BrowserAutoNoteDecisionRow {
  try {
    const row = browserAutoNoteDecisionRowSchema.parse(raw);
    key(row.key);
    return row;
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  }
}
export async function sealBrowserAutoNoteDecisionRow(
  metadata: Pick<
    BrowserAutoNoteDecisionRow,
    "scope" | "id" | "deviceHash" | "revision"
  >,
  value: BrowserAutoNoteDecisionValue,
  retained?: unknown,
): Promise<BrowserAutoNoteDecisionRow> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(browserAutoNoteDecisionValueSchema.parse(value)),
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
    return browserAutoNoteDecisionRowSchema.parse({
      ...metadata,
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
      key: storedKey,
    });
  } finally {
    bytes.fill(0);
  }
}
export async function openBrowserAutoNoteDecisionRow(
  raw: unknown,
): Promise<BrowserAutoNoteDecisionEntry> {
  const row = readBrowserAutoNoteDecisionRow(raw);
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
      value: browserAutoNoteDecisionValueSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ),
    };
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  } finally {
    bytes?.fill(0);
  }
}
