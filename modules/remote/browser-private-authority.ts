import { browserLifecycleSchema } from "./browser-key-state.js";
import { browserEndpointRecordSchema } from "./browser-endpoint-keys.js";
import type { BrowserKeyProof } from "./browser-key-lifecycle.js";
import {
  browserPeerRecordSchema,
  type BrowserPeerProof,
} from "./browser-peer-state.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Pure checks over rows read in the caller's *same* transaction as publication.
 * These are not cached proof validation or substitutes for verified host identity. */
export function browserStoredKeyMatches(
  metadata: unknown,
  slot: unknown,
  owner: string,
  scope: string,
  key: BrowserKeyProof,
) {
  const state = browserLifecycleSchema.parse(metadata),
    selected = state.slots.find((s) => s.state === "active"),
    row = browserEndpointRecordSchema.parse(slot);
  return (
    state.scope === scope &&
    !state.locked &&
    state.revision === key.revision &&
    state.ownerId === key.binding.ownerId &&
    state.deviceId === key.binding.deviceId &&
    !!selected &&
    selected.id === key.keyId &&
    selected.keyEpoch === key.keyEpoch &&
    selected.publicKey === key.publicKey &&
    same(selected.binding, key.binding) &&
    row.scope === scope &&
    row.keyId === key.keyId &&
    row.state === "ready" &&
    row.identity.localOwner === owner &&
    row.identity.keyId === key.keyId &&
    row.identity.keyEpoch === key.keyEpoch &&
    same(row.identity.binding, key.binding) &&
    row.publicKey === key.publicKey &&
    !!row.recovery &&
    row.privateHandle instanceof CryptoKey &&
    row.privateHandle.type === "private" &&
    !row.privateHandle.extractable
  );
}
export function browserStoredPeerMatches(
  raw: unknown,
  scope: string,
  proof: BrowserPeerProof,
) {
  const record = browserPeerRecordSchema.parse(raw),
    pin = record.state?.peers.find((p) => p.peerId === proof.peerId);
  return (
    record.scope === scope &&
    !record.locked &&
    record.revision === proof.revision &&
    same(record.key, proof.key) &&
    !!pin &&
    !pin.revoked &&
    pin.keyEpoch === proof.keyEpoch &&
    pin.fingerprint === proof.fingerprint
  );
}
