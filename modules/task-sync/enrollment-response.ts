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
