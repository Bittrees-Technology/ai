import { z } from "zod";
import {
  browserKeyProofSchema,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import { privatePeerStateSchema } from "./private-peer-state.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const browserPeerRecordSchema = z
  .strictObject({
    scope: hex,
    revision: positive,
    deviceAnchor: hex,
    locked: z.boolean(),
    key: browserKeyProofSchema.nullable(),
    state: privatePeerStateSchema.nullable(),
  })
  .refine((r) =>
    r.locked
      ? r.key === null && r.state === null
      : !!r.key && !!r.state && same(r.key.binding, r.state.binding),
  );
export type BrowserPeerRecord = z.infer<typeof browserPeerRecordSchema>;
export type BrowserPeerProof = {
  revision: number;
  key: BrowserKeyProof;
  peerId: string;
  keyEpoch: number;
  fingerprint: string;
};
export const browserPeerProofSchema = z.strictObject({
  revision: positive,
  key: browserKeyProofSchema,
  peerId: z.uuid(),
  keyEpoch: positive,
  fingerprint: hex,
});
