# Native enrollment transport preparation

This implementation is inactive. Nothing imports it from the companion startup,
Swift launcher, or public API. It does not change the running app's offline policy,
create a grant, or enroll a device. Enrollment alone grants no workflow permissions.

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
never falls back to remote fetch, and activation is rejected before signing. No
startup caller supplies this option yet. Existing deployments retain their prior
transport until the reviewed native consent and lifecycle wiring is installed.

## Required native integration

The native owner must obtain explicit, bounded consent and current source authority,
provide a pinned signer and existing encrypted credentials, and enforce cost scope.
Neither model output nor a broker request may create a review, choose a signer,
change identity, extend a deadline, or supply credentials. Keep the helper outside
of the model sandbox while preserving the core's existing egress restrictions.

Before installation, integrate the native owner UI and lifecycle, verify helper
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
