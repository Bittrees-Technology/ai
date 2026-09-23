# Mac reviewed Mail backend

The companion now has a separate reviewed-Mail connector, encrypted message journal and authenticated local API. This is backend groundwork: the dashboard review/file-export/history interface, combined companion/source delivery acceptance and native/personal release remain open. It does not give the model a send tool. The installed app and prepared development archive have not been replaced.

Mac inference remains independent of Acer-server. This package makes no model, runtime, download, fallback or news-job changes. Mail transport is handled by Mail's existing source queue, not by the Mac inference runtime.

## Exact-message lifecycle

1. `prepare` validates the mailbox identity and complete message, generates an operation ID, and commits an encrypted owner-bound record. It returns an explicit `bittrees-mail-review-v1` file payload and the fixed Mail consent URL. Message content never goes into that URL. The in-memory PKCE verifier is not exported or persisted.
2. A user imports that file at Mail's separate `/connect/ai-send` approval page. Its code is exchanged through `finish` for an exact-message permission. The client verifies audience, owner wallet, mailbox, operation, digest, recipient count and expiry before saving the credential in the distinct `org.bittrees.ai.connector.mail-send` Keychain service. Selected-message read and Chat credentials are never reused.
3. `review` returns the full immutable message and a short-lived local review ID. An explicit `confirm` consumes that ID once. A FULL-synchronous SQLite transaction records submission intent and reads it back before the client makes its single source request. Edits require a new message operation and source approval.
4. Any uncertainty after dispatch retains the original operation. `reconcile` calls only the source's receipt endpoint; it cannot submit, schedule, recreate or retry a message. There is no startup poller or automatic resend. Restart loses the pending approval/review, while encrypted message history survives. `reconnect` creates a new approval file for the same exact operation when a fresh receipt-access grant is needed.

The pilot keeps one current send credential per local profile. Disconnect or explicitly forget it before preparing another message; history can contain many operations. A failed source disconnect persists `disconnect_pending` and blocks use until resolved or explicitly forgotten. Forgetting a local credential does not revoke source permission. Deleting local history does not recall a message or cancel source work.

## Limits and receipts

The versioned contract preserves exact From, distinct To/Cc/Bcc groups (1–20 total), subject, plain text, up to four attachments totaling one MiB and an optional exact reply/source-version reference. Unsupported fields, HTML, malformed Unicode, normalization and duplicate recipients are rejected. Attachment MIME is inert `application/octet-stream`, with canonical base64 and bounded filenames. Each reviewed field participates in the canonical SHA-256 digest.

The journal is capped at 100 records and 24 MiB of encrypted payload across owners. There is no time-based message deletion. At capacity the user must export/delete records explicitly. Other stored content also counts toward the separate backup size limit, so this journal cap does not guarantee a full-store backup will fit.

`sourceSubmission` distinguishes unobserved, not-submitted and reserved source state. A locally reserved operation remains non-retryable even if a later source check says not-submitted. Receipt states are historical uncertain, accepted, partially accepted or rejected, with recipient indexes and a separately tracked Sent copy. SMTP acceptance never means delivered. Exact operation/digest/recipient binding is enforced; stale uncertainty or an absent receipt cannot erase known acceptance. Conflicting terminal observations fail closed.

## Local API

All paths are under `/v1/connections/mail-send`, behind the existing loopback Host/Origin and bearer-session checks. Only `POST prepare` accepts the 1,500,000-byte JSON envelope limit; normal requests remain limited to 64 KiB.

| Method/path | Purpose |
| --- | --- |
| GET `/` | Credential status without its token |
| POST `/prepare` | `{identity, message}`; returns immutable operation and explicit source-review file |
| POST `/reconnect` | `{operationId}`; new source-review file for the same message |
| POST `/finish` | `{operationId, code}`; exchange pending PKCE approval |
| POST `/review` | `{operationId}`; obtain exact local confirmation review |
| POST `/confirm` | `{id, confirmed:true}`; consume review and make one durably recorded request |
| POST `/cancel` | `{id}`; discard that held review |
| POST `/reconcile` | `{operationId}`; read historical source status |
| GET `/history` | Owner-bound summaries without message body/files or credentials |
| GET `/history/:operationId` | Owner-bound complete saved record |
| POST `/delete` | `{operationId, confirmed:true, forgetSendTracking:true}` |
| POST `/disconnect` | `{}`; suspend locally, then revoke at source |
| POST `/forget` | `{confirmed:true}`; remove only local credential |

Owner export includes complete `mailSends` records but no token/verifier. Whole-data deletion clears owner records and held reviews; it is blocked while the connector is busy, including a final recheck at deletion commit. Other owners' records are preserved. Credentials, external review-file copies and previously exported backups have separate lifecycles.

## Upgrade and recovery

Task schema 23 adds the encrypted journal; memory schema 2 is unchanged. Existing tasks/results/profiles and News publication history are preserved. Every Mail record restored from a backup is marked **reconciliation-only**, even if it was merely prepared when backed up: that message might have been sent after the snapshot. Restoring cannot recreate permission to dispatch it. Ordinary reopen preserves unsent preparation, but requires new local review and a valid exact source grant.

Verified against actual prepared engines: [task22→23](evidence/mail-send-task23-compatibility-2026-09-23.json), [task21→23](evidence/news-publication-task23-compatibility-2026-09-23.json), [task20→23](evidence/local-memory-dependency-task23-compatibility-2026-09-23.json). Checks cover wrong-key isolation, preserved content, old-engine refusal, current backup restoration and separate original-backup rollback. Historical rollback loses later history; export/preserve newer tracking first. Missing old history is never permission to resend.

```sh
node scripts/check-mail-send-upgrade.mjs '/absolute/path/to/verified/PR139/engine/dist'
MAIL_REPO=/absolute/path/to/private/mail \
MAIL_SOURCE_COMMIT=<exact-clean-source-commit> \
MAIL_CONTRACT_OUTPUT=/absolute/path/to/evidence.json \
node_modules/.bin/tsx scripts/check-mail-send-contract.ts
```

[Actual source-contract comparison](evidence/mail-send-source-contract-2026-09-23.json) verifies canonical bytes, digests and accepted/rejected envelopes and receipts against clean private Mail version57 source. Private implementation is loaded only into a disposable directory, never copied into this repository. This comparison is not combined HTTP/queue/SMTP acceptance. Unit tests intercept transport and use synthetic credentials; no personal Keychain, Mail account or actual recipient is used. Source flags, deployment, migration and host installation remain separate release work.
