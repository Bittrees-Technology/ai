import { z } from "zod";
import { autoNotePeerApprovalGrantSchema } from "./private-autonote-approval-consent-contracts.js";
import {
  autoNoteApprovalManifestSchema,
  autoNoteApprovalChunkSchema,
} from "./private-autonote-approval-contracts.js";
import {
  privateHeaderSchema,
  privateEnvelopeSchema,
} from "./private-envelope.js";
import { privateRelayStorageReceiptSchema } from "./private-relay-contracts.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const autoNoteApprovalOutboxSchema = z
  .strictObject({
    id: z.uuid(),
    clientRequestId: z.uuid(),
    requestRevision: positive,
    grant: autoNotePeerApprovalGrantSchema,
    manifest: autoNoteApprovalManifestSchema,
    state: z.enum(["preparing", "ready", "stopped"]),
    parts: z
      .array(
        z.strictObject({
          header: privateHeaderSchema,
          packet: z
            .union([
              autoNoteApprovalManifestSchema,
              autoNoteApprovalChunkSchema,
            ])
            .nullable(),
          envelope: privateEnvelopeSchema.nullable(),
          attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          lastAttemptAt: positive.nullable(),
          receipt: privateRelayStorageReceiptSchema.nullable(),
        }),
      )
      .min(2)
      .max(124),
  })
  .refine(
    (v) =>
      v.id === v.manifest.offerId &&
      v.manifest.permissionId === v.grant.id &&
      v.manifest.sourceApprovalId === v.grant.sourceApprovalId &&
      v.manifest.grantId === v.grant.grantId &&
      v.manifest.operationId === v.grant.operationId &&
      v.manifest.reviewId === v.grant.reviewId &&
      v.manifest.proposalDigest === v.grant.proposalDigest &&
      v.manifest.detailHash === v.grant.detailHash &&
      v.manifest.expiresAt <= v.grant.expiresAt &&
      v.parts.length === v.manifest.chunkCount + 1 &&
      new Set(v.parts.map((p) => p.header.messageId)).size === v.parts.length &&
      new Set(v.parts.map((p) => p.header.operationId)).size ===
        v.parts.length &&
      new Set(v.parts.map((p) => p.header.sequence)).size === v.parts.length &&
      v.parts.every(
        (p, i) =>
          !!p.packet !== !!p.envelope &&
          (v.state !== "ready" || !!p.envelope) &&
          (i !== 0 || p.header.operationId === v.id) &&
          p.header.ownerId === v.grant.local.binding.ownerId &&
          p.header.senderId === v.grant.local.binding.deviceId &&
          p.header.recipientId === v.grant.peer.peerId &&
          p.header.senderKeyEpoch === v.grant.local.keyEpoch &&
          p.header.recipientKeyEpoch === v.grant.peer.keyEpoch &&
          p.header.issuedAt === v.manifest.issuedAt &&
          p.header.expiresAt === v.manifest.expiresAt &&
          (!p.envelope || same(p.envelope.header, p.header)) &&
          (!p.packet ||
            (i === 0
              ? p.packet.type === "autonote.approval.offer" &&
                same(p.packet, v.manifest) &&
                p.header.operationId === v.id
              : p.packet.type === "autonote.approval.chunk" &&
                p.packet.index === i - 1 &&
                p.packet.offerId === v.id &&
                p.packet.detailHash === v.manifest.detailHash &&
                p.packet.id === p.header.operationId)) &&
          (p.attempts === 0
            ? p.lastAttemptAt === null && p.receipt === null
            : !!p.envelope && p.lastAttemptAt !== null) &&
          (!p.receipt || p.receipt.messageId === p.header.messageId),
      ),
  );
export const autoNoteApprovalOutboxesSchema = z
  .array(autoNoteApprovalOutboxSchema)
  .max(4)
  .refine(
    (v) =>
      new Set(v.map((x) => x.id)).size === v.length &&
      new Set(v.map((x) => x.clientRequestId)).size === v.length,
  );
export type AutoNoteApprovalOutbox = z.infer<
  typeof autoNoteApprovalOutboxSchema
>;
