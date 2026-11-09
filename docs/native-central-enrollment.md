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

Choose “Set up Workflows…” in the Mac app menu to open the guided connection
page. “Review this Mac” opens a native sheet with the exact identity, source
scope and spending disclosure. Included usage remains exactly US$0. Explicit spending displays the
same aggregate allowance shared by enrollment, Workflows, CRM assignments and
attestations, along with its approval reference and aggregate attempt limit.
Changing any funded review invalidates consent. The native review ends after at
most five minutes and never outlives the funding window. The Mac parser independently
checks Node's digest, canonical Ed25519 public key, identity purpose, destinations,
limits and both cost modes. A paid review cannot be presented as a zero-cost one.

The shared funding guard supports an explicitly approved total of at most US$10
and a fixed funding window of at most four hours. Those are supported bounds,
not default approval. The native display shows the actual amount and funding
deadline. Enrollment consent still lasts at most five minutes; a longer funding
window does not enroll a device, extend a work lease or reset task retries. An
existing ledger review remains immutable under its original approval reference.

## Typed owner flow

After native consent, the core receives only a purpose-specific loopback capability
at `/central-enrollment`. Its strict commands are `status`, `start` and `poll`;
there are no caller-provided identities, requests, challenges, signatures or secrets.
The native consent token is never forwarded to the core. The legacy `/enrollment`
client cannot use this capability.

The connection page opens the native sheet through the main frame of the
installed Mac app's local dashboard. The bridge accepts an empty request and
returns the consent outcome. The page sends one typed start command after
confirmed consent and a fresh local status check. It links to the original Roles
review and offers “Confirm connection” after the owner returns. If the start
reply is uncertain, “Check connection status” reads local state before another
action is offered. Roles derives the profile from the authenticated owner
session. Other sync settings remain under a separate disclosure.

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

## Separate native gateway credential preparation

After completed central-purpose enrollment, “Prepare Workflows gateway…” offers
a separate sixty-second native review of the exact owner, device, central key,
CRM workspace and derived runtime binding. It reads the authenticated encrypted
original native handoff, rather than trusting an operator draft or a core status
projection. Missing, unfinished, inconsistent or changed enrollment fails closed.
The native control capability is not forwarded to the core or web content.

Approval prepares one new random gateway bearer in protected encrypted
`native-central-gateway.db`. Only its public hash and
`native-central-gateway:<hash>` reference are shown. Repeating a preparation after
a lost reply or restart retains the same bearer. A changed binding or corrupt
record cannot trigger rotation or replacement. Cancelled or expired consent
cannot release a credential. Existing central signing and coordinator/task-sync
credentials are preserved; none is substituted for the gateway bearer.

A separately reviewed central configuration may use that public reference in
`mcpToken`. The native saved-state reader resolves it only against the completed
enrollment's exact principal, signing-key fingerprint and tenant/workspace. Its
public state digest pins the actual gateway hash. The model/core configuration
does not need the bearer. Missing native transport cannot authenticate a public
reference against MCP. Existing native admission, finite request/model budgets,
Roles action proofs and source checks still apply to each protected operation.

Preparation is local-only and does not register an MCP actor, create a source
connection, activate a Roles lease, configure a worker, start finite task clocks
or enable live sync. The public preparation receipt is not current source or
workflow authority. Those exact permissions and the server's hash binding must
be separately approved and verified before task execution.
