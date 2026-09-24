import { z } from "zod";
import type { PrivateBinding } from "./private-peer-contracts.js";
import type { PrivateRelayIdentity } from "./private-relay-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const privateRelayGrantSchema = z
  .strictObject({
    id: z.uuid(),
    ownerId: z.uuid(),
    endpointKind: z.enum(["browser", "mac"]),
    endpointId: z.uuid(),
    credentialEpoch: positive,
    operationId: z.uuid(),
    revision: positive,
    state: z.enum(["pending", "active", "revoked"]),
    createdAt: positive,
    expiresAt: positive,
    approvalExpiresAt: positive.nullable(),
    revokedAt: positive.nullable(),
  })
  .refine(
    (g) =>
      g.createdAt < g.expiresAt &&
      (g.state === "pending") === (g.approvalExpiresAt !== null) &&
      (g.state === "revoked") === (g.revokedAt !== null) &&
      (g.endpointKind !== "browser" || g.state !== "pending") &&
      (g.approvalExpiresAt === null ||
        (g.approvalExpiresAt > g.createdAt &&
          g.approvalExpiresAt <= g.expiresAt)) &&
      (g.revokedAt === null || g.revokedAt >= g.createdAt),
  );
export type PrivateRelayGrant = z.infer<typeof privateRelayGrantSchema>;
export const privateRelayAcceptanceSchema = z.strictObject({
  grant: privateRelayGrantSchema,
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scope: z.literal("private:relay"),
});
export const privateRelayRevisionSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: positive,
  confirmed: z.literal(true),
});
export const privateRelayApprovalSchema = z.strictObject({
  operationId: z.uuid(),
  expected: z.strictObject({ id: z.uuid(), revision: positive }).nullable(),
  expiresAt: positive,
  confirmed: z.literal(true),
  deviceId: z.uuid(),
  credentialEpoch: positive,
});
export const privateRelayEndpointSchema = z.strictObject({
  ownerId: z.uuid(),
  endpointKind: z.enum(["browser", "mac"]),
  endpointId: z.uuid(),
  credentialEpoch: positive,
  expiresAt: positive,
});
export const privateRelayEndpointLookupSchema = privateRelayEndpointSchema.omit(
  { ownerId: true, expiresAt: true },
);
export const privateRelayEndpointInspectionSchema = z
  .strictObject({
    endpoint: privateRelayEndpointSchema,
    permission: privateRelayGrantSchema.nullable(),
  })
  .refine(
    (v) =>
      !v.permission ||
      (v.permission.ownerId === v.endpoint.ownerId &&
        v.permission.endpointId === v.endpoint.endpointId &&
        v.permission.endpointKind === v.endpoint.endpointKind &&
        v.permission.state !== "revoked"),
  );
export const privateRelayPermissionPageSchema = z.strictObject({
  after: z.uuid().nullable(),
  limit: z.number().int().min(1).max(50),
});
/** Internal native-host bridge only. No status credential is exposed; the relay
 * secret returned by accept belongs exclusively in the native custody layer. */
export interface PrivateRelayEnrollmentScope {
  current(): PrivateBinding | null;
  inspect(id: string): Promise<PrivateRelayGrant>;
  accept(raw: unknown): Promise<z.infer<typeof privateRelayAcceptanceSchema>>;
  identifyRelay(credential: string): Promise<PrivateRelayIdentity>;
  revokeRelay(credential: string, raw: unknown): Promise<PrivateRelayGrant>;
}
export interface PrivateRelayEnrollment {
  withPrivateRelayEnrollment<T>(
    action: (scope: PrivateRelayEnrollmentScope) => Promise<T>,
  ): Promise<T>;
}
