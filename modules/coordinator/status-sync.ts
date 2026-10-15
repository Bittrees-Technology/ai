import { activeExpiry } from "./authority-client.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { LocalRunStore } from "./local-store.js";
const counts = z
  .record(
    z
      .string()
      .regex(/^(crm|mercado):(pending|uncertain|awaiting_review|decided)$/),
    z.number().int().min(0).max(21),
  )
  .refine((c) => Object.values(c).reduce((a, b) => a + b, 0) <= 21);
const snapshot = z.strictObject({
  runId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  counts,
});
export type SyncGrant = {
  ownerId: string;
  tokenHash: string;
  expiresAt: number | null;
  managed?: boolean;
};
export function syncAuthority(
  bearer: string,
  grants: SyncGrant[],
  now = Date.now(),
) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(bearer)?.[1];
  if (!token) throw Error("Denied");
  const hash = createHash("sha256").update(token).digest();
  const g = grants.find(
    (g) =>
      /^[a-f0-9]{64}$/.test(g.tokenHash) &&
      timingSafeEqual(hash, Buffer.from(g.tokenHash, "hex")),
  );
  if (!g || !activeExpiry(g, now) || !z.uuid().safeParse(g.ownerId).success)
    throw Error("Denied");
  return g;
}
export async function acceptStatus(pool: Pool, owner: string, raw: unknown) {
  const value = snapshot.parse(raw);
  // Same sequence must describe the same snapshot; older updates never overwrite newer ones.
  await pool.query(
    "INSERT INTO marketplace_status(owner_id,run_id,revision,counts) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,run_id) DO UPDATE SET revision=EXCLUDED.revision,counts=EXCLUDED.counts,updated_at=now() WHERE marketplace_status.revision<EXCLUDED.revision",
    [owner, value.runId, value.revision, value.counts],
  );
  const row = (
    await pool.query(
      "SELECT revision,counts FROM marketplace_status WHERE owner_id=$1 AND run_id=$2",
      [owner, value.runId],
    )
  ).rows[0];
  if (
    Number(row.revision) === value.revision &&
    JSON.stringify(Object.entries(row.counts).sort()) !==
      JSON.stringify(Object.entries(value.counts).sort())
  )
    throw Error("Revision conflict");
  return {
    runId: value.runId,
    revision: Number(row.revision),
    counts: row.counts,
  };
}
export async function syncLocalStatus(
  store: LocalRunStore,
  owner: string,
  token: string,
  request: typeof fetch = fetch,
  authorize: () => void = () => {},
) {
  for (const value of store.pending(owner)) {
    authorize();
    const response = await request(
      "https://ai.bittrees.org/api/workflow-status",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw Error("Status sync unavailable");
    const receipt = (await response.json()) as any;
    if (receipt.runId !== value.runId || receipt.revision !== value.revision)
      throw Error("Status sync conflict");
    store.acknowledge(owner, value.runId, value.revision);
  }
}
