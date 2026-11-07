import { z } from "zod";
import { requestSchema } from "./proof-contract.js";

/** Registration-attestation request only. Roles and each source still decide
 * execution authority; accepting this schema creates no grant or lease. */
export const assignmentAuthorityRequest = requestSchema.extend({
  project: z.literal("workflow"),
  resource: z.string().regex(/^workflow:[a-zA-Z0-9_-]{1,128}$/),
  action: z.enum(["workflow:claim", "workflow:complete"]),
});
