import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { PrivateEnvelope } from "./private-envelope.js";
import { privateRelayStorageReceiptSchema } from "./private-relay-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.strictObject({
  envelopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: privateRelayStorageReceiptSchema,
  observedAt: positive,
  attempt: positive,
});
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-response-delivery:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
const fingerprint = (vault: Vault, owner: Owner, envelope: PrivateEnvelope) =>
  vault.fingerprint(["private-response-delivery:v1", owner, envelope]);

/** Historical transport evidence only. Never grants authority or proves a browser read. */
export function readResponseDelivery(
  store: Store,
  vault: Vault,
  owner: Owner,
  id: string,
  envelope: PrivateEnvelope | null,
  attempts: number,
) {
  const row = store.db
    .prepare(
      "SELECT payload FROM private_response_delivery WHERE user_id=? AND tenant_id=? AND response_id=?",
    )
    .get(owner.userId, owner.tenantId, id) as { payload: Buffer } | undefined;
  if (!row) return null;
  if (!envelope || row.payload.length > 4096)
    throw Error("INVALID_DELIVERY_HISTORY");
  const value = recordSchema.parse(vault.open(row.payload, purpose(owner, id)));
  if (
    value.envelopeFingerprint !== fingerprint(vault, owner, envelope) ||
    value.receipt.messageId !== envelope.header.messageId ||
    value.attempt > attempts
  )
    throw Error("INVALID_DELIVERY_HISTORY");
  return value;
}

/** Called synchronously inside the response's exact-revision transaction after
 * authenticated transport and envelope-hash validation. No network or authority here. */
export function saveResponseDelivery(
  store: Store,
  vault: Vault,
  owner: Owner,
  id: string,
  envelope: PrivateEnvelope,
  attempts: number,
  rawReceipt: unknown,
  now: number,
) {
  const receipt = privateRelayStorageReceiptSchema.parse(rawReceipt);
  const previous = readResponseDelivery(
    store,
    vault,
    owner,
    id,
    envelope,
    attempts,
  );
  if (previous) {
    const old = previous.receipt,
      rank = { stored: 0, received: 1, deleted: 2 };
    if (
      receipt.storedAt !== old.storedAt ||
      receipt.envelopeHash !== old.envelopeHash ||
      receipt.revision < old.revision ||
      rank[receipt.state] < rank[old.state] ||
      (receipt.revision === old.revision &&
        JSON.stringify(receipt) !== JSON.stringify(old))
    )
      throw Error("INVALID_DELIVERY_HISTORY");
  }
  const value = recordSchema.parse({
    envelopeFingerprint: fingerprint(vault, owner, envelope),
    receipt,
    observedAt: now,
    attempt: attempts,
  });
  store.db
    .prepare(
      "INSERT INTO private_response_delivery VALUES(?,?,?,?) ON CONFLICT(user_id,tenant_id,response_id) DO UPDATE SET payload=excluded.payload",
    )
    .run(
      owner.userId,
      owner.tenantId,
      id,
      vault.seal(value, purpose(owner, id)),
    );
  return value;
}
