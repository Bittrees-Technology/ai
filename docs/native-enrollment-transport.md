# Native enrollment transport preparation

The production helper is not configured or launched. Companion startup accepts an
optional execution capability and Swift includes a conditional native consent
dialog, but the native launcher supplies capabilities only after protected operator configuration passes validation. No offline policy change,
grant or enrollment occurs by default. Enrollment grants no workflow permissions.

## Prepared components

- A five-minute, device-bound operation planner permits only heartbeat, enrollment
  start, polling, enrollment attestation, and completion. Activation, catalogue
  sync, MCP execution, arbitrary URLs and headers are excluded.
- The encrypted session assembles the planner, response verifier and durable
  mutation journal. Budgets survive restart. An exclusive owner file prevents
  competing instances; a stale owner requires explicit reconciliation. Unknown
  mutation outcomes are held rather than automatically replayed.
- Response validation binds the owner challenge, device identity, credential and
  completion digest, requires `permissionsGranted: false`, and verifies AI
  attestations with an independently configured Ed25519 public key.
- The HTTPS adapter accepts only exact AI/Roles enrollment endpoints, verifies TLS
  hostname/certificates, pins a validated public IPv4 DNS answer, and rejects
  redirects, compression, oversized responses and private/mixed addresses.
  Cancellation ends the caller's DNS wait; an unresolved OS lookup prevents another
  lookup on that adapter until it settles. It cannot cancel the OS resolver itself.
- The optional loopback broker has no session-creation route. A trusted native
  owner must supply the already-reviewed session and a random capability. It denies
  browser origins/cookies, wrong hosts, unsupported operations and excess payloads.

The inactive owner lifecycle now snapshots the approved review, checks current
authority before creating a session, cancels work on explicit revocation or expiry,
and drains pending work before releasing encrypted storage. Native code must call
`revoke()` immediately on an owner/source revocation event and `close()` on teardown.
The lifecycle does not subscribe to remote authority changes or obtain consent.
An injected operation that ignores cancellation prevents storage release; it must
remain held rather than releasing the exclusive owner while work is still running.

The task-sync runner and existing Roles handoff accept an optional typed enrollment
client. When supplied, start/poll/attest/complete use only that client, failed IPC
never falls back to remote fetch, and activation is rejected before signing. Core
startup supplies this option only when the native execution capability is present.
The native consent capability is excluded from the child engine environment.
The native launcher provides these capabilities only when the bounded operator configuration is present and valid.

## Native consent preparation

The separate control port accepts only propose, exact-digest approval and revoke
with a different capability from execution. Its trusted identity and cost callbacks
are supplied by native code, never request data. The five-minute review cannot be
extended. The service creates a session only after approval and drains it on revoke;
an uncertain storage close holds future sessions for reconciliation.

The Swift dialog validates the helper proposal digest, identity, destinations,
limits and expiry before showing the owner details. Cancel is the default. The
Foundation parser is tested against an actual Node-generated proposal. This does
not prove interactive UI acceptance or production authority. Both native and core
capabilities must stay private; the native capability must never reach model/core.

## Required native integration

The native owner must obtain explicit, bounded consent and current source authority,
provide a pinned signer and existing encrypted credentials, and enforce cost scope.
Neither model output nor a broker request may create a review, choose a signer,
change identity, extend a deadline, or supply credentials. Keep the helper outside
of the model sandbox while preserving the core's existing egress restrictions.

Before installation, configure the trusted production helper and launcher, verify helper
startup/shutdown and revocation, and exercise the actual staged sandbox boundary.
Do not enable an endpoint merely because the library or package tests pass.

No until-revoked workflow execution, central claim/completion, successor dispatch,
or live Roles authorization is established by these components. Those require
separate scoped integration and actual source/model receipts after owner approval.

## Validation and limitations

Tests use temporary encrypted stores, synthetic owner/device proofs, ephemeral
attestation keys, injected source responses, loopback HTTP and a temporary TLS
certificate. TLS trust is supplied to that test request only; system trust is not
modified. No production credentials or remote services are needed.

The complete-flow fixture proves component behavior, not production enrollment.
A crash between a source mutation and local receipt persistence leaves a held
operation. No automatic stale-lock removal or unknown-mutation retry is provided.
Source reconciliation must precede any operator recovery. Preserve saved journal
and session data when diagnosing these holds.

## Trusted native storage assembly

`nativeEnrollmentSessionFactory` connects the fixed HTTPS adapter to encrypted
session storage. It requires a canonical independently pinned Ed25519 public key,
an absolute storage path, an existing vault and credential provider, and current
source/cost admission. Construction sends no requests. Admission and the exact
approved scope are rechecked before dispatch.

`savedEnrollmentIdentity` reads existing encrypted task identity and workspace
metadata in one read-only transaction. It does not create keys or reviews and
returns no private key. Saved workspace metadata is not source authorization.
`existingEnrollmentCredential` reads the existing encrypted connection with the
same coordinator-first precedence as the app. An unavailable or invalid preferred
credential never falls back to another identity. Supplied vaults must already be
unlocked; these readers do not invoke Keychain or change credential access.

The native launcher now assembles these components conditionally. They do not
establish current server configuration, cost approval, owner approval, installation
or live workflow execution. Tests use temporary synthetic encrypted state.

## Native launcher configuration

With no `native-enrollment.json` in the existing app data directory, startup does
not open enrollment sockets or read enrollment Keychain entries. With configuration,
the launcher requires a current owner-only regular file, exact identity and credential
digests, explicit source approval and an independently established included-usage
evidence reference. The configuration lasts at most one hour; each native approval
still lasts only five minutes. Unknown cost basis fails closed. The installed app
does not generate this approval file or claim billing evidence on its own.

The helper uses the public AI signer matched independently to the recorded
deployment. It reads existing vault keys only; it never creates replacement keys.
Changing/removing configuration or changing saved identity/credential bytes prevents
further dispatch. Missing or held enrollment configuration does not stop the existing
NAS, storage or cloud helper. Source authority and wallet review remain server-owned;
this enrollment-only helper cannot activate a lease or execute central tasks.
