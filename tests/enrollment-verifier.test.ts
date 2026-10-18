import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {EnrollmentResponseVerifier} from "../modules/task-sync/enrollment-verifier.js";
const now=100000;
const review={epoch:"fixture",expiresAt:400000,authorityId:randomUUID(),deviceId:randomUUID(),sourceWorkspace:randomUUID(),principal:"agent:"+randomUUID(),publicKey:"fixture",ownerWallet:"0x"+"a".repeat(40)};
const response={grant:{id:review.authorityId,wallet_address:review.ownerWallet,device_label:"Mac",device_id:review.deviceId,model_label:"local",paused_at:null,revoked_at:null,signed_at:new Date(50000).toISOString(),require_wallet:true,approval_expires_at:null,last_seen_at:null},activity:[],runs:[],approvalUrl:"https://ai.bittrees.org/workflows"};
test("enrollment heartbeat requires current matching signed owner authority",()=>{
 const v=new EnrollmentResponseVerifier(()=>review,()=>null,"unused",()=>now);
 v.verify({operation:"heartbeat"},response);
 for(const patch of [{id:randomUUID()},{device_id:randomUUID()},{wallet_address:"0x"+"b".repeat(40)},{signed_at:null},{signed_at:new Date(now+1).toISOString()},{paused_at:new Date(1).toISOString()},{revoked_at:new Date(1).toISOString()},{approval_expires_at:new Date(now).toISOString()}])
  assert.throws(()=>v.verify({operation:"heartbeat"},{...response,grant:{...response.grant,...patch}}));
 assert.throws(()=>v.verify({operation:"heartbeat"},{...response,approvalUrl:"https://example.com"}));
});
test("verifier never accepts completion without exact reviewed challenge",()=>{
 const v=new EnrollmentResponseVerifier(()=>review,()=>null,"unused",()=>now);
 assert.throws(()=>v.verify({operation:"poll",id:randomUUID(),pollSecret:"a".repeat(64)},{status:"complete",result:{permissionsGranted:true}}));
 const revoked=new EnrollmentResponseVerifier(()=>null,()=>null,"unused",()=>now);
 assert.throws(()=>revoked.verify({operation:"heartbeat"},response));
});
