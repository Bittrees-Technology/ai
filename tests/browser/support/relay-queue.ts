import type { Pool } from "pg";
import { privateRelayEnvelopeHash } from "../../../modules/remote/private-relay-contracts.js";
// A syntactically valid but cryptographically invalid envelope can occupy a relay
// slot. Keep its wire hash consistent so endpoint authentication is what rejects it.
export async function corrupt(pool: Pool, id: string) {
  const row = (
    await pool.query(
      "SELECT envelope FROM remote_private_messages WHERE message_id=$1",
      [id],
    )
  ).rows[0];
  const envelope = row.envelope;
  envelope.ciphertext =
    (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  await pool.query(
    "UPDATE remote_private_messages SET envelope=$2,envelope_hash=$3,stored_at=stored_at-1 WHERE message_id=$1",
    [id, envelope, await privateRelayEnvelopeHash(envelope)],
  );
}
export async function stored(pool: Pool, id: string) {
  return (
    await pool.query(
      "SELECT state,received_at,deleted_at FROM remote_private_messages WHERE message_id=$1",
      [id],
    )
  ).rows[0];
}
