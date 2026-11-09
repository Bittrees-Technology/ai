import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
export const centralEnrollmentCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("poll") }),
  z.strictObject({ action: z.literal("reconcile") }),
]);
const agent = z.string().regex(/^agent:[a-f0-9-]{36}$/),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
const reviewUrl = z.string().refine((raw) => {
  try {
    const u = new URL(raw);
    return (
      u.origin === "https://roles.bittrees.org" &&
      u.pathname === "/profile" &&
      [...u.searchParams.keys()].join(",") === "runtimeRequest" &&
      z.uuid().safeParse(u.searchParams.get("runtimeRequest")).success &&
      !u.hash &&
      !u.username &&
      !u.password &&
      u.href === raw
    );
  } catch {
    return false;
  }
});
const binding = z.strictObject({
  version: z.literal(1),
  ownerProfileId: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  principal: agent,
  credentialId: hex,
  sourceWorkspace: z.uuid(),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
});
export const centralEnrollmentStatus = z
  .strictObject({
    purpose: z.literal("central-workflows"),
    principal: agent,
    credentialId: hex,
    sourceWorkspace: z.uuid(),
    permissionsGranted: z.literal(false),
    originalReviewExpiresAt: z.int().positive(),
    originalReviewExpired: z.boolean(),
    reconciliation: z.enum(["not-committed", "committed"]).optional(),
    state: z.union([
      z.strictObject({ status: z.literal("not-started") }),
      z.strictObject({
        status: z.literal("held"),
        message: z.string().max(256),
      }),
      z.strictObject({
        kind: z.literal("enroll"),
        status: z.enum([
          "pending",
          "approved",
          "complete",
          "expired",
          "failed",
        ]),
        reviewUrl,
        expiresAt: z.iso.datetime(),
        message: z.string().max(256).optional(),
      }),
    ]),
    enrollment: z
      .strictObject({
        principal: agent,
        credentialId: hex,
        publicKey: z.string().max(512),
        binding,
        runtimeBindingDigest: hex,
        permissionsGranted: z.literal(false),
      })
      .nullable(),
  })
  .refine((value) => {
    if (value.reconciliation && !value.originalReviewExpired) return false;
    if (
      value.reconciliation &&
      (value.reconciliation === "committed") !== (value.enrollment !== null)
    )
      return false;
    if ((value.state.status === "complete") !== (value.enrollment !== null))
      return false;
    const e = value.enrollment;
    return (
      !e ||
      (e.principal === value.principal &&
        e.credentialId === value.credentialId &&
        e.binding.principal === value.principal &&
        e.binding.credentialId === value.credentialId &&
        e.binding.sourceWorkspace === value.sourceWorkspace &&
        createHash("sha256").update(e.publicKey).digest("hex") ===
          e.credentialId &&
        createHash("sha256").update(canonical(e.binding)).digest("hex") ===
          e.runtimeBindingDigest)
    );
  }, "Central enrollment receipt must match the displayed identity and source binding");
export type CentralEnrollmentStatus = z.infer<typeof centralEnrollmentStatus>;
