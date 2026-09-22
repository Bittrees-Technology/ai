import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";

import { privateTaskReceiptSchema } from "./private-task-contracts.js";
export {
  privateTaskReceiptSchema,
  type PrivateTaskReceipt,
} from "./private-task-contracts.js";
export const privateReceiptPurpose = (owner: Owner, operationHash: string) =>
  JSON.stringify([
    "private-task-receipt:v1",
    owner.tenantId,
    owner.userId,
    operationHash,
  ]);

/** Local content export only; never a relay projection or an authority grant. */
export function exportPrivateTaskReceipts(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT operation_hash,payload FROM private_task_receipts WHERE user_id=? AND tenant_id=? ORDER BY operation_hash LIMIT 1025",
    )
    .all(owner.userId, owner.tenantId) as {
    operation_hash: string;
    payload: Buffer;
  }[];
  if (rows.length > 1024) throw Error("PRIVATE_RECEIPT_STORAGE_UNAVAILABLE");
  return rows.map((row) =>
    privateTaskReceiptSchema.parse(
      vault.open(row.payload, privateReceiptPurpose(owner, row.operation_hash)),
    ),
  );
}
