// Run from the AI service scheduler. Bounded pass; no credentials accepted from jobs.
import { Pool } from "pg";
import {
  MarketplaceCoordinator,
  type Connection,
} from "../modules/coordinator/workflow.js";
const connections: Connection[] = JSON.parse(
  process.env.AI_MARKETPLACE_CONNECTIONS_JSON || "[]",
);
if (!process.env.REMOTE_DATABASE_URL)
  throw Error("REMOTE_DATABASE_URL required");
const pool = new Pool({
  connectionString: process.env.REMOTE_DATABASE_URL,
  max: 2,
});
const coordinator = new MarketplaceCoordinator(pool, connections);
try {
  const owners = connections
    .filter((c) => c.expiresAt > Date.now())
    .map((c) => c.ownerId);
  const runs = await pool.query(
    "SELECT id,owner_id FROM marketplace_runs WHERE owner_id=ANY($1::text[]) AND EXISTS(SELECT 1 FROM jsonb_array_elements(steps) s WHERE s->>'state'<>'decided') AND (lease_until IS NULL OR lease_until<now()) ORDER BY updated_at LIMIT 20",
    [owners],
  );
  for (const run of runs.rows) {
    try {
      await coordinator.advance(run.owner_id, run.id);
    } catch {
      console.error("Workflow pass failed for run", run.id);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
