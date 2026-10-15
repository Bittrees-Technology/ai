import { Pool } from "pg";
import { cloudAuthority } from "../modules/coordinator/cloud-authority.js";
let pool: Pool | undefined;
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST required" });
  if (req.headers.origin || req.headers.cookie)
    return res.status(403).json({ error: "Service authority required" });
  try {
    const token =
      /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "")?.[1] ||
      "";
    if (JSON.stringify(req.body).length > 1024) throw Error();
    const input =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!process.env.DATABASE_URL) throw Error();
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    return res.status(200).json(await cloudAuthority(pool, token, input));
  } catch {
    return res.status(403).json({ error: "Authority unavailable" });
  }
}
