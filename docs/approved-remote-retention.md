# Approved remote retention — 25 September 2026

The owner selected deletion of relay ciphertext after confirmed destination receipt and 90 days for operational metadata. Local task content and memory remain until user deletion. These choices do not activate the remote service or change existing local storage.

Apply migration012 after the previous remote migrations. It expands the database constraint without changing existing rows or deadlines.

For the eventual deployment, supply `receivedContent: "delete-after-receipt"`, `unreceivedContent: { mode: "until-deleted" }` and `operationalMetadataMs: 7776000000` in the required relay policy, and `retentionMs: 7776000000` in the remote application configuration. Undelivered ciphertext waits for receipt or explicit deletion; envelope expiry limits delivery authority, not storage. Origin, chain and quotas remain explicit deployment inputs.

An authenticated destination acknowledgement clears stored ciphertext atomically. Metadata tombstones remain for 90 days after the later of deletion and original envelope expiry, preserving replay protection. Status retention runs from the latest changed observation; unchanged retries do not extend it. Command and template retention uses their existing stored deadlines; this setting must never extend authentication or action expiry. Historical rows keep their original snapshotted deadlines rather than receiving a retroactive extension.

The existing PostgreSQL journey checks immediate ciphertext removal, continued receipt retention immediately before the 90-day deadline, and cleanup at the deadline. The existing HTTPS journey uses the 90-day setting across status, commands and templates. No separate test matrix is added.

Deployment remains incomplete: configure and verify scheduled cleanup, permission/device history retention, host logs and backup expiry under the same 90-day operational policy. The message tombstone policy alone does not establish those lifecycle guarantees. Independent cryptographic review and hands-on client acceptance remain open. The public static site does not mount the remote service.
