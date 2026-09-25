# Approved remote retention — 25 September 2026

The owner selected deletion of relay ciphertext after confirmed destination receipt and 90 days for operational metadata. Local task content and memory remain until user deletion. These choices do not activate the remote service or change existing local storage.

Apply migration012 after the previous remote migrations. It expands the database constraint without changing existing rows or deadlines.

For the eventual deployment, supply `receivedContent: "delete-after-receipt"`, `unreceivedContent: { mode: "until-deleted" }` and `operationalMetadataMs: 7776000000` in the required relay policy, and `retentionMs: 7776000000` in the remote application configuration. Undelivered ciphertext waits for receipt or explicit deletion; envelope expiry limits delivery authority, not storage. Origin, chain and quotas remain explicit deployment inputs.

An authenticated destination acknowledgement clears stored ciphertext atomically. Metadata tombstones remain for 90 days after the later of deletion and original envelope expiry, preserving replay protection. Status retention runs from the latest changed observation; unchanged retries do not extend it. Command and template retention uses their existing stored deadlines; this setting must never extend authentication or action expiry. Historical rows keep their original snapshotted deadlines rather than receiving a retroactive extension.

The existing PostgreSQL journey checks immediate ciphertext removal, continued receipt retention immediately before the 90-day deadline, and cleanup at the deadline. The existing HTTPS journey uses the 90-day setting across status, commands and templates. No separate test matrix is added.

Permission/device history cleanup is available through the existing maintenance command after applying migration013:

```sh
REMOTE_DATABASE_URL=... npx tsx scripts/remote-cleanup.ts --apply --batch-size 100 --history-retention-days 90
```

Without the explicit history flag, the command keeps its previous scope. With it, history is eligible 90 days after the later of expiry and revocation (or request expiry for unapproved MCP requests). Active and more recent records remain. Records with retained dependencies remain until those dependencies are removed: no parent deletion cascades through an unbounded child collection. Each pass locks and deletes at most the batch size in each category, skips busy rows and rolls back all categories if any phase fails. Accounts and relay ciphertext are outside this history sweep; the separate relay cleanup still owns ciphertext/tombstone deadlines. Historical message deadlines are unchanged.

Deployment remains incomplete: configure and verify scheduled cleanup, host logs and backup expiry under the same 90-day operational policy. The message tombstone policy alone does not establish those lifecycle guarantees. Independent cryptographic review and hands-on client acceptance remain open. The public static site does not mount the remote service.
