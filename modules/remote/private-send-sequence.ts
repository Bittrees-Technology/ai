import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { PrivateHeader } from "./private-envelope.js";

/** Must run inside the caller's short write transaction. Shared by tasks and responses. */
export function reservePrivateSequence(
  store: Store,
  vault: Vault,
  owner: Owner,
  channel: Pick<
    PrivateHeader,
    | "ownerId"
    | "senderId"
    | "recipientId"
    | "senderKeyEpoch"
    | "recipientKeyEpoch"
  >,
) {
  if (!store.db.inTransaction)
    throw Error("PRIVATE_SEQUENCE_TRANSACTION_REQUIRED");
  // Preserve the original v1 task-outbox channel identity and existing counters.
  const hash = vault.fingerprint([
    "private-outbox:v1",
    owner,
    "channel",
    [
      channel.ownerId,
      channel.senderId,
      channel.recipientId,
      channel.senderKeyEpoch,
      channel.recipientKeyEpoch,
    ],
  ]);
  store.db
    .prepare(
      "INSERT OR IGNORE INTO private_send_channels(user_id,tenant_id,channel_hash,next_sequence) VALUES(?,?,?,1)",
    )
    .run(owner.userId, owner.tenantId, hash);
  const row = store.db
    .prepare(
      "UPDATE private_send_channels SET next_sequence=next_sequence+1 WHERE user_id=? AND tenant_id=? AND channel_hash=? AND next_sequence<? RETURNING next_sequence-1 AS sequence",
    )
    .get(owner.userId, owner.tenantId, hash, Number.MAX_SAFE_INTEGER) as
    { sequence: number } | undefined;
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1)
    throw Error("PRIVATE_SEQUENCE_CAPACITY");
  return row.sequence;
}
