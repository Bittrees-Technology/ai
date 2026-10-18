import { createHash, createPublicKey, verify } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import { runtimeAttestationSchema, runtimeAttestationMessage } from "./runtime-contract.js";
import { z } from "zod";
import { runtimeEnrollmentSchema } from "./runtime-contract.js";
import type { EnrollmentReview } from "./enrollment-transport-plan.js";
const expiresAt = z.iso.datetime();
const start = z.strictObject({ id:z.uuid(),pollSecret:z.string().regex(/^[a-f0-9]{64}$/),reviewUrl:z.string().url(),expiresAt });
const poll = z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("pending"),expiresAt}),
  z.strictObject({status:z.literal("approved"),expiresAt,request:runtimeEnrollmentSchema}),
]);
function expiry(value:string,review:EnrollmentReview,now:number) {
  const end=Date.parse(value);
  if(!Number.isSafeInteger(now)||end<=now||end>now+300000||review.expiresAt<=now)throw Error("Owner response exceeds reviewed session");
}
/** Structural validation only, after authenticated fixed-host transport. Does not verify
 * TLS, signatures, current Roles membership, or grant permission. Completion is separate.
 * Server expiry never extends the planner review deadline; callers retain that earlier bound.
 */
export function validateEnrollmentStart(raw:unknown,review:EnrollmentReview,now=Date.now()) {
  const result=start.parse(raw);expiry(result.expiresAt,review,now);
  if(result.reviewUrl!=="https://roles.bittrees.org/profile?runtimeRequest="+result.id)
    throw Error("Unexpected owner review destination");
  return result;
}
export function validateEnrollmentPoll(raw:unknown,review:EnrollmentReview,now=Date.now()) {
  const result=poll.parse(raw);expiry(result.expiresAt,review,now);
  if(result.status==="approved") {
    for(const key of ["authorityId","deviceId","sourceWorkspace","principal","publicKey"] as const)
      if(result.request[key]!==review[key])throw Error("Owner challenge changed reviewed device");
    if(Math.abs(now-result.request.issuedAt)>15000)throw Error("Stale owner challenge");
  }
  return result;
}

const digest = (v:unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const credential = (key:string) => {
  const parsed=createPublicKey(key);
  if(parsed.asymmetricKeyType!=="ed25519")throw Error("Expected Ed25519 device key");
  const pem=parsed.export({type:"spki",format:"pem"}).toString();
  return {pem,id:createHash("sha256").update(pem).digest("hex")};
};
export function validateEnrollmentComplete(raw:unknown,review:EnrollmentReview,challenge:unknown,now=Date.now()) {
  const request=runtimeEnrollmentSchema.parse(challenge);
  validateEnrollmentPoll({status:"approved",request,expiresAt:new Date(review.expiresAt).toISOString()},review,now);
  if(digest(request)!==review.enrollmentRequestDigest)throw Error("Unreviewed completion challenge");
  const key=credential(review.publicKey);
  const binding={version:1,ownerProfileId:request.profileId,ownerWallet:review.ownerWallet,
    authorityId:review.authorityId,deviceId:review.deviceId,principal:review.principal,credentialId:key.id,
    sourceWorkspace:review.sourceWorkspace,tenant:"roles:"+request.profileId,workspace:"crm:"+review.sourceWorkspace};
  const expected={status:"complete",result:{principal:review.principal,credentialId:key.id,publicKey:key.pem,
    binding,runtimeBindingDigest:digest(binding),permissionsGranted:false}};
  if(canonical(raw)!==canonical(expected))throw Error("Enrollment completion differs from reviewed device");
  return expected;
}
/** Pinned signer must come from reviewed native configuration, never response/model input. */
export function validateEnrollmentAttestation(raw:unknown,review:EnrollmentReview,challenge:unknown,pinnedSigner:string,now=Date.now()) {
  const envelope=z.strictObject({request:runtimeAttestationSchema,signature:z.string().min(1).max(200)}).parse(raw);
  const request=runtimeEnrollmentSchema.parse(challenge),a=envelope.request;
  validateEnrollmentPoll({status:"approved",request,expiresAt:new Date(review.expiresAt).toISOString()},review,now);
  if(digest(request)!==review.enrollmentRequestDigest||a.purpose!=="enroll"||a.requestDigest!==digest(request)||
    a.issuedAt>now+1000||a.issuedAt<now-30000||a.expiresAt<=now||a.expiresAt<=a.issuedAt||a.expiresAt-a.issuedAt>30000)
    throw Error("Invalid enrollment attestation lifetime or challenge");
  for(const k of ["authorityId","deviceId","principal","sourceWorkspace","ownerWallet"] as const)
    if(a[k]!==review[k])throw Error("Attestation device mismatch");
  if(a.credentialId!==credential(review.publicKey).id)throw Error("Attestation credential mismatch");
  const signer=createPublicKey(pinnedSigner);
  if(signer.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(runtimeAttestationMessage(a)),signer,Buffer.from(envelope.signature,"base64")))
    throw Error("Attestation signature rejected");
  return envelope;
}
