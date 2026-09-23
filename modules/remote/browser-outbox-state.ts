import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
} from "./private-envelope.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
export const browserDeliveryContextSchema = z.strictObject({
  binding: privateBindingSchema,
  senderKeyEpoch: positive,
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  peerRevision: positive,
  peerFingerprint: hex,
  permissionRevision: positive,
  sendingEnabled: z.literal(true),
});
export type BrowserDeliveryContext = z.infer<
  typeof browserDeliveryContextSchema
>;
export const browserOutboxMetaSchema = z.strictObject({
  scope: hex,
  deviceHash: hex,
  revision: positive,
  locked: z.boolean(),
});
export const browserOutboxEntrySchema = z
  .strictObject({
    id: z.uuid(),
    scope: hex,
    revision: positive,
    context: browserDeliveryContextSchema,
    header: privateHeaderSchema,
    state: z.enum(["reserved", "pending", "stopped", "accepted"]),
    envelope: privateEnvelopeSchema.nullable(),
    receiptEnvelope: privateEnvelopeSchema.nullable().default(null),
    receiptHash: hex.nullable().default(null),
    resultEnvelope: privateEnvelopeSchema.nullable().default(null),
    resultHash: hex.nullable().default(null),
    resultReceivedAt: positive.nullable().default(null),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (e) =>
      (e.state === "accepted") === !!e.receiptHash &&
      !!e.receiptHash === (!!e.receiptEnvelope || !!e.resultEnvelope) &&
      !!e.resultEnvelope === !!e.resultHash &&
      !!e.resultEnvelope === !!e.resultReceivedAt &&
      [e.receiptEnvelope, e.resultEnvelope].every(
        (response) =>
          !response ||
          (!!e.envelope &&
            response.header.ownerId === e.header.ownerId &&
            response.header.operationId === e.header.operationId &&
            response.header.senderId === e.header.recipientId &&
            response.header.recipientId === e.header.senderId &&
            response.header.senderKeyEpoch === e.header.recipientKeyEpoch &&
            response.header.recipientKeyEpoch === e.header.senderKeyEpoch),
      ) &&
      (!e.resultEnvelope ||
        (e.resultReceivedAt! < e.resultEnvelope.header.expiresAt &&
          e.resultReceivedAt! >= e.resultEnvelope.header.issuedAt - 30000)) &&
      e.id === e.header.operationId &&
      e.header.ownerId === e.context.binding.ownerId &&
      e.header.senderId === e.context.binding.deviceId &&
      e.header.recipientId === e.context.peerId &&
      e.header.senderKeyEpoch === e.context.senderKeyEpoch &&
      e.header.recipientKeyEpoch === e.context.peerKeyEpoch &&
      e.header.senderId !== e.header.recipientId &&
      (e.state !== "pending" || !!e.envelope) &&
      (e.state !== "reserved" || !e.envelope) &&
      (!e.envelope ||
        JSON.stringify(e.header) === JSON.stringify(e.envelope.header)),
  );
export type BrowserOutboxEntry = z.infer<typeof browserOutboxEntrySchema>;
export type BrowserOutboxMeta = z.infer<typeof browserOutboxMetaSchema>;
export class BrowserOutboxError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "CAPACITY"
      | "SETUP_REQUIRED"
      | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}

export const browserOutboxChannelSchema = z.strictObject({
  scope: hex,
  channel: hex,
  next: positive,
});
export async function browserPrivateDigest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function browserPrivateIdentity(
  binding: import("./private-peer-contracts.js").PrivateBinding,
) {
  const [scope, deviceHash] = await Promise.all([
    browserPrivateDigest(["browser-owner:v1", binding.ownerId]),
    browserPrivateDigest([
      "browser-device:v1",
      binding.ownerId,
      binding.deviceId,
    ]),
  ]);
  return { scope, deviceHash, binding };
}
export function browserPrivateChannel(
  identity: { scope: string; deviceHash: string },
  route: { senderKeyEpoch: number; peerId: string; peerKeyEpoch: number },
) {
  return browserPrivateDigest([
    "browser-channel:v1",
    identity.scope,
    identity.deviceHash,
    route.senderKeyEpoch,
    route.peerId,
    route.peerKeyEpoch,
  ]);
}
export type BrowserSequenceIO = {
  store(name: string): IDBObjectStore;
  request<R>(request: IDBRequest<R>, done: (value: R) => void): void;
};
/** The caller owns the write transaction and guards every callback against stale
 * authority. All checks/tasks/responses consume this same durable channel. */
export function reserveBrowserSequence(
  io: BrowserSequenceIO,
  scope: string,
  channel: string,
  done: (sequence: number) => void,
) {
  hex.parse(scope);
  hex.parse(channel);
  io.request(io.store("channels").get([scope, channel]), (raw) => {
    const previous =
      raw === undefined
        ? { scope, channel, next: 1 }
        : browserOutboxChannelSchema.parse(raw);
    if (
      previous.scope !== scope ||
      previous.channel !== channel ||
      previous.next >= Number.MAX_SAFE_INTEGER
    )
      throw new BrowserOutboxError("CAPACITY");
    const save = () => {
      const sequence = previous.next++;
      io.store("channels").put(previous);
      done(sequence);
    };
    if (raw !== undefined) save();
    else
      io.request(io.store("channels").index("scope").count(scope), (count) => {
        if (count >= 1024) throw new BrowserOutboxError("CAPACITY");
        save();
      });
  });
}
