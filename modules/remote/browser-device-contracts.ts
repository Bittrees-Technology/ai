import { z } from "zod";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const browserRegistrationSchema = z.strictObject({
  binding: privateBindingSchema,
  createdAt: positive,
  revokedAt: positive.nullable(),
});
export const browserDeviceInspectionSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.uuid(),
  sessionExpiresAt: positive,
  registration: browserRegistrationSchema.nullable(),
});
export const browserDeviceIdentitySchema = z.strictObject({
  version: z.literal(1),
  binding: privateBindingSchema,
  sessionExpiresAt: positive,
});
export const browserDeviceRegisterSchema = z.strictObject({
  operationId: z.uuid(),
  expected: z
    .strictObject({ deviceId: z.uuid(), credentialEpoch: positive })
    .nullable(),
  confirmed: z.literal(true),
});
export const browserDeviceRevokeSchema = z.strictObject({
  deviceId: z.uuid(),
  credentialEpoch: positive,
  confirmed: z.literal(true),
});
export const browserDevicePageSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.uuid(),
  items: z.array(browserRegistrationSchema).max(50),
  nextCursor: z.uuid().nullable(),
});
export type BrowserDeviceIdentity = z.infer<typeof browserDeviceIdentitySchema>;
export interface VerifiedBrowserDeviceScope {
  current(): PrivateBinding | null;
  /** Only an explicitly observed registration in this host instance qualifies.
   * A storage record, ordinary identity response or recovery kit cannot qualify. */
  freshRegistration(binding: PrivateBinding): boolean;
}
