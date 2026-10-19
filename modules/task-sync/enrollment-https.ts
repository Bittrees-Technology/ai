import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicIPv4 } from "../research/public-pages.js";
import { enrollmentOperation, type EnrollmentTransportPlan } from "./enrollment-transport-plan.js";
import { z } from "zod";
type Plan=ReturnType<EnrollmentTransportPlan["prepare"]>;
const paths=new Set(["https://ai.bittrees.org/api/workflows",... ["start","poll","complete"].map(x=>"https://roles.bittrees.org/api/mcp/runtime/"+x)]);
export function checkEnrollmentHTTPSPlan(plan:Plan) {
  if(!paths.has(plan.url)||plan.method!=="POST"||plan.redirect!=="error"||plan.maximumResponseBytes!==64000||!Number.isInteger(plan.timeoutMs)||plan.timeoutMs<1||plan.timeoutMs>15000)
    throw Error("Unapproved enrollment transport plan");
  if(plan.url.startsWith("https://roles.")) {
    const action=plan.url.slice(plan.url.lastIndexOf("/")+1);
    const body=z.record(z.string(),z.unknown()).parse(plan.body);
    if("operation" in body)throw Error("Unexpected operation override");
    enrollmentOperation.parse({operation:action,...body});
  } else {
    const body=z.record(z.string(),z.unknown()).parse(plan.body);
    if(body.action==="device")z.strictObject({action:z.literal("device"),input:z.strictObject({action:z.literal("heartbeat")})}).parse(body);
    else {
      const a=z.strictObject({action:z.literal("runtime-attestation"),input:z.strictObject({purpose:z.literal("enroll"),request:z.unknown(),signature:z.string()})}).parse(body);
      enrollmentOperation.parse({operation:"attest",request:a.input.request,signature:a.input.signature});
    }
  }
  const body=JSON.stringify(plan.body);
  if(Buffer.byteLength(body)>16000)throw Error("Enrollment body too large");
  return body;
}
/** Unregistered native-side adapter. No network activity on construction.
 * Admission must enforce current owner/cost/session scope before every request.
 * Never instantiate in the model core or use this as a general proxy.
 */
export class EnrollmentHTTPS {
  private resolving = false;
  constructor(private admit:(epoch:string)=>void,private token:()=>string,
    private resolve:typeof lookup=lookup,private send:typeof request=request) {}
  dispatch=async(plan:Plan,signal:AbortSignal):Promise<Uint8Array>=>{
    const body=checkEnrollmentHTTPSPlan(plan);
    this.admit(plan.epoch);signal.throwIfAborted();
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(plan.timeoutMs)]);
    const url=new URL(plan.url);
    // Pin a validated IPv4 answer; never resolve a second time inside the socket.
    // IPv6 is conservatively excluded until separately reviewed.
    if(this.resolving)throw Error("Prior enrollment DNS lookup still pending");
    this.resolving=true;
    const pending=Promise.resolve().then(()=>this.resolve(url.hostname,{all:true,family:4})).finally(()=>{this.resolving=false;});
    const addresses=await new Promise<Awaited<typeof pending>>((resolve,reject)=>{
      const abort=()=>reject(bounded.reason ?? Error("Enrollment DNS cancelled"));
      bounded.addEventListener("abort",abort,{once:true});
      if(bounded.aborted)abort();
      pending.then(resolve,reject).finally(()=>bounded.removeEventListener("abort",abort));
    });
    bounded.throwIfAborted();this.admit(plan.epoch);
    if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)||a.address.startsWith("192.88.99.")))throw Error("Enrollment DNS address rejected");
    const address=addresses[0]!.address;
    const headers:Record<string,string>={"Content-Type":"application/json",Accept:"application/json","Accept-Encoding":"identity","Content-Length":String(Buffer.byteLength(body))};
    if(url.hostname==="ai.bittrees.org"){
      const token=this.token();if(!/^[a-f0-9]{64}$/.test(token))throw Error("Device credential unavailable");headers.Authorization="Bearer "+token;
    }
    return new Promise((resolve,reject)=>{
      const req=this.send(url,{method:"POST",headers,signal:bounded,agent:false,family:4,rejectUnauthorized:true,servername:url.hostname,
        lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,[{address,family:4}]):cb(null,address,4)) as any},res=>{
        res.on("error",reject);
        res.on("aborted",()=>reject(Error("Enrollment response interrupted")));
        if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(res.headers["content-type"]||""))||
          (res.headers["content-encoding"]&&res.headers["content-encoding"]!=="identity")){
          res.destroy();reject(Error("Enrollment response status or encoding rejected"));return;
        }
        let size=0;const chunks:Buffer[]=[];
        res.on("data",chunk=>{size+=chunk.length;if(size>64000){res.destroy(Error("Enrollment response too large"));return;}chunks.push(Buffer.from(chunk));});
        res.on("end",()=>{try{bounded.throwIfAborted();this.admit(plan.epoch);resolve(Buffer.concat(chunks));}catch(e){reject(e);}});
      });
      req.on("error",reject);req.end(body);
    });
  };
}
