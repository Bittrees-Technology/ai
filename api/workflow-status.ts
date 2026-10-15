import { cloudAuthority } from "../modules/coordinator/cloud-authority.js";
import { Pool } from "pg";
import {
  syncAuthority,
  acceptStatus,
} from "../modules/coordinator/status-sync.js";
let pool: Pool | undefined;
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST required" });
  if (req.headers.origin || req.headers.cookie)
    return res.status(403).json({ error: "Service connection required" });
  let grant;
  try {
    grant = syncAuthority(
      req.headers.authorization || "",
      JSON.parse(process.env.AI_STATUS_SYNC_GRANTS_JSON || "[]"),
    );
  } catch {
    return res.status(403).json({ error: "Connection unavailable" });
  }
  if (!process.env.DATABASE_URL)
    return res.status(503).json({ error: "Sync unavailable" });
  let input = req.body;
  try {
    if (typeof input === "string") {
      if (input.length > 4096) throw Error();
      input = JSON.parse(input);
    }
    if (JSON.stringify(input).length > 4096) throw Error();
  } catch {
    return res.status(400).json({ error: "Invalid snapshot" });
  }
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    if (grant.managed)
      await cloudAuthority(pool, req.headers.authorization.slice(7), {
        action: "check",
        audience: "sync",
        scope: "sync",
      });
    return res.status(200).json(await acceptStatus(pool, grant.ownerId, input));
  } catch {
    return res
      .status(400)
      .json({ error: "Snapshot rejected or sync unavailable" });
  }
}
