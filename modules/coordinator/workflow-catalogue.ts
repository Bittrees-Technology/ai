import { z } from "zod";
import type { Pool } from "pg";
import { hash } from "./workflow-portal.js";
export const localCatalogueSchema = z.strictObject({
  action: z.literal("catalogue"),
  observedAt: z.number().int().safe().positive(),
  entries: z
    .array(
      z.strictObject({
        id: z.uuid(),
        revision: z.number().int().safe().positive(),
        kind: z.enum(["draft", "summarize", "query"]),
      }),
    )
    .max(100),
});
// Device tokens can publish only an opaque index for their own paired owner.
// They cannot approve, resume, execute, change scopes, or select another owner.
export async function syncLocalCatalogue(
  pool: Pool,
  controlToken: string,
  raw: unknown,
  now = Date.now(),
) {
  const input = localCatalogueSchema.parse(raw);
  if (
    !/^[a-f0-9]{64}$/.test(controlToken) ||
    Math.abs(now - input.observedAt) > 300000 ||
    new Set(input.entries.map((x) => x.id)).size !== input.entries.length
  )
    throw Error("DENIED");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const g = (
      await db.query(
        "SELECT id,wallet_address,revoked_at FROM workflow_authorities WHERE control_hash=$1 FOR UPDATE",
        [hash(controlToken)],
      )
    ).rows[0];
    if (!g || g.revoked_at) throw Error("DENIED");
    if (!g.wallet_address) {
      await db.query("ROLLBACK");
      return { synced: false, reason: "OWNER_APPROVAL_REQUIRED" };
    }
    const prior = (
      await db.query(
        "SELECT observed_at FROM workflow_catalogue_snapshots WHERE authority_id=$1",
        [g.id],
      )
    ).rows[0];
    if (prior && Number(prior.observed_at) >= input.observedAt) {
      await db.query("ROLLBACK");
      return { synced: false, reason: "OLDER_SNAPSHOT" };
    }
    await db.query(
      "INSERT INTO workflow_catalogue_snapshots(authority_id,observed_at) VALUES($1,$2) ON CONFLICT(authority_id) DO UPDATE SET observed_at=excluded.observed_at",
      [g.id, input.observedAt],
    );
    await db.query(
      `UPDATE workflow_local_catalogue SET removed_at=now(),updated_at=now() WHERE authority_id=$1 AND NOT (template_id=ANY($2::uuid[])) AND removed_at IS NULL`,
      [g.id, input.entries.map((x) => x.id)],
    );
    for (const entry of input.entries)
      await db.query(
        `INSERT INTO workflow_local_catalogue(authority_id,template_id,revision,kind) VALUES($1,$2,$3,$4) ON CONFLICT(authority_id,template_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind,removed_at=NULL,updated_at=now() WHERE workflow_local_catalogue.revision<=excluded.revision`,
        [g.id, entry.id, entry.revision, entry.kind],
      );
    await db.query(
      "UPDATE workflow_authorities SET last_seen_at=now() WHERE id=$1",
      [g.id],
    );
    await db.query("COMMIT");
    return { synced: true, count: input.entries.length };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
