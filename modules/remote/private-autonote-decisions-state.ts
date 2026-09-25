import { z } from "zod";
import { autoNotePeerApprovalGrantSchema } from "./private-autonote-approval-consent-contracts.js";
import {
  autoNoteApprovalDecisionSchema,
  autoNoteApprovalManifestSchema,
  autoNoteApprovalReceiptSchema,
} from "./private-autonote-approval-contracts.js";
import { privateEnvelopeSchema } from "./private-envelope.js";
export const autoNoteRetainedDecisionSchema = z
  .strictObject({
    command: autoNoteApprovalDecisionSchema,
    manifest: autoNoteApprovalManifestSchema,
    grant: autoNotePeerApprovalGrantSchema,
    envelope: privateEnvelopeSchema,
    state: z.enum(["accepted", "rejected", "uncertain", "saved"]),
    result: autoNoteApprovalReceiptSchema.nullable(),
  })
  .refine((v) => {
    const c = v.command,
      m = v.manifest,
      g = v.grant,
      h = v.envelope.header;
    return (
      c.id === h.operationId &&
      c.offerId === m.offerId &&
      c.permissionId === g.id &&
      m.permissionId === g.id &&
      m.operationId === g.operationId &&
      m.sourceApprovalId === g.sourceApprovalId &&
      m.grantId === g.grantId &&
      m.reviewId === g.reviewId &&
      c.detailHash === m.detailHash &&
      m.detailHash === g.detailHash &&
      c.proposalDigest === m.proposalDigest &&
      m.proposalDigest === g.proposalDigest &&
      c.issuedAt === h.issuedAt &&
      h.issuedAt >= m.issuedAt &&
      h.expiresAt <= m.expiresAt &&
      m.expiresAt <= g.expiresAt &&
      h.ownerId === g.local.binding.ownerId &&
      h.recipientId === g.local.binding.deviceId &&
      h.senderId === g.peer.peerId &&
      h.recipientKeyEpoch === g.local.keyEpoch &&
      h.senderKeyEpoch === g.peer.keyEpoch &&
      (c.decision === "reject"
        ? v.state === "rejected"
        : v.state !== "rejected") &&
      (v.state === "accepted"
        ? v.result === null
        : !!v.result &&
          v.result.status === v.state &&
          v.result.decisionId === c.id &&
          v.result.offerId === c.offerId &&
          v.result.detailHash === c.detailHash)
    );
  });
export const autoNoteRetainedDecisionsSchema = z
  .array(autoNoteRetainedDecisionSchema)
  .max(64)
  .refine(
    (v) =>
      new Set(v.map((e) => e.command.id)).size === v.length &&
      new Set(v.map((e) => e.command.offerId)).size === v.length,
  );
export type AutoNoteRetainedDecision = z.infer<
  typeof autoNoteRetainedDecisionSchema
>;
