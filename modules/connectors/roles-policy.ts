import { createHash } from "node:crypto";
import { z } from "zod";
import { ConnectorError } from "./crm.js";
const name = z.string().min(1).max(128);
const item = z.strictObject({
  grantId: name,
  subject: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("profile"), reference: z.uuid() }),
    z.strictObject({
      kind: z.literal("wallet"),
      reference: z.string().regex(/^0x[a-f0-9]{40}$/),
    }),
    z.strictObject({
      kind: z.literal("email"),
      reference: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
  roleId: name,
  scope: name,
  domain: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9-]+\.)*bittrees\.eth$/),
  authorityMode: z.enum([
    "roles-authoritative",
    "project-authoritative",
    "observation-only",
  ]),
  actions: z.array(name).min(1).max(100),
  resources: z.array(z.string().min(1).max(240)).min(1).max(100),
  expiresAt: z.iso.datetime(),
  status: z.enum([
    "expired",
    "suspended",
    "source_owned",
    "wallet_required",
    "recorded_current",
  ]),
  authorityConfirmed: z.enum(["recorded_in_current_policy", "not_confirmed"]),
  effectiveAccess: z.literal("not_verified"),
  enforcementAcknowledged: z.literal("not_verified"),
  executable: z.literal(false),
  manageUrl: z.literal("https://roles.bittrees.org/profile"),
});
const response = z.strictObject({
  grantId: z.uuid(),
  expiresAt: z.iso.datetime(),
  policyRevision: z.literal("roles-ai-own-access-v2"),
  projection: z.strictObject({
    contractVersion: z.literal("1.0.0"),
    profileId: z.uuid(),
    mode: z.literal("own_policy_records"),
    checkedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    policyStatus: z.enum(["absent", "expired", "current"]),
    policyRevision: z.int().positive().nullable(),
    policyExpiresAt: z.iso.datetime().nullable(),
    items: z.array(item).max(200),
    coverage: z.literal(
      "Stored policy grants for verified linked identities and this personal profile only. Agent/service grants, delegations and downstream enforcement are not included.",
    ),
    grantAuthority: z.literal(false),
    projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
/** Validate explanations only; this contract never grants executable authority. */
export function validateOwnPolicy(
  raw: unknown,
  grant: { grantId: string; profileId: string; expiresAt: string },
  now: number,
) {
  const parsed = response.safeParse(raw);
  const invalid = () => {
    throw new ConnectorError("INVALID_SOURCE");
  };
  if (!parsed.success) return invalid();
  const result = parsed.data,
    { projectionHash, ...p } = result.projection;
  const checked = Date.parse(p.checkedAt),
    valid = Date.parse(p.validUntil),
    policyExpiry =
      p.policyExpiresAt === null ? null : Date.parse(p.policyExpiresAt);
  if (
    result.grantId !== grant.grantId ||
    result.expiresAt !== grant.expiresAt ||
    p.profileId !== grant.profileId ||
    checked > now + 30000 ||
    checked < now - 15000 ||
    valid <= now ||
    valid <= checked ||
    valid > checked + 15000 ||
    valid > now + 15000 ||
    Buffer.byteLength(JSON.stringify(p)) > 262144 ||
    createHash("sha256").update(JSON.stringify(p)).digest("hex") !==
      projectionHash
  )
    return invalid();
  if (p.policyStatus === "absent") {
    if (p.policyRevision !== null || policyExpiry !== null || p.items.length)
      return invalid();
  } else {
    if (
      p.policyRevision === null ||
      policyExpiry === null ||
      (p.policyStatus === "current"
        ? policyExpiry <= now || valid > policyExpiry
        : policyExpiry > checked)
    )
      return invalid();
  }
  const ids = new Set<string>();
  for (const row of p.items) {
    const expiry = Date.parse(row.expiresAt);
    if (
      ids.has(row.grantId) ||
      (row.subject.kind === "profile" &&
        row.subject.reference !== grant.profileId) ||
      policyExpiry === null ||
      expiry > policyExpiry ||
      (row.status === "expired"
        ? expiry > checked
        : expiry <= now || valid > expiry) ||
      (row.authorityConfirmed === "recorded_in_current_policy") !==
        (row.status === "recorded_current") ||
      (["recorded_current", "wallet_required"].includes(row.status) &&
        row.authorityMode !== "roles-authoritative") ||
      (row.status === "source_owned" &&
        row.authorityMode === "roles-authoritative") ||
      (row.status === "wallet_required" && row.subject.kind === "wallet")
    )
      return invalid();
    ids.add(row.grantId);
  }
  return result;
}
