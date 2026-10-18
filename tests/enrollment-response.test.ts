import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateEnrollmentStart,validateEnrollmentPoll } from "../modules/task-sync/enrollment-response.js";
const now=100000;
const review={epoch:"fixture",expiresAt:400000,authorityId:randomUUID(),deviceId:randomUUID(),sourceWorkspace:randomUUID(),principal:"agent:"+randomUUID(),publicKey:"fixture",ownerWallet:"0x"+"a".repeat(40)};
const id=randomUUID();
const start={id,pollSecret:"a".repeat(64),reviewUrl:"https://roles.bittrees.org/profile?runtimeRequest="+id,expiresAt:new Date(400000).toISOString()};
const request={version:1,audience:"https://mcp.bittrees.org",profileId:randomUUID(),principal:review.principal,publicKey:review.publicKey,authorityId:review.authorityId,deviceId:review.deviceId,sourceWorkspace:review.sourceWorkspace,issuedAt:now,nonce:randomUUID()};
test("start accepts exact Roles owner URL and refuses alternative destinations",()=>{
 assert.deepEqual(validateEnrollmentStart(start,review,now),start);
 for(const reviewUrl of [start.reviewUrl+"&next=https://example.com",start.reviewUrl.replace("roles.","evil."),start.reviewUrl.replace("https:","http:")])assert.throws(()=>validateEnrollmentStart({...start,reviewUrl},review,now));
});
test("owner response cannot extend review, expire, or add authority fields",()=>{
 for(const end of [now,400001])assert.throws(()=>validateEnrollmentStart({...start,expiresAt:new Date(end).toISOString()},review,now));
 assert.throws(()=>validateEnrollmentStart({...start,permissionsGranted:true},review,now));
});
test("pending and approved challenges preserve exact reviewed device",()=>{
 const pending={status:"pending",expiresAt:start.expiresAt};assert.deepEqual(validateEnrollmentPoll(pending,review,now),pending);
 const approved={status:"approved",expiresAt:start.expiresAt,request};assert.deepEqual(validateEnrollmentPoll(approved,review,now),approved);
 for(const key of ["authorityId","deviceId","sourceWorkspace","principal","publicKey"]){assert.throws(()=>validateEnrollmentPoll({...approved,request:{...request,[key]:"changed"}},review,now));}
 assert.throws(()=>validateEnrollmentPoll({...approved,request:{...request,issuedAt:1}},review,now));
});
test("completion is not accepted as an enrollment challenge or permission",()=>{
 assert.throws(()=>validateEnrollmentPoll({status:"complete",result:{permissionsGranted:true}},review,now));
});
