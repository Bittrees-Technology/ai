import { z } from "zod";
import {
  privateRelayPageSchema,
  privateRelayStorageReceiptSchema,
} from "./private-relay-contracts.js";
import type { PrivateRelayClient } from "./private-relay-client.js";
/** A reviewed transport item is not authenticated task content or execution authority. */
export const privateRelaySelectionSchema =
  privateRelayStorageReceiptSchema.pick({
    messageId: true,
    envelopeHash: true,
    revision: true,
    storedAt: true,
  });
export const privateRelayQueueQuerySchema = z.strictObject({
  after: privateRelayPageSchema.shape.after,
  confirmed: z.literal(true),
});
type Item = Awaited<ReturnType<PrivateRelayClient["poll"]>>["items"][number];
function select(item: Item) {
  const { messageId, envelopeHash, revision, storedAt } = item.receipt;
  return privateRelaySelectionSchema.parse({
    messageId,
    envelopeHash,
    revision,
    storedAt,
  });
}
export function relayQueueReview(item: Item | undefined) {
  return item
    ? {
        selection: select(item),
        cursor: {
          storedAt: item.receipt.storedAt,
          messageId: item.receipt.messageId,
        },
        expiresAt: item.envelope.header.expiresAt,
      }
    : null;
}
/** An optional exact selection fences a changed queue head before any decryption,
 * admission or acknowledgement. Absence preserves the original one-task check. */
export function relaySelectionMatches(
  item: Item | undefined,
  selection: z.infer<typeof privateRelaySelectionSchema> | undefined,
) {
  return (
    !selection ||
    (!!item &&
      JSON.stringify(select(item)) ===
        JSON.stringify(privateRelaySelectionSchema.parse(selection)))
  );
}
