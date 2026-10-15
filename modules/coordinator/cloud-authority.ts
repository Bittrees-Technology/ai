import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
export async function cloudAuthority(pool: Pool, token: string, raw: unknown) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Denied");
  const input = z
    .discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("check"),
        audience: z.enum(["mcp", "crm", "mercado", "sync"]),
        scope: z.string().min(1).max(40),
      }),
      z.strictObject({ action: z.enum(["status", "revoke"]) }),
    ])
    .parse(raw);
  const hash = createHash("sha256").update(token).digest("hex");
  if (input.action === "check") {
    const row = (
      await pool.query(
        `UPDATE workflow_credentials c SET last_used_at=now() FROM workflow_authorities a
      WHERE c.authority_id=a.id AND c.token_hash=$1 AND c.audience=$2 AND c.scopes ? $3
      AND a.revoked_at IS NULL AND a.paused_at IS NULL
      AND (NOT a.require_wallet OR (a.signed_at IS NOT NULL AND (a.approval_payload->'credentialHashes') ? c.token_hash AND a.approval_payload->>'deviceId'=a.device_id::text AND a.approval_payload->>'deviceLabel'=a.device_label AND a.approval_payload->>'modelLabel'=a.model_label AND (a.approval_expires_at IS NULL OR a.approval_expires_at>now()) AND a.signed_scopes ? (c.audience || ':' || $3)))
      AND (c.expires_at IS NULL OR c.expires_at>now())
      RETURNING a.id,a.owner_id`,
        [hash, input.audience, input.scope],
      )
    ).rows[0];
    if (!row) throw Error("Denied");
    return { active: true, authorityId: row.id, ownerId: row.owner_id };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (
      await client.query(
        "SELECT id,owner_id,revoked_at,paused_at,require_wallet,signed_at,approval_expires_at FROM workflow_authorities WHERE control_hash=$1 FOR UPDATE",
        [hash],
      )
    ).rows[0];
    if (!row) throw Error("Denied");
    if (input.action === "revoke" && !row.revoked_at) {
      await client.query(
        "UPDATE workflow_authorities SET revoked_at=now() WHERE id=$1",
        [row.id],
      );
      await client.query(
        "INSERT INTO workflow_authority_audit(authority_id,action) VALUES($1,'revoked')",
        [row.id],
      );
    }
    await client.query("COMMIT");
    return {
      authorityId: row.id,
      ownerId: row.owner_id,
      active:
        input.action !== "revoke" &&
        !row.revoked_at &&
        !row.paused_at &&
        (!row.require_wallet ||
          (!!row.signed_at &&
            (!row.approval_expires_at ||
              new Date(row.approval_expires_at).getTime() > Date.now()))),
      paused: !!row.paused_at,
      walletApprovalRequired: row.require_wallet && !row.signed_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
