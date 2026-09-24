import { z } from "zod";
import { browserConversationGrantSchema } from "./browser-conversation-consent.js";
import {
  conversationContentSchema,
  conversationReceiptSchema,
} from "./private-conversation-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
} from "./private-envelope.js";
import { BrowserOutboxError } from "./browser-outbox-state.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const browserConversationValueSchema = z
  .strictObject({
    direction: z.enum(["incoming", "outgoing"]),
    state: z.enum(["preparing", "ready", "accepted"]),
    grant: browserConversationGrantSchema,
    content: conversationContentSchema,
    header: privateHeaderSchema,
    envelope: privateEnvelopeSchema.nullable(),
    receipt: conversationReceiptSchema.nullable(),
    receiptHeader: privateHeaderSchema.nullable(),
    receiptEnvelope: privateEnvelopeSchema.nullable(),
    requestHash: hex,
  })
  .refine(
    (v) =>
      same(v.content.scope, v.grant.choices.scope) &&
      v.header.operationId === v.content.id &&
      v.header.ownerId === v.grant.local.binding.ownerId &&
      (!v.envelope || same(v.envelope.header, v.header)) &&
      (v.direction === "outgoing"
        ? v.content.type !== "conversation.question" &&
          v.state !== "accepted" &&
          !v.receipt &&
          !v.receiptHeader &&
          !v.receiptEnvelope &&
          (v.state === "ready" ? !!v.envelope : !v.envelope) &&
          v.header.senderId === v.grant.local.binding.deviceId &&
          v.header.recipientId === v.grant.choices.peerId &&
          v.header.senderKeyEpoch === v.grant.local.keyEpoch &&
          v.header.recipientKeyEpoch === v.grant.choices.peerKeyEpoch
        : v.content.type !== "conversation.answer" &&
          v.state === "accepted" &&
          !!v.envelope &&
          !!v.receipt &&
          !!v.receiptHeader &&
          v.header.senderId === v.grant.choices.peerId &&
          v.header.recipientId === v.grant.local.binding.deviceId &&
          v.header.senderKeyEpoch === v.grant.choices.peerKeyEpoch &&
          v.header.recipientKeyEpoch === v.grant.local.keyEpoch &&
          v.receipt.acceptedId === v.content.id &&
          v.receipt.acceptedType === v.content.type &&
          v.receipt.operationId === v.content.id &&
          same(v.receipt.scope, v.content.scope) &&
          v.receiptHeader.operationId === v.content.id &&
          v.receiptHeader.ownerId === v.header.ownerId &&
          v.receiptHeader.senderId === v.header.recipientId &&
          v.receiptHeader.recipientId === v.header.senderId &&
          v.receiptHeader.senderKeyEpoch === v.header.recipientKeyEpoch &&
          v.receiptHeader.recipientKeyEpoch === v.header.senderKeyEpoch &&
          (!v.receiptEnvelope ||
            same(v.receiptEnvelope.header, v.receiptHeader))),
  );
export type BrowserConversationValue = z.infer<
  typeof browserConversationValueSchema
>;
export const browserConversationRowSchema = z.strictObject({
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
export type BrowserConversationRow = z.infer<
  typeof browserConversationRowSchema
>;
export type BrowserConversationEntry = {
  row: BrowserConversationRow;
  value: BrowserConversationValue;
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
  r: Pick<BrowserConversationRow, "scope" | "id" | "deviceHash" | "revision">,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "browser-conversation-content:v1",
      r.scope,
      r.id,
      r.deviceHash,
      r.revision,
    ]),
  );
export function readBrowserConversationRow(
  raw: unknown,
): BrowserConversationRow {
  try {
    const row = browserConversationRowSchema.parse(raw);
    key(row.key);
    return row;
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  }
}
export async function sealBrowserConversationRow(
  metadata: Pick<
    BrowserConversationRow,
    "scope" | "id" | "deviceHash" | "revision"
  >,
  value: BrowserConversationValue,
  retained?: unknown,
): Promise<BrowserConversationRow> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(browserConversationValueSchema.parse(value)),
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
    return browserConversationRowSchema.parse({
      ...metadata,
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
      key: storedKey,
    });
  } finally {
    bytes.fill(0);
  }
}
export async function openBrowserConversationRow(
  raw: unknown,
): Promise<BrowserConversationEntry> {
  const row = readBrowserConversationRow(raw);
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
      value: browserConversationValueSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ),
    };
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  } finally {
    bytes?.fill(0);
  }
}
