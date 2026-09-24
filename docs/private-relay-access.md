# Explicit private relay permissions

`RemotePrivateRelayAccess` is an inactive PostgreSQL permission backend for the planned encrypted relay. It has no HTTP routes, listener, ciphertext store, native/browser controls or delivery loop. It does not grant endpoint key access, task execution, result viewing, source-app access or model selection. Existing status, controls and template credentials keep their existing scopes. Acer news processing remains independent and unchanged.

## Two endpoint decisions

A signed-in browser can explicitly enable transport for its own current registered identity. The server verifies the account session, origin/chain, browser credential, registration epoch, expiry and exact expected grant revision. An operation ID cannot create a second grant. Replacing permission revokes the prior grant in the same transaction.

For a Mac, the owner first approves the exact registered device and credential epoch with an explicit expiry. This produces a pending approval, valid for at most two minutes. The Mac must separately opt in using its current status credential and the exact approval ID/revision. This one-use acceptance issues a new random `private:relay` credential. The existing status credential cannot access relay operations, and the relay secret cannot authenticate as a status credential or browser session.

Only a domain-separated hash of the relay secret is stored. Repeating acceptance does not return or reissue a secret. Owner history is paged with bounded metadata-only rows. A lost approval response is looked up by its original owner-scoped operation ID; a lost acceptance response can be inspected through owner history; obtaining a usable replacement requires an explicit new approval/acceptance flow. No silent retry or lease extension is implemented.

## Atomic authority

`withBrowser` and `withMac` authenticate inside the same PostgreSQL transaction used by a future message-store operation. The server locks the relevant session, registration and grant, serializes grants and message work per owner, and rechecks original clock/expiry limits before commit. Recipient lookup requires a separately active transport grant for an opposite-kind endpoint owned by the same account. Key epochs remain a separate endpoint cryptographic concern.

The transaction context is internal trusted server code only. It must never be serialized to a client or retained after its callback. Its `check` and `recipient` methods fail after the callback ends. Database callbacks must contain only bounded local/database work, with no external network call, model generation or user interaction. The database client itself is an internal capability, not a public API.

Revocation that has acquired the owner lock before authentication prevents the operation from entering its callback. Revocation arriving after an already-authorized transaction must wait for its locks; the earlier transaction may commit before the revocation. Expiry or clock rollback observed before commit rolls back that transaction's writes. This ordering does not retract bytes previously downloaded or content already admitted at an endpoint.

Owner revocation is revision-bound and remains available for expired grants under a valid owner session. An active Mac can revoke its own grant with the separate relay credential. Registration revocation, credential rotation, session logout and grant expiry deny future use. No task permission is inferred from transport permission.

## Storage and verification boundaries

Migration009 adds only permission metadata and hashes. A partial unique index limits an endpoint to one current pending/active grant, unique owner/operation IDs prevent repeated approval, and bounded retained-row quotas are enforced under the owner lock. It preserves existing status, device, browser and template tables. Grant history is not automatically purged; relay metadata retention remains a pending user decision and must be connected to explicit cleanup before deployment.

The real PostgreSQL integration uses SIWE sessions, actual browser registration and Mac pairing, random synthetic credentials and actual HPKE envelopes. It covers independent opt-in, cross-owner and credential-scope denial, stale revisions, replacements, quota/concurrent creation, lost-response refusal, logout/revocation/rotation, approval expiry and transaction rollback after time loss. Disposable CI must verify the final source before merge. HTTP/CSRF integration for new routes, grant controls, durable ciphertext/receipt storage and automatic delivery are subsequent required work; this is not a completed private-access release.
