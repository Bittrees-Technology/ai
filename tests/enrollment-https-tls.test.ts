import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {createServer,request} from "node:https";
import {EnrollmentHTTPS} from "../modules/task-sync/enrollment-https.js";
// Per-test CA exists only in temporary files and this request's options.
// The test injection routes fixed-host requests to loopback; production DNS rules are unchanged.
test("real local TLS accepts the configured host and rejects wrong name or untrusted certificate",async()=>{
 const dir=mkdtempSync(tmpdir()+"/enrollment-tls-");
 writeFileSync(dir+"/cert.cnf","[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=ai.bittrees.org\n[ext]\nsubjectAltName=DNS:ai.bittrees.org\n",{mode:0o600});
 execFileSync("/usr/bin/openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",dir+"/key.pem","-out",dir+"/cert.pem","-days","1","-config",dir+"/cert.cnf"],{stdio:"ignore"});
 const key=readFileSync(dir+"/key.pem"),cert=readFileSync(dir+"/cert.pem");
 let accepted=0;
 const server=createServer({key,cert},(req,res)=>{
  accepted++;assert.equal(req.headers.host,"ai.bittrees.org");assert.equal(req.headers.authorization,"Bearer "+"a".repeat(64));
  req.resume();req.on("end",()=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"fixture":true}');});
 });
 server.on("tlsClientError",()=>{});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const plan={method:"POST" as const,url:"https://ai.bittrees.org/api/workflows",redirect:"error" as const,body:{action:"device",input:{action:"heartbeat"}},timeoutMs:15000,maximumResponseBytes:64000,epoch:"fixture"};
 try {
  for(const mode of ["valid","wrong-name","untrusted"]){
   const send=((url:any,options:any,callback:any)=>request(url,{
    ...options,port:address.port,headers:{...options.headers,Host:"ai.bittrees.org"},
    ...(mode!=="untrusted"?{ca:cert}:{}),servername:mode==="wrong-name"?"roles.bittrees.org":options.servername,
    lookup:((_h:any,o:any,cb:any)=>o.all?cb(null,[{address:"127.0.0.1",family:4}]):cb(null,"127.0.0.1",4)) as any,
   },callback)) as typeof request;
   const adapter=new EnrollmentHTTPS(()=>{},()=>"a".repeat(64),(async()=>[{address:"8.8.8.8",family:4}]) as any,send);
   if(mode==="valid")assert.deepEqual(JSON.parse(Buffer.from(await adapter.dispatch(plan,new AbortController().signal)).toString()),{fixture:true});
   else await assert.rejects(adapter.dispatch(plan,new AbortController().signal),mode==="wrong-name"?/Hostname\/IP does not match/:/self-signed certificate/);
  }
  assert.equal(accepted,1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true});}
});
