import { Pool } from "pg";
import { workflowSso } from "../../modules/coordinator/shared-sign-in.js";
import { nodeRequest,nodeResponse } from "../../shared/sso/client.mjs";
import { workflowOrigin,rateLimit } from "../../modules/coordinator/workflow-portal.js";
let pool:Pool|undefined;
export default async function handler(req:any,res:any) {
  pool??=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  if(process.env.BITTREES_SSO_ENABLED==="1"){
    try{await rateLimit(pool,"sso:"+String(req.headers["x-forwarded-for"]||"unknown"),100);}catch{return res.status(503).setHeader("Cache-Control","no-store").end();}
  }
  return nodeResponse(await workflowSso(pool)(await nodeRequest(req,workflowOrigin)),res);
}
