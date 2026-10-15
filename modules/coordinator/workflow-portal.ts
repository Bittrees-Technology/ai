import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { SiweMessage } from "siwe";
import type { Pool } from "pg";
import { z } from "zod";
export const workflowOrigin = "https://ai.bittrees.org";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("hex");
const address = z.string().transform((v) => getAddress(v).toLowerCase());
const uuid = z.uuid();
const consentScopes = async (db: any, id: string): Promise<string[]> =>
  (
    await db.query(
      "SELECT DISTINCT c.audience || ':' || s.value AS scope FROM workflow_credentials c CROSS JOIN LATERAL jsonb_array_elements_text(c.scopes) s(value) WHERE c.authority_id=$1 AND (c.expires_at IS NULL OR c.expires_at>now()) ORDER BY scope",
      [id],
    )
  ).rows.map((r: any) => r.scope);
export async function rateLimit(pool: Pool, key: string, max = 40) {
  const r = (
    await pool.query(
      "INSERT INTO workflow_portal_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN workflow_portal_limits.window_at<now()-interval '10 minutes' THEN 1 ELSE workflow_portal_limits.hits+1 END, window_at=CASE WHEN workflow_portal_limits.window_at<now()-interval '10 minutes' THEN now() ELSE workflow_portal_limits.window_at END RETURNING hits",
      [hash(key)],
    )
  ).rows[0];
  if (r.hits > max) throw Error("RATE_LIMITED");
}
export async function walletSession(pool: Pool, session: string) {
  if (!/^[a-f0-9]{64}$/.test(session)) throw Error("SIGN_IN_REQUIRED");
  const row = (
    await pool.query(
      "SELECT wallet FROM workflow_wallet_sessions WHERE token_hash=$1 AND expires_at>now()",
      [hash(session)],
    )
  ).rows[0];
  if (!row) throw Error("SIGN_IN_REQUIRED");
  return row.wallet as string;
}
export async function portalList(pool: Pool, wallet: string) {
  const grants = (
    await pool.query(
      "SELECT id,owner_id,wallet_address,device_id,device_label,model_label,last_seen_at,paused_at,revoked_at,require_wallet,signed_at,approval_expires_at,signed_scopes,created_at FROM workflow_authorities WHERE wallet_address=$1 ORDER BY created_at DESC LIMIT 100",
      [wallet],
    )
  ).rows;
  for (const g of grants) {
    g.scopes = await consentScopes(pool, g.id);
    g.activity = (
      await pool.query(
        "SELECT action,created_at FROM workflow_authority_audit WHERE authority_id=$1 ORDER BY id DESC LIMIT 25",
        [g.id],
      )
    ).rows;
    g.runs = (
      await pool.query(
        "SELECT run_id,counts,outcomes,updated_at FROM marketplace_status WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 30",
        [g.owner_id],
      )
    ).rows;
  }
  return { wallet, grants };
}
export async function challenge(
  pool: Pool,
  browser: string,
  raw: unknown,
  sessionWallet?: string,
) {
  const v = z
    .strictObject({
      action: z.enum(["login", "approve"]),
      wallet: address,
      authorityId: uuid.optional(),
      duration: z.enum(["day", "month", "until-revoked"]).optional(),
      pairCode: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
    })
    .parse(raw);
  let payload: any = { action: v.action };
  let statement =
    "Sign in to view your Bittrees AI workflows. Signing in does not delegate permissions.";
  if (v.action === "approve") {
    if (sessionWallet !== v.wallet || !v.authorityId || !v.duration)
      throw Error("SIGN_IN_REQUIRED");
    const g = (
      await pool.query(
        "SELECT * FROM workflow_authorities WHERE id=$1 AND revoked_at IS NULL",
        [v.authorityId],
      )
    ).rows[0];
    if (!g || !g.device_id) throw Error("WORKFLOW_UNAVAILABLE");
    const pairing =
      !g.wallet_address &&
      v.pairCode &&
      g.pair_hash === hash(v.pairCode) &&
      new Date(g.pair_expires_at).getTime() > Date.now();
    if (g.wallet_address !== v.wallet && !pairing)
      throw Error("WORKFLOW_UNAVAILABLE");
    const scopes = await consentScopes(pool, g.id);
    const credentialHashes = (
      await pool.query(
        "SELECT token_hash FROM workflow_credentials WHERE authority_id=$1 AND (expires_at IS NULL OR expires_at>now()) ORDER BY token_hash",
        [g.id],
      )
    ).rows.map((r) => r.token_hash);
    payload = {
      action: "approve",
      authorityId: g.id,
      ownerId: g.owner_id,
      wallet: v.wallet,
      deviceId: g.device_id,
      deviceLabel: g.device_label,
      modelLabel: g.model_label,
      scopes,
      credentialHashes,
      policy: "mercado-qualified-v1",
      scheduleHours: 6,
      maxOffers: 20,
      expiresAt:
        v.duration === "until-revoked"
          ? null
          : new Date(
              Date.now() + (v.duration === "day" ? 1 : 30) * 86400000,
            ).toISOString(),
      pairHash: pairing ? g.pair_hash : null,
    };
    statement = `Approve Bittrees AI on ${g.device_label} (${g.device_id}). Workflow: supplier research, qualified Mercado publication and CRM vendor/tasks only where connected. Engine: ${g.model_label}. Planned research schedule: every 6 hours, up to 20 offers; hold exceptions. Permissions: ${scopes.join(", ") || "No connected app permissions; device registration only"}. Duration: ${payload.expiresAt || "until revoked"}. No wallet transactions, spending or outreach. Pause or revoke at ai.bittrees.org/workflows.`;
  }
  const id = randomUUID(),
    nonce = randomBytes(16).toString("hex");
  const message = new SiweMessage({
    domain: "ai.bittrees.org",
    address: getAddress(v.wallet),
    statement,
    uri: workflowOrigin + "/workflows",
    version: "1",
    chainId: 1,
    nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60000).toISOString(),
    resources: [
      `urn:bittrees:workflow-consent:${hash(JSON.stringify(payload))}`,
    ],
  }).prepareMessage();
  await pool.query(
    "INSERT INTO workflow_wallet_challenges VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",
    [id, hash(browser), v.wallet, message, JSON.stringify(payload)],
  );
  return { id, message, details: payload };
}
export async function verifyChallenge(
  pool: Pool,
  browser: string,
  raw: unknown,
  sessionWallet?: string,
) {
  const v = z
    .strictObject({
      id: uuid,
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    })
    .parse(raw);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const c = (
      await db.query(
        "DELETE FROM workflow_wallet_challenges WHERE id=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *",
        [v.id, hash(browser)],
      )
    ).rows[0];
    if (!c) throw Error("CHALLENGE_EXPIRED");
    if (verifyMessage(c.message, v.signature).toLowerCase() !== c.wallet)
      throw Error("INVALID_SIGNATURE");
    const p = c.payload;
    if (p.action === "login") {
      const session = token();
      await db.query(
        "INSERT INTO workflow_wallet_sessions VALUES($1,$2,now()+interval '8 hours')",
        [hash(session), c.wallet],
      );
      await db.query("COMMIT");
      return { session, wallet: c.wallet };
    }
    if (sessionWallet !== c.wallet) throw Error("SIGN_IN_REQUIRED");
    const g = (
      await db.query(
        "SELECT * FROM workflow_authorities WHERE id=$1 AND revoked_at IS NULL FOR UPDATE",
        [p.authorityId],
      )
    ).rows[0];
    if (
      !g ||
      g.device_id !== p.deviceId ||
      g.device_label !== p.deviceLabel ||
      g.model_label !== p.modelLabel ||
      JSON.stringify(await consentScopes(db, g.id)) !== JSON.stringify(p.scopes)
    )
      throw Error("PERMISSIONS_CHANGED");
    if (
      g.wallet_address !== c.wallet &&
      !(
        g.wallet_address === null &&
        p.pairHash &&
        g.pair_hash === p.pairHash &&
        new Date(g.pair_expires_at).getTime() > Date.now()
      )
    )
      throw Error("WORKFLOW_UNAVAILABLE");
    await db.query(
      "UPDATE workflow_authorities SET wallet_address=$2,require_wallet=true,signed_at=now(),signed_scopes=$3,approval_expires_at=$4,approval_message=$5,approval_signature=$6,approval_payload=$7,paused_at=NULL,pair_hash=NULL,pair_expires_at=NULL WHERE id=$1",
      [
        g.id,
        c.wallet,
        JSON.stringify(p.scopes),
        p.expiresAt,
        c.message,
        v.signature,
        JSON.stringify(p),
      ],
    );
    await db.query(
      "INSERT INTO workflow_authority_audit(authority_id,action) VALUES($1,'Wallet approved exact device and permissions')",
      [g.id],
    );
    await db.query("COMMIT");
    return { approved: true, wallet: c.wallet };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function controlWorkflow(
  pool: Pool,
  wallet: string,
  raw: unknown,
) {
  const v = z
    .strictObject({ action: z.enum(["pause", "revoke"]), authorityId: uuid })
    .parse(raw);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const g = (
      await db.query(
        "SELECT id FROM workflow_authorities WHERE id=$1 AND wallet_address=$2 AND revoked_at IS NULL FOR UPDATE",
        [v.authorityId, wallet],
      )
    ).rows[0];
    if (!g) throw Error("WORKFLOW_UNAVAILABLE");
    await db.query(
      v.action === "pause"
        ? "UPDATE workflow_authorities SET paused_at=now() WHERE id=$1"
        : "UPDATE workflow_authorities SET revoked_at=now() WHERE id=$1",
      [g.id],
    );
    await db.query(
      "INSERT INTO workflow_authority_audit(authority_id,action) VALUES($1,$2)",
      [g.id, `Wallet owner ${v.action}`],
    );
    await db.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
// Device registration never creates source-app credentials or inherits another person's grants.
export async function registerDevice(pool: Pool, raw: unknown) {
  const v = z
    .strictObject({
      deviceLabel: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[^\r\n]+$/),
      modelLabel: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[^\r\n]+$/),
    })
    .parse(raw);
  const controlToken = token(),
    pairCode = randomBytes(16).toString("hex"),
    id = randomUUID(),
    deviceId = randomUUID();
  await pool.query(
    "INSERT INTO workflow_authorities(id,owner_id,control_hash,device_id,device_label,model_label,require_wallet,paused_at,pair_hash,pair_expires_at) VALUES($1,$2,$3,$4,$5,$6,true,now(),$7,now()+interval '10 minutes')",
    [
      id,
      randomUUID(),
      hash(controlToken),
      deviceId,
      v.deviceLabel,
      v.modelLabel,
      hash(pairCode),
    ],
  );
  return {
    authorityId: id,
    deviceId,
    controlToken,
    pairCode,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
}
export async function deviceControl(
  pool: Pool,
  controlToken: string,
  raw: unknown,
) {
  const v = z
    .strictObject({
      action: z.enum(["status", "pause", "revoke", "heartbeat"]),
    })
    .parse(raw);
  if (!/^[a-f0-9]{64}$/.test(controlToken)) throw Error("DENIED");
  const g = (
    await pool.query(
      "SELECT id,wallet_address,device_label,device_id,model_label,paused_at,revoked_at,signed_at,require_wallet,approval_expires_at,last_seen_at FROM workflow_authorities WHERE control_hash=$1",
      [hash(controlToken)],
    )
  ).rows[0];
  if (!g) throw Error("DENIED");
  if (v.action === "heartbeat" && !g.revoked_at)
    await pool.query(
      "UPDATE workflow_authorities SET last_seen_at=now() WHERE id=$1",
      [g.id],
    );
  if (["pause", "revoke"].includes(v.action) && !g.revoked_at) {
    await pool.query(
      v.action === "pause"
        ? "UPDATE workflow_authorities SET paused_at=now() WHERE id=$1"
        : "UPDATE workflow_authorities SET revoked_at=now() WHERE id=$1",
      [g.id],
    );
    await pool.query(
      "INSERT INTO workflow_authority_audit(authority_id,action) VALUES($1,$2)",
      [g.id, `Connected device ${v.action}`],
    );
    return { ok: true };
  }
  const activity = (
    await pool.query(
      "SELECT action,created_at FROM workflow_authority_audit WHERE authority_id=$1 ORDER BY id DESC LIMIT 25",
      [g.id],
    )
  ).rows;
  const runs = (
    await pool.query(
      "SELECT run_id,counts,outcomes,updated_at FROM marketplace_status WHERE owner_id=(SELECT owner_id FROM workflow_authorities WHERE id=$1) ORDER BY updated_at DESC LIMIT 30",
      [g.id],
    )
  ).rows;
  return {
    grant: g,
    activity,
    runs,
    approvalUrl: workflowOrigin + "/workflows",
  };
}
