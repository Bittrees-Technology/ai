# Mac private-task dispatch

The Mac companion now connects retained endpoint keys, reviewed peers and saved task permissions to encrypted task admission and encrypted acceptance/result preparation. `CompanionPrivateTasks` uses a new verified paired-device identity scope for each operation; callbacks re-read current consent and proof state through the protocol's final transaction. No verified scope is retained across requests or local model execution.

This is an authenticated **local** handoff for a future transport adapter. It does not deploy a relay, accept external network connections, poll for tasks, upload anything or mount a browser task-submission screen. The normal native launcher keeps it off. Developer startup requires both `BITTREES_PRIVATE_KEYS=1` and `BITTREES_PRIVATE_TASKS=1`, the existing remote-status client, retained keys, reviewed peers and separately approved, current task permissions. A flag or pairing credential never grants content access. Status and offline stopping remain available when new dispatch is disabled.

## Local routes and data boundary

All routes inherit the companion's exact host/origin, authenticated local session and no-store boundaries. They do not accept caller-selected local owners, keys, model profiles or permissions.

| Route | Behavior |
| --- | --- |
| `GET /v1/private-tasks` | Local response IDs, operation/peer IDs, kind, state, revision, expiry and attempt counts. No network/native-key read. Saved state does not imply current delivery permission; `transportActive` is false. |
| `POST /v1/private-tasks/receive` | Strict authenticated envelope only. Returns local acceptance metadata (task ID, operation ID, `accepted-locally`), never the raw receipt, prompt or key proof. |
| `POST /v1/private-tasks/responses/prepare` | Explicit confirmed operation/peer and `accepted` or `result` selection. Reads the actual local admission and result under separate current receipt/result consent. Returns response metadata, not content or ciphertext. |
| `POST /v1/private-tasks/responses/resume` | Confirmed response ID. Reconciles the existing preparation under fresh authority; a stopped response stays stopped. |
| `POST /v1/private-tasks/responses/envelope` | Confirmed response ID. Rechecks current authority/content, records a handoff attempt and returns only the original authenticated ciphertext envelope. Attempts do not prove remote delivery. |
| `POST /v1/private-tasks/responses/stop` | Confirmed response ID and current revision. Offline stop prevents further handoff; does not cancel already accepted local work or retract prior copies. |

The receive route alone allows a 96 KiB JSON body to accommodate base64url expansion of the bounded 64 KiB encrypted payload. Other local routes retain their 64 KiB limit. Both reject oversized bodies with a content-free 413 response. Protocol schemas and cryptographic payload limits remain unchanged. Metadata belongs to the local caller; no new relay metadata or retention policy is defined here.

## Execution, revocation and uncertain outcomes

Admission authenticates the sender, verifies the exact recipient/key epochs and consumes operation/message/sequence identities atomically with the existing local queue and receipt. The sender cannot select sources, memories, tools, models, existing conversations or publishing rights. The ordinary worker uses the locally approved model profile; these operations do not hold a remote identity scope while inference runs. Acceptance receipts require receipt consent; terminal results independently require result consent for the same admission revision. Granting result consent later cannot expose an older task.

Key, peer, permission and dispatch mutations share the parent controller's operation lock. Dispatch invalidates pending setup reviews; logout invalidates active identity scope. All-data deletion rejects active dispatch and uses existing native cleanup before removing content. Revocation/identity loss/expiry/key or peer changes are rechecked by live providers. A local stop remains possible offline. Response state and replay records keep the existing encrypted owner-bound storage, restore locks, export/deletion handling and bounds; task schema19 adds possession evidence and locks pre-upgrade grants pending fresh review; browser schema1 is unchanged.

A request can commit locally before its final credential check or HTTP acknowledgement fails. No automatic retry is made. Repeating the **same incoming envelope** reconciles its original task; changing its contents is a conflict. An interrupted response preparation remains visible by ID and can be explicitly resumed. Ciphertext handoff retries return the same envelope; the attempt counter is conservative if a later check suppresses the response. Existing copies cannot be recalled. Consumers must never translate `accepted-locally` or a handoff count into remote execution/delivery success.

## Verification and limits

Two disposable endpoints use actual `RemoteClient`, persisted key/peer/consent controllers, HPKE envelopes, sender outbox, SQLite admission, ordinary worker, encrypted acceptance reconciliation and encrypted result opening. Tests cover database reopen, immutable ciphertext retry, independent consent, default-off dispatch, old-admission denial after replacement consent, revoked identity/consent, expiry during native reads, cross-owner denial, shared busy/deletion exclusion, logout, post-commit acknowledgement loss, failed response publication/resume, origin/authentication/tamper/extra-field denial, base64-expanded inputs, route-specific body bounds, sanitized projections and confirmed data deletion. Native storage and the identity transport are synthetic here; inference is a stub. Existing separate packaged-native and service CI remains required.

There is no personal app upgrade, native key access, hosted service or source permission activation. Acer-server's model/runtime/news jobs remain unchanged; Mac inference stays local with no Acer fallback. Reciprocal proof of possession, browser endpoint persistence/recovery, live transport and its retention decisions, user-facing submission/result mounting, conversation replies, exact-content approvals, scoped resume and independent/personal acceptance remain open. This is not a complete private remote-access release or a new E2EE claim.
