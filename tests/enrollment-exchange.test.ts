import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { EnrollmentJournal } from "../modules/task-sync/enrollment-journal.js";
import { EnrollmentTransportPlan, type EnrollmentReview } from "../modules/task-sync/enrollment-transport-plan.js";
import { EnrollmentExchange } from "../modules/task-sync/enrollment-exchange.js";
function fixture() {
  const dir=mkdtempSync(tmpdir()+"/enrollment-exchange-"), vault=new Vault(randomBytes(32));
  let review: EnrollmentReview|null={epoch:randomUUID(), expiresAt:400000,authorityId:randomUUID(), deviceId:randomUUID(),sourceWorkspace:randomUUID(),principal:"agent:"+randomUUID(),publicKey:"fixture",ownerWallet:"0x"+"a".repeat(40)};
  const request={operation:"start",request:{version:1,audience:"https://mcp.bittrees.org",kind:"enroll",authorityId:review.authorityId,deviceId:review.deviceId,sourceWorkspace:review.sourceWorkspace,principal:review.principal,publicKey:review.publicKey,ownerWallet:review.ownerWallet,issuedAt:100000,nonce:randomUUID()},signature:"synthetic"};
  const journals:EnrollmentJournal[]=[];
  const make=(dispatch:ConstructorParameters<typeof EnrollmentExchange>[2],verify:ConstructorParameters<typeof EnrollmentExchange>[3]=(_op,r)=>{assert.deepEqual(r,{fixture:true});})=>{
    const plan=new EnrollmentTransportPlan(()=>review,()=>100000);
    const journal=new EnrollmentJournal(dir+"/journal.db",vault,()=>{plan.assertCurrent();});journals.push(journal);
    return new EnrollmentExchange(plan,journal,dispatch,verify);
  };
  return {make,request,revoke:()=>{review=null;},cleanup:()=>{journals.forEach(j=>j.close());rmSync(dir,{recursive:true});}};
}
const encoded=()=>new TextEncoder().encode(JSON.stringify({fixture:true}));
test("verified response returns once; reconstructed exchange cannot resend mutation",async()=>{
 const f=fixture();let calls=0;const dispatch=async()=>{calls++;return encoded();};
 try {assert.deepEqual(await f.make(dispatch).execute(f.request,new AbortController().signal),{fixture:true});
 await assert.rejects(f.make(dispatch).execute(f.request,new AbortController().signal),/reconciliation/);assert.equal(calls,1);
 }finally{f.cleanup();}
});
test("unknown transport outcome survives reconstruction without dispatch replay",async()=>{
 const f=fixture();let calls=0;const dispatch=async()=>{calls++;throw Error("connection lost");};
 try {await assert.rejects(f.make(dispatch).execute(f.request,new AbortController().signal));
 await assert.rejects(f.make(dispatch).execute(f.request,new AbortController().signal));assert.equal(calls,1);
 }finally{f.cleanup();}
});
test("revocation and cancellation after dispatch discard returned evidence",async()=>{
 for(const mode of ["revoke","cancel"]){const f=fixture(),controller=new AbortController();
 try {const x=f.make(async()=>{if(mode==="revoke")f.revoke();else controller.abort();return encoded();});
 await assert.rejects(x.execute(f.request,controller.signal));}finally{f.cleanup();}}
});
test("malformed, oversized and unverified responses stay held",async()=>{
 for(const value of [new Uint8Array(64001),new Uint8Array([0xff]),new TextEncoder().encode('{"notAccepted":true}')]){
 const f=fixture();let calls=0;const dispatch=async()=>{calls++;return value;};
 try{await assert.rejects(f.make(dispatch).execute(f.request,new AbortController().signal));await assert.rejects(f.make(dispatch).execute(f.request,new AbortController().signal));assert.equal(calls,1);}finally{f.cleanup();}}
});

test("asynchronous verification must settle before confirmation or another exchange",async()=>{
 const f=fixture();let release!:()=>void;let entered!:()=>void;
 const waiting=new Promise<void>(r=>{entered=r;});const barrier=new Promise<void>(r=>{release=r;});
 try {const x=f.make(async()=>encoded(),async()=>{entered();await barrier;throw Error("invalid signature fixture");});
 const pending=x.execute(f.request,new AbortController().signal);await waiting;
 await assert.rejects(x.execute({operation:"heartbeat"},new AbortController().signal),/already active/);
 release();await assert.rejects(pending,/invalid signature/);
 await assert.rejects(f.make(async()=>encoded()).execute(f.request,new AbortController().signal),/reconciliation/);
 }finally{release?.();f.cleanup();}
});
