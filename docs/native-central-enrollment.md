# Native central Workflows enrollment

The optional central-purpose enrollment path uses the existing encrypted identity
in `central-workflows.db`. It does not create a key, read the task-sync signing
identity, copy a credential between stores, activate a lease or grant permissions.
Missing configuration leaves both capabilities off. Source/operator preparation,
native consent, Roles owner approval, runtime enrollment, MCP connection custody,
controller-approved execution scope and source grants remain separate gates.

## Protected setup and native review

The operator must independently verify current existing device authority, owner
wallet and CRM/source workspace before preparing owner-only `native-enrollment.json`.
For this path, set `purpose: "central-workflows"`, with the verified central
`principal`, `credentialId` fingerprint and exact `sourceWorkspace`. The public key
is read and verified inside the native helper. No Roles profile UUID, raw key or
caller-selected signing message is accepted. The legacy task-sync configuration
retains its separate identity digest and store; neither mode falls back to the other.

Common setup still pins authority/device IDs, owner wallet, the existing native
coordinator credential digest, source admission, evidence and finite current
budget. A file/hash is not evidence of those facts or source consent. The
coordinator bearer stays native and is used only for the fixed AI registration
endpoint. It must never be installed as the central MCP bearer. This implementation
does not discover missing owner/source bindings or write an activation package.

“Connect workflows…” displays the exact identity, source scope and spending
disclosure. Included usage remains exactly US$0. Explicit spending displays the
same aggregate allowance shared by enrollment, Workflows, CRM assignments and
attestations, along with its approval reference and aggregate attempt limit.
Changing any funded review invalidates consent. The native review ends after at
most five minutes and never outlives the funding window. The Mac parser independently
checks Node's digest, canonical Ed25519 public key, identity purpose, destinations,
limits and both cost modes. A paid review cannot be presented as a zero-cost one.

## Typed owner flow

After native consent, the core receives only a purpose-specific loopback capability
at `/central-enrollment`. Its strict commands are `status`, `start` and `poll`;
there are no caller-provided identities, requests, challenges, signatures or secrets.
The native consent token is never forwarded to the core. The legacy `/enrollment`
client cannot use this capability.

The Permissions & sync view requests the owner review, links only to the exact
Roles runtime-request URL, and lets the owner check the original review after
approval. Refreshing local status makes no provider request. There is no new
background source poller. Roles derives the profile from its authenticated owner
session; the model and operator do not invent it.

The existing fixed-host TLS/DNS transport and independent response verifier remain
in use. Before start or another owner poll, a bounded native heartbeat verifies
the exact current signed device authority, wallet and device, including remote
pause/revocation/expiry. Its private activity payload is discarded inside the
native helper. The native helper signs only the exact central handoff and authenticated
Roles challenge with the existing central key. The approved challenge must come
from the encrypted native session, not from core input. The core receives a strict
public status/result projection, never a polling secret, control bearer or private key.
An enrollment receipt explicitly reports `permissionsGranted: false`.

## Durable recovery

`native-central-enrollment.db` is separate from legacy task-sync enrollment state.
It keeps an encrypted start marker before dispatch and the original candidate,
owner request and native session/journal. A fresh native-review epoch may continue
the original session only under the same identity/device/source binding and its
original earlier deadline. It cannot create another start or restore allowance.

A lost start reply without a verified cached receipt stays held for reconciliation.
A source reply verified by the native session but not saved by the outer handoff
can be recovered from that original cache without another POST. A lost completion
reply is reconciled by polling the original owner request. That authenticated read
can confirm the exact persisted completed receipt after the challenge's short
mutation lifetime; it cannot authorize another completion mutation. The original
mutation ID/body digest is retained when its journal is confirmed. Changed bindings,
missing persisted challenge/reservation, expired original reviews, conflicting
receipts or revocation stop the flow. Failed/uncertain wire reservations are not refunded.

This is enrollment coverage, not live CRM task acceptance. Source grants, lease
activation, protected MCP connection issuance, approved real assignments, independent
result validation and sustained installed execution still require their own evidence.
The original nine CryptoDirectory receipt pairs and exhausted budgets are unaffected;
they must not be used as fixtures or reset to demonstrate this path.
