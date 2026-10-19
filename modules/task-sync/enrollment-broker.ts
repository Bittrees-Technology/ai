import {createServer,type Server} from "node:http";
import {timingSafeEqual} from "node:crypto";
import {enrollmentOperation} from "./enrollment-transport-plan.js";
import type {EnrollmentSession} from "./enrollment-session.js";
/** Inactive native-side IPC interface. No review/session creation endpoint.
 * Only the trusted native owner supplies the already-reviewed session and random token.
 * Calling listen is explicit; no registration or launcher changes exist here.
 */
export class EnrollmentBroker {
 private server:Server;
 private endpoint?:string;
 constructor(token:string,current:()=>Pick<EnrollmentSession,"execute">|null){
  if(!/^[a-f0-9]{64}$/.test(token))throw Error("Invalid enrollment broker capability");
  const expected=Buffer.from("Bearer "+token);
  this.server=createServer(async(req,res)=>{
   const controller=new AbortController();
   const deadline=setTimeout(()=>controller.abort(Error("Broker deadline")),16000);
   res.on("close",()=>{if(!res.writableEnded)controller.abort(Error("Caller disconnected"));});
   const fail=(status:number)=>{if(!res.headersSent&&!res.destroyed){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","Connection":"close"});res.end('{"error":"Enrollment request unavailable"}');}};
   try{
    const auth=Buffer.from(typeof req.headers.authorization==="string"?req.headers.authorization:"");
    if(req.socket.remoteAddress!=="127.0.0.1"||!this.endpoint||req.headers.host!==new URL(this.endpoint).host||req.method!=="POST"||req.url!=="/enrollment"||req.headers.origin||req.headers.cookie||auth.length!==expected.length||!timingSafeEqual(auth,expected)) {fail(403);return;}
    if(req.headers["content-type"]!=="application/json"||req.headers["content-encoding"]){fail(400);return;}
    const session=current();if(!session){fail(403);return;}
    let size=0;const chunks:Buffer[]=[];
    const abort=()=>req.destroy();controller.signal.addEventListener("abort",abort,{once:true});
    try{for await(const chunk of req){size+=chunk.length;if(size>16000){fail(413);return;}chunks.push(Buffer.from(chunk));}}
    finally{controller.signal.removeEventListener("abort",abort);}
    controller.signal.throwIfAborted();
    const value=enrollmentOperation.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
    if(current()!==session){fail(403);return;}
    const result=await session.execute(value,controller.signal);
    controller.signal.throwIfAborted();if(current()!==session){fail(403);return;}
    const body=JSON.stringify(result);if(Buffer.byteLength(body)>64000)throw Error("Broker response too large");
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(body);
   }catch{fail(400);}finally{clearTimeout(deadline);}
  });
  this.server.requestTimeout=17000;this.server.headersTimeout=5000;this.server.maxHeadersCount=20;this.server.maxConnections=4;
 }
 async listen(){
  if(this.endpoint)throw Error("Enrollment broker already listening");
  await new Promise<void>((resolve,reject)=>{this.server.once("error",reject);this.server.listen(0,"127.0.0.1",()=>{this.server.removeListener("error",reject);resolve();});});
  const address=this.server.address();if(!address||typeof address==="string")throw Error("Missing broker address");
  this.endpoint=`http://127.0.0.1:${address.port}/enrollment`;return this.endpoint;
 }
 async close(){this.endpoint=undefined;this.server.closeIdleConnections();await new Promise<void>((resolve,reject)=>this.server.close(e=>e?reject(e):resolve()));}
}
