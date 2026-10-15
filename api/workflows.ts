import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import {
  challenge,
  verifyChallenge,
  walletSession,
  portalList,
  controlWorkflow,
  registerDevice,
  deviceControl,
  rateLimit,
  hash,
  workflowOrigin,
} from "../modules/coordinator/workflow-portal.js";
let pool: Pool | undefined;
const sessionName = "__Host-workflow-session",
  browserName = "__Host-workflow-browser";
const cookie = (req: any, name: string) =>
  String(req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1) || "";
const setCookie = (name: string, value: string, age: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST_REQUIRED" });
  try {
    if (!process.env.DATABASE_URL) throw Error("UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || JSON.stringify(body).length > 12000)
      throw Error("INVALID_INPUT");
    await rateLimit(
      pool,
      "ip:" +
        String(
          req.headers["x-forwarded-for"] ||
            req.socket?.remoteAddress ||
            "unknown",
        ).split(",")[0],
      100,
    );
    if (body.action === "register-device" || body.action === "device") {
      if (req.headers.origin || req.headers.cookie)
        throw Error("SERVICE_REQUIRED");
      if (body.action === "register-device") {
        await rateLimit(
          pool,
          "register:" +
            String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress),
          5,
        );
        return res.json(await registerDevice(pool, body.input));
      }
      return res.json(
        await deviceControl(
          pool,
          String(req.headers.authorization || "").replace(/^Bearer /, ""),
          body.input,
        ),
      );
    }
    if (req.headers.origin !== workflowOrigin) throw Error("INVALID_ORIGIN");
    let browser = cookie(req, browserName);
    if (!/^[a-f0-9]{64}$/.test(browser)) {
      browser = randomBytes(32).toString("hex");
      res.setHeader("Set-Cookie", setCookie(browserName, browser, 28800));
    }
    let wallet: string | undefined;
    try {
      wallet = await walletSession(pool, cookie(req, sessionName));
    } catch {}
    if (body.action === "challenge") {
      await rateLimit(pool, "challenge:" + browser, 20);
      return res.json(await challenge(pool, browser, body.input, wallet));
    }
    if (body.action === "verify") {
      await rateLimit(pool, "verify:" + browser, 20);
      const result = await verifyChallenge(pool, browser, body.input, wallet);
      if ("session" in result) {
        res.setHeader("Set-Cookie", [
          setCookie(sessionName, result.session!, 28800),
          setCookie(browserName, browser, 28800),
        ]);
        return res.json({ wallet: result.wallet });
      }
      return res.json(result);
    }
    if (!wallet) throw Error("SIGN_IN_REQUIRED");
    if (body.action === "logout") {
      await pool.query(
        "DELETE FROM workflow_wallet_sessions WHERE token_hash=$1",
        [hash(cookie(req, sessionName))],
      );
      res.setHeader("Set-Cookie", setCookie(sessionName, "", 0));
      return res.json({ ok: true });
    }
    if (body.action === "list") return res.json(await portalList(pool, wallet));
    if (body.action === "control")
      return res.json(await controlWorkflow(pool, wallet, body.input));
    if (body.action === "pair") {
      const code = body.input?.pairCode;
      if (typeof code !== "string" || !/^[a-f0-9]{32}$/.test(code))
        throw Error("INVALID_PAIRING");
      const g = (
        await pool.query(
          "SELECT id,device_id,device_label,model_label,require_wallet,paused_at FROM workflow_authorities WHERE pair_hash=$1 AND pair_expires_at>now() AND wallet_address IS NULL AND revoked_at IS NULL",
          [hash(code)],
        )
      ).rows[0];
      if (!g) throw Error("PAIRING_EXPIRED");
      return res.json({ grant: g });
    }
    throw Error("INVALID_INPUT");
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const safe = /^[A-Z_]{3,50}$/.test(message) ? message : "REQUEST_REJECTED";
    return res
      .status(
        safe === "SIGN_IN_REQUIRED" ? 401 : safe === "RATE_LIMITED" ? 429 : 403,
      )
      .json({ error: safe });
  }
}
