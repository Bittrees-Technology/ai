import { z } from "zod";
import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  classifyPrivateReplay,
  privateReplayIdentitySchema,
} from "./private-replay.js";

export const privateIncomingReplayLimit = 4096;
const outcomeSchema = z.strictObject({
  collection: z.enum([
    "private_task_receipts",
    "remote_resume_receipts",
    "private_task_outbox",
    "private_peer_checks",
    "messages",
    "private_conversation_consents",
  ]),
  id: z.uuid(),
});
const recordSchema = z.strictObject({
  identity: privateReplayIdentitySchema,
  outcome: outcomeSchema,
});
type Record = z.infer<typeof recordSchema>;
type Row = {
  operation_hash: string;
  message_hash: string;
  sequence_hash: string;
  payload: Buffer;
};
export class PrivateIncomingReplayError extends Error {
  constructor(readonly code: "CONFLICT" | "STORAGE_UNAVAILABLE" | "CAPACITY") {
    super(code);
  }
}
const purpose = (owner: Owner, operation: string) =>
  JSON.stringify([
    "private-incoming-replay:v1",
    owner.tenantId,
    owner.userId,
    operation,
  ]);
function read(vault: Vault, owner: Owner, row: Row): Record {
  try {
    if (!Buffer.isBuffer(row.payload) || row.payload.length > 4096)
      throw Error();
    const value = recordSchema.parse(
      vault.open(row.payload, purpose(owner, row.operation_hash)),
    );
    if (
      value.identity.operation !== row.operation_hash ||
      value.identity.message !== row.message_hash ||
      value.identity.sequence !== row.sequence_hash
    )
      throw Error();
    return value;
  } catch {
    throw new PrivateIncomingReplayError("STORAGE_UNAVAILABLE");
  }
}

/** Called only inside the SAME write transaction as fresh authority checks,
 * existing Inbox/task/check effects and their durable outcome. It intentionally
 * opens no independent transaction. Async cryptography belongs before that lock.
 * A returned duplicate is not permission to repeat the associated effect.
 * Existing receivers are wired separately; an empty new ledger is not evidence
 * that historical messages were never accepted by older family-specific stores.
 */
export function consumePrivateIncomingReplay(
  store: Store,
  vault: Vault,
  owner: Owner,
  rawIdentity: unknown,
  rawOutcome: unknown,
): "new" | "duplicate" {
  if (!store.db.inTransaction)
    throw new PrivateIncomingReplayError("STORAGE_UNAVAILABLE");
  const value = recordSchema.parse({
    identity: rawIdentity,
    outcome: rawOutcome,
  });
  const rows = store.db
    .prepare(
      "SELECT operation_hash,message_hash,sequence_hash,payload FROM private_incoming_replay WHERE user_id=? AND tenant_id=? AND (operation_hash=? OR message_hash=? OR sequence_hash=?) LIMIT 4",
    )
    .all(
      owner.userId,
      owner.tenantId,
      value.identity.operation,
      value.identity.message,
      value.identity.sequence,
    ) as Row[];
  const previous = rows.map((row) => read(vault, owner, row)),
    decision = classifyPrivateReplay(
      value.identity,
      previous.map((r) => r.identity),
    );
  if (decision === "duplicate") {
    if (
      previous[0]!.outcome.collection !== value.outcome.collection ||
      previous[0]!.outcome.id !== value.outcome.id
    )
      throw new PrivateIncomingReplayError("CONFLICT");
    return decision;
  }
  const { count } = store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM private_incoming_replay WHERE user_id=? AND tenant_id=?",
    )
    .get(owner.userId, owner.tenantId) as { count: number };
  if (count >= privateIncomingReplayLimit)
    throw new PrivateIncomingReplayError("CAPACITY");
  store.db
    .prepare(
      "INSERT INTO private_incoming_replay(user_id,tenant_id,operation_hash,message_hash,sequence_hash,payload) VALUES(?,?,?,?,?,?)",
    )
    .run(
      owner.userId,
      owner.tenantId,
      value.identity.operation,
      value.identity.message,
      value.identity.sequence,
      vault.seal(value, purpose(owner, value.identity.operation)),
    );
  return decision;
}

export function exportPrivateIncomingReplay(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT operation_hash,message_hash,sequence_hash,payload FROM private_incoming_replay WHERE user_id=? AND tenant_id=? ORDER BY operation_hash LIMIT ?",
    )
    .all(owner.userId, owner.tenantId, privateIncomingReplayLimit + 1) as Row[];
  if (rows.length > privateIncomingReplayLimit)
    throw new PrivateIncomingReplayError("CAPACITY");
  return rows.map((row) => read(vault, owner, row));
}
