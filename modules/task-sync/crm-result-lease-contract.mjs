// Frozen cross-service Workflows -> CRM result lease proof v1.
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
const fail = (message, status = 403) =>
  Object.assign(Error(message), { status });
const hex = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.uuid();
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  throw Error("Invalid signed payload");
}
function verifyEd25519(message, signature, pem) {
  try {
    const key = createPublicKey(pem);
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"))
    );
  } catch {
    return false;
  }
}
export const crmResultLeaseProof = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://workflow.bittrees.org"),
  audience: z.literal("https://crm.bittrees.org"),
  kind: z.literal("crm-result-lease"),
  state: z.enum(["running", "completed"]),
  assignmentDigest: hex,
  connectionId: uuid,
  runId: uuid,
  leaseId: uuid,
  crmOperationId: uuid,
  operation: z.enum(["write", "receipt", "complete", "completion"]),
  authorityOperationId: uuid,
  resultDigest: hex,
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  credentialId: hex,
  runtimeLeaseId: uuid,
  runtimeBindingDigest: hex,
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  authorityRequestId: uuid,
  issuedAt: z.int().positive(),
  expiresAt: z.int().positive(),
});
export const crmResultLeaseMessage = (proof) =>
  "Bittrees Workflows CRM result lease v1\n" + canonical(proof);
export function verifyCrmResultLease(
  envelope,
  expected,
  publicKey,
  now = Date.now(),
) {
  const packet = z
    .strictObject({
      proof: crmResultLeaseProof,
      signature: z.string().min(1).max(128),
    })
    .parse(envelope);
  const p = packet.proof;
  if (
    p.issuedAt > now + 1000 ||
    p.expiresAt <= now ||
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > 5000 ||
    !verifyEd25519(crmResultLeaseMessage(p), packet.signature, publicKey)
  )
    throw fail("Workflow result lease proof rejected.");
  const scope = crmResultLeaseProof
    .omit({
      version: true,
      issuer: true,
      audience: true,
      kind: true,
      issuedAt: true,
      expiresAt: true,
    })
    .parse(expected);
  for (const [key, value] of Object.entries(scope))
    if (!Object.hasOwn(p, key) || p[key] !== value)
      throw fail("Workflow result lease binding changed.");
  return p;
}
