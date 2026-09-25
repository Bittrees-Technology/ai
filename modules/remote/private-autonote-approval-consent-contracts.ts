import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const autoNotePeerApprovalGrantSchema = z
  .strictObject({
    id: z.uuid(),
    scope: z.literal("autonote:approve-exact-notes"),
    operationId: z.uuid(),
    taskId: z.uuid(),
    taskRevision: positive,
    grantId: z.uuid(),
    sourceApprovalId: z.uuid(),
    reviewId: z.uuid(),
    proposalDigest: hash,
    detailHash: hash,
    approvedAt: positive,
    expiresAt: positive,
    revoked: z.boolean(),
    local: z.strictObject({
      revision: positive,
      keyId: z.uuid(),
      keyEpoch: positive,
      binding: privateBindingSchema,
      publicKey: z.string().length(87),
    }),
    peer: z.strictObject({
      revision: positive,
      binding: privateBindingSchema,
      peerId: z.uuid(),
      keyEpoch: positive,
      fingerprint: hash,
    }),
  })
  .refine(
    (g) =>
      JSON.stringify(g.local.binding) === JSON.stringify(g.peer.binding) &&
      g.expiresAt > g.approvedAt &&
      g.expiresAt - g.approvedAt <= 600000 &&
      g.expiresAt <= g.local.binding.expiresAt,
  );
export const autoNotePeerApprovalGrantsSchema = z
  .array(autoNotePeerApprovalGrantSchema)
  .max(64)
  .refine(
    (items) =>
      new Set(items.map((g) => g.id)).size === items.length &&
      new Set(items.map((g) => g.peer.peerId)).size === items.length,
  );
export type AutoNotePeerApprovalGrant = z.infer<
  typeof autoNotePeerApprovalGrantSchema
>;
