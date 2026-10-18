import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  agent = z
    .string()
    .regex(/^agent:[a-f0-9-]{36}$/)
    .refine((v) => z.uuid().safeParse(v.slice(6)).success);
export const runtimeEnrollmentSchema = z.strictObject({
  version: z.literal(1),
  audience: z.literal("https://mcp.bittrees.org"),
  profileId: z.uuid(),
  principal: agent,
  publicKey: z.string().max(300),
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  sourceWorkspace: z.uuid(),
  issuedAt: z.int(),
  nonce: z.uuid(),
});
export const leaseActivationSchema = z.strictObject({
  version: z.literal(1),
  audience: z.literal("https://roles.bittrees.org"),
  leaseId: z.uuid(),
  policyDigest: hash,
  principal: agent,
  credentialId: hash,
  runtimeBindingDigest: hash,
  issuedAt: z.int(),
  nonce: z.uuid(),
});
export const runtimeAttestationSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://ai.bittrees.org"),
  audience: z.literal("https://roles.bittrees.org"),
  purpose: z.enum(["enroll", "activate", "decision"]),
  requestDigest: hash,
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  principal: agent,
  credentialId: hash,
  sourceWorkspace: z.uuid(),
  issuedAt: z.int(),
  expiresAt: z.int(),
  nonce: z.uuid(),
});
export const runtimeEnrollmentMessage = (r: unknown) =>
  "Bittrees local AI enrollment v1\n" + canonical(r);
export const leaseActivationMessage = (r: unknown) =>
  "Bittrees MCP lease activation v1\n" + canonical(r);
export const runtimeAttestationMessage = (r: unknown) =>
  "Bittrees AI registered device attestation v1\n" + canonical(r);
export const activationReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    issuer: z.literal("https://roles.bittrees.org"),
    sourceWorkspace: z.uuid(),
    audience: z.literal("https://mcp.bittrees.org"),
    leaseId: z.uuid(),
    policyDigest: hash,
    principal: agent,
    credentialId: hash,
    runtimeBindingDigest: hash,
    tenant: z.string().min(1).max(128),
    workspace: z.string().min(1).max(128),
    activatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    renewable: z.literal(false),
  })
  .refine(
    (r) =>
      Date.parse(r.expiresAt) > Date.parse(r.activatedAt) &&
      Date.parse(r.expiresAt) - Date.parse(r.activatedAt) <= 3600000,
    "Invalid activation interval",
  );
export const activationReceiptMessage = (r: unknown) =>
  "Bittrees MCP lease activation receipt v1\n" + canonical(r);
const handoffBase = runtimeEnrollmentSchema
  .omit({ profileId: true })
  .extend({ ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/) });
export const runtimeHandoffSchema = z.discriminatedUnion("kind", [
  handoffBase.extend({ kind: z.literal("enroll") }),
  handoffBase.extend({
    kind: z.literal("activate"),
    leaseId: z.uuid(),
    policyDigest: hash,
    runtimeBindingDigest: hash,
  }),
]);
export const runtimeHandoffMessage = (r: unknown) =>
  "Bittrees native runtime handoff v1\n" + canonical(r);
