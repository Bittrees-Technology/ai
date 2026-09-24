# Reviewed Mac conversation relay sending

The local authenticated conversation API can review and explicitly upload an
already sealed outgoing message/question or an incoming message's storage receipt.
The existing opaque relay carries the original ciphertext. This does not enable
background polling, change browser permissions, activate a live relay, or change
Acer's model/runtime/news jobs.

`POST /v1/private-conversation-content/relay-review` accepts an exact original ID,
permission ID and observed revision. `action: "send"` also selects a retained relay
connection ID/revision. The server obtains fresh device/key/peer, independent
conversation permission, source/dependency and relay recipient proof. It returns
metadata, destination fingerprint and a bounded review ID. No live client or
credential survives the interactive review.

`POST /v1/private-conversation-content/relay-confirm` requires that review ID and
separate `confirmed` and `acknowledged` booleans. It reacquires authority and compares
the original entry and destination. It durably records the attempt before network
work. A trusted source/consent/original guard runs again after asynchronous envelope
hashing immediately before submission and upon response. Source checks retain their
existing bounded-read limitation: they do not form a distributed transaction with
external source edits.

Server observations bind the original message ID/hash and reject decreasing
revision/state or changed storage timestamps. They are distinct from authenticated
recipient-storage receipts; neither proves reading or execution. A lost response
leaves an uncertain attempt with no invented observation. Explicit refresh and a
new review can retry the same ciphertext and sequence. No retry silently renews an
expired envelope or widens access.

`action: "stop"` uses a separate local review and confirmation. It works after
permission expiry/revocation, blocks future relay attempts, preserves original
content/history and cannot retract previously uploaded ciphertext. There is no
automatic restart. Independent export/deletion controls retain their existing scope.

Schema35 refuses older writers before adding encrypted delivery history. Actual
compiled34 upgrade evidence preserves original ciphertext, authenticated recipient
receipts, Inbox, shared replay and key bytes. Backup restores delivery history
locked; owner deletion and original-backup rollback remain available.

Node/API coverage uses synthetic stores, in-memory key entries and a controllable
relay transport. It covers messages and storage-receipt uploads, lost responses,
reopen/duplicate retry, changed destination, expired/revoked/cancelled review,
source deletion, write rollback, server-history regressions, local stop, API
credentials/origin and caller-injected authority. A regression first reproduced
source deletion during upload hashing reaching the relay, then verified the final
host guard prevents submission while retaining the attempted-operation record.
Full browser/native CI remains required before merging. Product relay controls,
browser content sending, Mac/browser incoming queue routing and separate server
acknowledgement, complete historical replay and release acceptance remain required
integrations. Installed apps, personal keys/content and live services are unchanged.
