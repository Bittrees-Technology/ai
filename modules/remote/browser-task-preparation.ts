import { z } from "zod";
import {
  BrowserOutboxError,
  browserDeliveryContextSchema,
  type BrowserDeliveryContext,
  type BrowserOutboxEntry,
} from "./browser-outbox-state.js";
import { privateTaskPayloadSchema } from "./private-task-contracts.js";
import { privateEnvelopeLimit } from "./private-envelope.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z
  .strictObject({
    id: z.uuid(),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    context: browserDeliveryContextSchema,
    issuedAt: positive,
    expiresAt: positive,
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(88000),
    key: z.unknown(),
  })
  .refine(
    (v) =>
      v.expiresAt > v.issuedAt &&
      v.expiresAt - v.issuedAt <= 86400000 &&
      v.expiresAt <= v.context.binding.expiresAt,
  );
export type BrowserTaskPreparation = z.infer<typeof schema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function encode(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096)
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encode(bytes) !== value)
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  return bytes;
}
function key(value: unknown): CryptoKey {
  if (
    !(value instanceof CryptoKey) ||
    value.type !== "secret" ||
    value.extractable ||
    value.algorithm.name !== "AES-GCM" ||
    (value.algorithm as AesKeyAlgorithm).length !== 256 ||
    !same([...value.usages].sort(), ["decrypt", "encrypt"])
  )
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  return value;
}
const aad = (
  p: Pick<
    BrowserTaskPreparation,
    "id" | "scope" | "context" | "issuedAt" | "expiresAt"
  >,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "browser-task-preparation:v1",
      p.id,
      p.scope,
      p.context,
      p.issuedAt,
      p.expiresAt,
    ]),
  );

/** Validate the complete wire payload before consuming an operation or sequence. */
export function browserTaskBytes(raw: unknown) {
  const parsed = privateTaskPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new BrowserOutboxError("DENIED");
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.byteLength > privateEnvelopeLimit) {
    bytes.fill(0);
    throw new BrowserOutboxError("CAPACITY");
  }
  return bytes;
}
export async function prepareBrowserTask(
  id: string,
  scope: string,
  context: BrowserDeliveryContext,
  raw: unknown,
  issuedAt: number,
  expiresAt: number,
): Promise<BrowserTaskPreparation> {
  const bytes = browserTaskBytes(raw);
  try {
    const retained = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
      iv = crypto.getRandomValues(new Uint8Array(12)),
      base = {
        id,
        scope,
        context: structuredClone(context),
        issuedAt,
        expiresAt,
      },
      ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(base), tagLength: 128 },
        retained,
        bytes,
      );
    return schema.parse({
      ...base,
      key: retained,
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    });
  } finally {
    bytes.fill(0);
  }
}
/** Internal records only: retained CryptoKeys must never enter page APIs/exports. */
export function readBrowserTaskPreparation(
  raw: unknown,
  entry: BrowserOutboxEntry,
) {
  try {
    const p = schema.parse(raw);
    key(p.key);
    const bytes = decode(p.ciphertext);
    if (
      bytes.length < 17 ||
      bytes.length > privateEnvelopeLimit + 16 ||
      p.id !== entry.id ||
      p.scope !== entry.scope ||
      !same(p.context, entry.context) ||
      p.issuedAt !== entry.header.issuedAt ||
      p.expiresAt !== entry.header.expiresAt
    )
      throw Error();
    return p;
  } catch {
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  }
}
export async function openBrowserTaskPreparation(p: BrowserTaskPreparation) {
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(p.iv),
        additionalData: aad(p),
        tagLength: 128,
      },
      key(p.key),
      decode(p.ciphertext),
    ),
  );
  try {
    if (bytes.length > privateEnvelopeLimit)
      throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
    return privateTaskPayloadSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } finally {
    bytes.fill(0);
  }
}
