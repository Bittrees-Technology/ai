import test from "node:test";
import assert from "node:assert/strict";
import {EnrollmentHTTPS,checkEnrollmentHTTPSPlan} from "../modules/task-sync/enrollment-https.js";
const plan={method:"POST" as const,url:"https://ai.bittrees.org/api/workflows",redirect:"error" as const,body:{action:"device",input:{action:"heartbeat"}},timeoutMs:15000,maximumResponseBytes:64000,epoch:"fixture"};
test("HTTPS plan rejects alternate URL paths, ports, headers and catalogue operations",()=>{
 checkEnrollmentHTTPSPlan(plan);
 for(const url of [plan.url+"?x=1",plan.url.replace("https:","http:"),plan.url.replace(".org/",".org:444/"),"https://127.0.0.1/api/workflows",plan.url+"/../workflows"])
 assert.throws(()=>checkEnrollmentHTTPSPlan({...plan,url}));
 for(const body of [{action:"device",input:{action:"catalogue"}},{action:"register-device",input:{}},{action:"device",input:{action:"heartbeat"},headers:{}}])assert.throws(()=>checkEnrollmentHTTPSPlan({...plan,body}));
});
test("private, mixed and IPv6 answers never reach HTTP or credentials",async()=>{
 for(const ips of [["127.0.0.1"],["10.0.0.1"],["169.254.169.254"],["8.8.8.8","192.168.1.1"],["::1"],["192.88.99.1"]]){
 let calls=0;const x=new EnrollmentHTTPS(()=>{},()=>{throw Error("Must not load token");},(async()=>ips.map(address=>({address,family:4}))) as any,(()=>{calls++;throw Error("Must not send");}) as any);
 await assert.rejects(x.dispatch(plan,new AbortController().signal),/DNS address/);assert.equal(calls,0);
 }
});
test("disabled admission blocks DNS and cancelled DNS completion blocks dispatch",async()=>{
 let resolves=0;const x=new EnrollmentHTTPS(()=>{throw Error("disabled");},()=>"",(async()=>{resolves++;return [];}) as any);
 await assert.rejects(x.dispatch(plan,new AbortController().signal),/disabled/);assert.equal(resolves,0);
 const c=new AbortController();const y=new EnrollmentHTTPS(()=>{},()=>{throw Error("no token");},(async()=>{c.abort();return [{address:"8.8.8.8",family:4}];}) as any);
 await assert.rejects(y.dispatch(plan,c.signal));
});
