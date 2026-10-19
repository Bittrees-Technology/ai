import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,generateKeyPairSync} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {Vault} from "../modules/storage/vault.js";
import {EnrollmentSession} from "../modules/task-sync/enrollment-session.js";
test("assembled session persists owner response and rejects restart replay or changed review",async()=>{
 const dir=mkdtempSync(tmpdir()+"/enroll-session-"),vault=new Vault(randomBytes(32));
 const key=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();
 const review={epoch:randomUUID(),expiresAt:400000,authorityId:randomUUID(),deviceId:randomUUID(),sourceWorkspace:randomUUID(),principal:"agent:"+randomUUID(),publicKey:key,ownerWallet:"0x"+"a".repeat(40)};
 const request={operation:"start",request:{version:1,audience:"https://mcp.bittrees.org",kind:"enroll",authorityId:review.authorityId,deviceId:review.deviceId,sourceWorkspace:review.sourceWorkspace,principal:review.principal,publicKey:key,ownerWallet:review.ownerWallet,issuedAt:100000,nonce:randomUUID()},signature:"synthetic"};
 const id=randomUUID(),secret="b".repeat(64);let calls=0;
 const dispatch=async(plan:any)=>{calls++;return new TextEncoder().encode(JSON.stringify(plan.url.endsWith("/start")?{id,pollSecret:secret,reviewUrl:"https://roles.bittrees.org/profile?runtimeRequest="+id,expiresAt:new Date(400000).toISOString()}:{status:"pending",expiresAt:new Date(400000).toISOString()}));};
 let session=new EnrollmentSession(dir+"/state.db",vault,()=>review,dispatch,key,()=>100000);
 try{
  await session.execute(request,new AbortController().signal);session.close();
  session=new EnrollmentSession(dir+"/state.db",vault,()=>review,dispatch,key,()=>100000);
  await assert.rejects(session.execute(request,new AbortController().signal),/reconciliation/);
  await session.execute({operation:"poll",id,pollSecret:secret},new AbortController().signal);
  assert.equal(calls,2);
  assert.throws(()=>new EnrollmentSession(dir+"/state.db",vault,()=>({...review,deviceId:randomUUID()}),dispatch,key,()=>100000),/scope changed/);
 }finally{session.close();rmSync(dir,{recursive:true});}
});
