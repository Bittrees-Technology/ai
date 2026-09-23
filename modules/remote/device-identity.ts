import { z } from "zod";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";

/** Credential identity only. This response grants no content or operation scope. */
export const deviceIdentitySchema = privateBindingSchema.extend({
  version: z.literal(1),
});
export interface VerifiedDeviceScope {
  /** Fresh copies, valid only during the bounded verified operation. */
  current(): PrivateBinding | null;
}
