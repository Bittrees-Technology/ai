import type { Pool, PoolClient } from "pg";
import { RemoteStatusError } from "./status-store.js";
/** One bounded transaction. Uses stored deadlines; never chooses or extends a retention policy. */
export async function cleanupRemote(
  pool: Pool,
  batchSize: number,
  cutoff = Date.now(),
) {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isSafeInteger(cutoff) ||
    cutoff <= 0
  )
    throw new RemoteStatusError("INVALID_INPUT");
  let db: PoolClient | undefined;
  try {
    db = await pool.connect();
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query("SET LOCAL lock_timeout = '1s'");
    const counts: Record<string, number> = {};
    // The table/key/expiry identifiers are fixed application constants, never caller input.
    for (const [name, table, keys, deadline] of [
      ["statuses", "remote_status", ["device_id", "id"], "expires_at"],
      ["pairings", "remote_pairings", ["id"], "expires_at"],
      ["loginChallenges", "remote_login_challenges", ["id"], "expires_at"],
      ["sessions", "remote_sessions", ["token_hash"], "expires_at"],
      ["commands", "remote_commands", ["id"], "purge_at"],
    ] as const) {
      const result = await db.query(
        `WITH expired AS (
        SELECT ${keys.join(",")} FROM ${table} WHERE ${deadline}<=$1
        ORDER BY ${deadline},${keys.join(",")} LIMIT $2 FOR UPDATE SKIP LOCKED
      ) DELETE FROM ${table} AS target USING expired
        WHERE ${keys.map((key) => `target.${key}=expired.${key}`).join(" AND ")}`,
        [cutoff, batchSize],
      );
      counts[name] = result.rowCount ?? 0;
    }
    const credentials = await db.query(
      `WITH expired AS (
      SELECT id FROM remote_devices WHERE (expires_at<=$1 OR revoked_at IS NOT NULL)
      AND (credential_hash IS NOT NULL OR control_credential_hash IS NOT NULL OR control_id IS NOT NULL OR controls_enabled OR controls_approved_epoch IS NOT NULL OR controls_approval_expires_at IS NOT NULL)
      ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE remote_devices AS target SET credential_hash=NULL,control_credential_hash=NULL,control_id=NULL,controls_enabled=false,controls_approved_epoch=NULL,controls_approval_expires_at=NULL
      FROM expired WHERE target.id=expired.id`,
      [cutoff, batchSize],
    );
    counts.deviceCredentials = credentials.rowCount ?? 0;
    const approvals = await db.query(
      `WITH expired AS (
      SELECT id FROM remote_devices WHERE controls_approval_expires_at<=$1
      ORDER BY controls_approval_expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE remote_devices AS target SET controls_approved_epoch=NULL,controls_approval_expires_at=NULL
      FROM expired WHERE target.id=expired.id`,
      [cutoff, batchSize],
    );
    counts.controlApprovals = approvals.rowCount ?? 0;
    await db.query("COMMIT");
    return { cutoff, batchSize, counts };
  } catch (error) {
    if (db) await db.query("ROLLBACK").catch(() => {});
    throw new RemoteStatusError("UNAVAILABLE");
  } finally {
    db?.release();
  }
}
