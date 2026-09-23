import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const privatePeerPinSchema = z.strictObject({
  peerId: z.uuid(),
  keyEpoch: positive,
  publicKey: z.string().length(87),
  keyHash: hex,
  fingerprint: hex,
  approvedAt: positive,
  revoked: z.boolean(),
});
export const privatePeerStateSchema = z
  .strictObject({
    binding: privateBindingSchema,
    peers: z.array(privatePeerPinSchema).max(20),
    retired: z
      .array(
        z.strictObject({ peerId: z.uuid(), keyEpoch: positive, keyHash: hex }),
      )
      .max(512),
  })
  .refine(
    (s) =>
      new Set(s.peers.map((p) => p.peerId)).size === s.peers.length &&
      new Set(s.retired.map((p) => p.keyHash)).size === s.retired.length,
  );
export type PrivatePeerState = z.infer<typeof privatePeerStateSchema>;
