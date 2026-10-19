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

test("cancel returns during stuck DNS, late DNS cannot dispatch or multiply lookups",async()=>{
 let release!:(v:any)=>void;let started!:()=>void;let sends=0;
 const began=new Promise<void>(r=>{started=r;});const pending=new Promise<any>(r=>{release=r;});
 const x=new EnrollmentHTTPS(()=>{},()=>"a".repeat(64),(async()=>{started();return pending;}) as any,(()=>{sends++;}) as any);
 const c=new AbortController();const result=x.dispatch(plan,c.signal);await began;c.abort(Error("cancelled"));
 await assert.rejects(result,/cancelled/);
 await assert.rejects(x.dispatch(plan,new AbortController().signal),/still pending/);
 release([{address:"8.8.8.8",family:4}]);await new Promise(r=>setImmediate(r));assert.equal(sends,0);
});
test("HTTP adapter pins DNS and TLS, rejects redirects, encoding, overflow and interruption",async()=>{
 const {EventEmitter}=await import("node:events");const {PassThrough}=await import("node:stream");
 for(const mode of ["ok","redirect","gzip","oversize","abort"]){
  let sent=0;
  const send=((url:any,options:any,cb:any)=>{
   sent++;assert.equal(url.hostname,"ai.bittrees.org");assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,"ai.bittrees.org");assert.equal(options.agent,false);assert.equal(options.headers.Authorization,"Bearer "+"a".repeat(64));
   options.lookup("ai.bittrees.org",{all:true},(err:any,addresses:any)=>{assert.equal(err,null);assert.deepEqual(addresses,[{address:"8.8.8.8",family:4}]);});
   const req=new EventEmitter() as any;req.end=()=>setImmediate(()=>{
    const res=new PassThrough() as any;res.statusCode=mode==="redirect"?302:200;res.headers={"content-type":"application/json",...(mode==="gzip"?{"content-encoding":"gzip"}:{})};cb(res);
    if(mode==="abort"){res.emit("aborted");res.destroy();}
    else res.end(mode==="oversize"?Buffer.alloc(64001):Buffer.from("{}"));
   });return req;
  }) as any;
  const x=new EnrollmentHTTPS(()=>{},()=>"a".repeat(64),(async()=>[{address:"8.8.8.8",family:4}]) as any,send);
  if(mode==="ok")assert.equal(Buffer.from(await x.dispatch(plan,new AbortController().signal)).toString(),"{}");
  else await assert.rejects(x.dispatch(plan,new AbortController().signal));
  assert.equal(sent,1);
 }
});
