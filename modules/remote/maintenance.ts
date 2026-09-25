import type { Pool, PoolClient } from "pg";
import { RemoteStatusError } from "./status-store.js";
/** One bounded transaction. Uses stored deadlines and an optional explicitly selected history policy; no default history deletion. */
export async function cleanupRemote(
  pool: Pool,
  batchSize: number,
  cutoff = Date.now(),
  historyRetentionDays?: 90,
) {
  if (
    (historyRetentionDays !== undefined && historyRetentionDays !== 90) ||
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
      ["templateCommands", "remote_template_commands", ["id"], "purge_at"],
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
    // Optional, explicitly selected policy for history that previously had no purge deadline.
    // Preserve live authority and retained dependencies; deletion must not cascade over a batch limit.
    if (historyRetentionDays === 90) {
      const threshold = cutoff - 90 * 86400000;
      for (const [name, table, deadline, dependencies] of [
        [
          "mcpDelegations",
          "remote_mcp_delegations",
          "GREATEST(COALESCE(t.expires_at,t.request_expires_at),COALESCE(t.revoked_at,t.request_expires_at))",
          "NOT EXISTS(SELECT 1 FROM remote_mcp_dispatches d WHERE d.delegation_id=t.id)",
        ],
        [
          "relayGrants",
          "remote_private_relay_grants",
          "GREATEST(t.expires_at,COALESCE(t.revoked_at,t.expires_at))",
          "true",
        ],
        [
          "browserDevices",
          "remote_browser_devices",
          "GREATEST(t.expires_at,COALESCE(t.revoked_at,t.expires_at))",
          "NOT EXISTS(SELECT 1 FROM remote_private_relay_grants g WHERE g.endpoint_kind='browser' AND g.endpoint_id=t.id)",
        ],
      ] as const) {
        const result = await db.query(
          `WITH expired AS (SELECT t.id FROM ${table} t
           WHERE ${deadline}<=$1 AND ${dependencies}
           ORDER BY ${deadline},t.id LIMIT $2 FOR UPDATE OF t SKIP LOCKED)
           DELETE FROM ${table} target USING expired WHERE target.id=expired.id`,
          [threshold, batchSize],
        );
        counts[name] = result.rowCount ?? 0;
      }
    }
    const templates = await db.query(
      `WITH expired AS (
      SELECT permission_id FROM remote_templates t WHERE purge_at<=$1
      AND NOT EXISTS(SELECT 1 FROM remote_template_commands c WHERE c.permission_id=t.permission_id)
      AND NOT EXISTS(SELECT 1 FROM remote_mcp_delegations d WHERE d.permission_id=t.permission_id)
      ORDER BY purge_at,permission_id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM remote_templates t USING expired WHERE t.permission_id=expired.permission_id`,
      [cutoff, batchSize],
    );
    counts.templates = templates.rowCount ?? 0;
    const templateCredentials = await db.query(
      `WITH expired AS (
      SELECT t.permission_id FROM remote_templates t JOIN remote_devices d ON d.id=t.device_id
      WHERE t.credential_hash IS NOT NULL AND (t.expires_at<=$1 OR t.revoked_at IS NOT NULL OR d.revoked_at IS NOT NULL OR d.expires_at<=$1 OR t.device_epoch<>d.epoch)
      ORDER BY t.expires_at,t.permission_id LIMIT $2 FOR UPDATE OF t SKIP LOCKED
    ) UPDATE remote_templates t SET credential_hash=NULL FROM expired WHERE t.permission_id=expired.permission_id`,
      [cutoff, batchSize],
    );
    counts.templateCredentials = templateCredentials.rowCount ?? 0;
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
    if (historyRetentionDays === 90) {
      const devices = await db.query(
        `WITH expired AS (SELECT d.id FROM remote_devices d
         WHERE GREATEST(d.expires_at,COALESCE(d.revoked_at,d.expires_at))<=$1
         AND NOT EXISTS(SELECT 1 FROM remote_status s WHERE s.device_id=d.id)
         AND NOT EXISTS(SELECT 1 FROM remote_commands c WHERE c.device_id=d.id)
         AND NOT EXISTS(SELECT 1 FROM remote_templates t WHERE t.device_id=d.id)
         AND NOT EXISTS(SELECT 1 FROM remote_private_relay_grants g WHERE g.endpoint_kind='mac' AND g.endpoint_id=d.id)
         ORDER BY GREATEST(d.expires_at,COALESCE(d.revoked_at,d.expires_at)),d.id
         LIMIT $2 FOR UPDATE OF d SKIP LOCKED)
         DELETE FROM remote_devices target USING expired WHERE target.id=expired.id`,
        [cutoff - 90 * 86400000, batchSize],
      );
      counts.deviceHistory = devices.rowCount ?? 0;
    }
    await db.query("COMMIT");
    return { cutoff, batchSize, counts };
  } catch (error) {
    if (db) await db.query("ROLLBACK").catch(() => {});
    throw new RemoteStatusError("UNAVAILABLE");
  } finally {
    db?.release();
  }
}
