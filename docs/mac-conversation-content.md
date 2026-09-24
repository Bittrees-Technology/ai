# Durable Mac conversation content

This internal engine connects authenticated conversation messages to the existing Inbox and exact answers to its existing input-wait engine. Authenticated local companion routes expose explicit prepare/envelope/receive/reconcile operations. The browser uses its separate retained content engine and controls. The authenticated browser host now reconciles recipient-storage receipts. The Mac also exposes separately reviewed relay-send/stop routes with durable attempt history; see [Mac relay sending](mac-conversation-relay-send.md). Reviewed product relay controls, incoming queue integration and full end-to-end acceptance remain required.

`PrivateConversationContent` requires the current conversation consent and native key lifecycle. Task-linked content additionally requires a trusted host-supplied asynchronous source/dependency check that returns a synchronous revalidation function. Its default denies all task-linked content. That function must not be supplied by a request or implemented as a permissive placeholder. Task revisions, thread/Inbox membership, exact shared-question association, current grant and generation-time key coverage are separately enforced by the engine.

The host implementation is now `conversationTaskAccess` in `apps/companion/conversation-access.ts`. It is used by the existing authenticated task-answer route and tested with the content core. It performs a fresh CRM/AutoNote/Mail source validation outside the SQLite transaction, binds task input/source identity and memory change state, and returns a synchronous guard limited to ten seconds or the earlier source-grant expiry. Both wall and monotonic clocks fence expiry and clock reversal. Connector mutation attempts invalidate captured boundaries even after the attempt finishes. Local input/source/dependency checks repeat under the answer/content write lock, including after vault writes. The guard allows the expected revision increment from `answerInput`; exact question revisions remain the responsibility of that existing transaction and the content engine.

This is local revalidation after a fresh remote read, not a distributed transaction or a subscription to remote source edits. Changes made directly at a source after its last response cannot be observed synchronously. A new content operation must validate again. The packaged start module supplies this guard to the conversation controller. Other hosts that omit it retain default denial for task-linked content. Relay integration must obtain fresh guards for actual delivery rather than reuse a prior successful preview.

`prepare` selects an existing local Inbox message and reserves its immutable wire operation and directed sequence. Questions capture a still-waiting native question and its exact task revision and deadline. Replies require a previously shared or accepted parent mapping; a local reply cannot omit its parent's task linkage. `seal` produces the original authenticated envelope once; concurrent finishers return the winning ciphertext. A task changed after question preparation requires a new question operation. No ciphertext, identity or expiry is silently replaced.

`accept` authenticates the directed envelope and content/operation binding before any write. Current authority, parent/task/source/dependency checks, Inbox append or exact `answerInput`, journal mapping, shared incoming replay and durable receipt preparation commit together. A missing parent stays pending without consuming replay or acknowledging receipt. A retry must retain the exact original ciphertext and still-existing Inbox outcome. Ordinary replies preserve the parent's task linkage and never unblock work. Exact answers queue waiting work once and leave paused work paused. Receipt sealing uses the original acceptance and reserved sequence; acceptance means Inbox storage, not execution or reading.

Schema33 adds an encrypted owner-bound content journal. Wire IDs are hashed with the local owner, remote account and conversation reference; one operation cannot change direction or content type in that conversation. Both incoming and outgoing entries are retained, bounded to 128 per owner and 200,000 encrypted bytes per entry, with no automatic eviction. The common replay ledger remains a separate fence. The owner export includes the journal, with the same task/source visibility policy as Inbox history. Unavailable or source-bound entries expose only an ID, revision, lock state and unavailability marker; their plaintext, ciphertext and mappings are omitted. Owner deletion removes it with Inbox content and other private state; encrypted backup preserves it while restore locks further authority. No per-item journal pruning or key rotation is introduced.

The engine serializes up to four pending calls per instance before resolving native keys. Independent instances still rely on the database transaction for duplicate and replay exclusion. Asynchronous cryptography and source checks happen before the write lock; permissions, native coverage, local mappings and source guards are checked again under that lock and after vault writes.

