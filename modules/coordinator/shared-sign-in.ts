import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { createSsoClient, digest } from "../../shared/sso/client.mjs";
import { workflowOrigin } from "./workflow-portal.js";
const name = "__Host-workflow-session";
export function workflowSso(pool: Pick<Pool, "query">, config = process.env, fetcher = fetch) {
  return createSsoClient({clientId:"ai",cookiePrefix:"bt-sso-ai",origin:workflowOrigin,issuer:config.BITTREES_SSO_ISSUER||"https://roles.bittrees.org",secret:config.BITTREES_SSO_CLIENT_SECRET,enabled:config.BITTREES_SSO_ENABLED==="1",fetcher,adapter:{
    async current(req) {
      const key=(req.headers.get("cookie")||"").split(";").map(v=>v.trim()).find(v=>v.startsWith(name+"="))?.slice(name.length+1)||"";
      if(!/^[a-f0-9]{64}$/.test(key))return null;
      const row=(await pool.query("SELECT wallet,expires_at FROM workflow_wallet_sessions WHERE token_hash=$1 AND expires_at>now()",[digest(key)])).rows[0];
      if(!row)return null;
      return {key,identity:row.wallet,authTime:new Date(row.expires_at).getTime()-28800000};
    },
    async establish(wallet,authTime) {
      if(!/^0x[0-9a-f]{40}$/.test(wallet))throw Error("WALLET_REQUIRED");
      const expires=Math.min(Date.now()+28800000,authTime+604800000);
      if(expires<=Date.now())throw Error("SIGN_IN_REQUIRED");
      const key=randomBytes(32).toString("hex");
      await pool.query("INSERT INTO workflow_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,least(now()+interval '8 hours',to_timestamp($3)))",[digest(key),wallet,expires/1000]);
      return {key,cookies:[`${name}=${key}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor((expires-Date.now())/1000))}`]};
    }
  }});
}
