# Native workflow readiness

The Mac permissions page first reads the authenticated local endpoint
`GET /v1/workflows/readiness`. This reports whether startup supplied a typed native
enrollment transport capability. It does not read connection files, unlock
Keychain, inspect databases, contact the helper or a hosted service, create an
identity, or establish consent/source authority.

Missing, malformed or unavailable readiness cannot fall through to the existing
hosted permissions status call. With a capability supplied, status still goes
through the existing native admission/consent/source checks. Capability presence
alone never enables owner review. A successful status response must contain a
signed, wallet-bound grant that is not paused, revoked or expired.

The task-sync enrollment/activation/retry controls wait for that verified state.
Existing configured sync pause/resume controls and backend authorization remain
unchanged. Refresh performs one readiness/status sequence, rather than the prior
duplicate refresh. These presentation checks are not a replacement for the
server's current authorization checks on each action.

This fixes the page's blind heartbeat/enrollment path. It does not implement
first-time native configuration, discover an owner profile/device binding, create
or read credentials, approve a finite native transport session, or activate a
grant. The sole native installer/operator must still establish exact bindings and
current included-usage evidence. Once prepared, the native **Connect workflows…**
review precedes hosted status and Roles enrollment. Enrollment, activation,
source consent and standing delegation remain separate approvals.