Validation includes real encrypted roots/replies, independent concurrent receivers, original receipt ciphertext after reopen, exact waiting-task answers, paused tasks, changed task revisions, source-link preservation, cross-family replay conflicts, removed original outcomes, failed writes, capacity, authority changes during sealing, backup/restore, owner deletion and actual authenticated HTTP export redaction. The actual compiled schema32 upgrade is rehearsed with pinned prior modules; old Inbox/offers/key bytes survive, wrong-key opening leaves the original writer usable, schema32 writers refuse33, and the untouched original backup supports rollback. These synthetic core checks do not establish browser transport, native UI/personal/live use, historical-key acceptance across the complete application or independent cryptographic assurance.

## Authenticated Mac handoff

The packaged engine constructs the conversation controller alongside native keys. Operations require the existing remote client, `BITTREES_PRIVATE_KEYS=1`, and separate `BITTREES_PRIVATE_CONVERSATIONS=1`. Private-task dispatch does not enable conversations and is not needed for conversation messages. The normal launcher keeps these development options off; no personal installation is changed by this source package.

All routes use the existing authenticated loopback Host/Origin checks. Every mutation requires explicit `confirmed: true` and the strict core input schema; malformed requests fail before native credential reads. Every operation obtains verified device identity and current key/peer/conversation permissions, uses the shared key/permission lock, and rejects identity invalidation during asynchronous resolution. Flags and pairing alone never grant conversation/source access.

| Route | Behavior |
| --- | --- |
| `GET /v1/private-conversation-content` | Local journal metadata and whether dispatch is enabled. No native key/network access, plaintext, source bindings, key proofs or ciphertext. `transportActive` remains false. |
| `POST /v1/private-conversation-content/prepare` | Select an existing authorized Inbox message or question, stable wire ID, permission/revision, parent and expiry. Save preparation once and return metadata. |
| `POST /v1/private-conversation-content/envelope` | Explicitly encrypt/reveal the retained original message or acceptance receipt using its current revision. Revalidate source access before returning ciphertext. |
| `POST /v1/private-conversation-content/receive` | Authenticate and admit one confirmed envelope through the existing atomic Inbox/answer engine. Return only metadata and duplicate status. Missing parents return `PARENT_PENDING` (409), preserving retryability without consuming the operation. |

`accepted-locally` means Inbox storage. It does not mean execution, reading, relay acknowledgement or delivery to another device. A response lost after local commit can be reconciled through the stable original request and journal; response history is not permission to retry with changed ciphertext.

HTTP/controller tests cover metadata-only status, exact preparation/ciphertext after reopen, encrypted replies and receipts, authentication/origin/confirmation, independent flags, missing host source guard, parent-pending response, late identity loss, revocation and shared native operation exclusion. A real `LocalWorker` question is prepared and encrypted through these routes; a synthetic peer's exact encrypted answer resumes that same worker once, while an ordinary reply leaves it waiting and duplicates after completion do not rerun it. This uses real HPKE and HTTP but not browser storage/controls or relay transport. Those remaining paths still require full end-to-end acceptance.

## Recipient storage receipt reconciliation

The authenticated local `POST /v1/private-conversation-content/reconcile` route
accepts one reviewed receipt for a selected outgoing message or question and its
expected journal revision. It requires the same independent conversation gate,
verified identity, current keys/peer/consent, generation provenance, source access
and shared operation exclusion as the other conversation routes.

The recipient's authenticated receipt must match the original operation, content
type, conversation scope and reversed directed key epochs. Acceptance and receipt
timestamps must fit the original delivery window. One transaction saves the exact
receipt and shared incoming replay outcome. Altered ciphertext, missing local
originals, replay conflicts, revoked authority and failed writes produce no receipt
state. Reconciliation never appends a message, answers a question or runs a task.
Original outgoing ciphertext remains unchanged and explicit duplicate reconciliation
returns the retained result. After an uncertain response, inspect the current row
revision before retrying; do not assume the write failed.

Status exposes `recipientAccepted` and `recipientAcceptedAt` separately from
`receiptPrepared` for incoming messages. Recipient acceptance means storage only,
not reading, task completion or relay-server storage. Status responses contain no
plaintext content, key proof or ciphertext. These routes do not automatically send,
poll or acknowledge anything at the relay.

Schema34 fences prior writers before the new outgoing receipt state is stored.
The actual compiled schema33 upgrade, encrypted backup with locked restored
authority, owner-scoped deletion and untouched-original rollback are checked by
`scripts/check-conversation-receipt-upgrade.mjs`. Browser receipt reconciliation,
reviewed relay transfer and full release acceptance remain required integrations.
