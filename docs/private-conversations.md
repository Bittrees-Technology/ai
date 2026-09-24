# Private conversations — implementation in progress

The Mac companion owns the selected local thread. Acer's model, runtime and news
briefings remain independent. This work does not install or activate any service.

The current implementation provides strict encrypted message framing and a Mac
consent boundary. It does not yet deliver conversations. The Mac/browser review
controls, browser consent, offer exchange, durable transport, shared incoming
replay coordination and end-to-end reconnect acceptance remain unfinished.

## Separate Mac consent

`PrivateConversationConsent` requires one explicitly selected existing local
conversation and personal user Inbox, one currently paired browser key, verified
possession of both endpoint keys, and the current account/device binding.
Approval is separate from private task, relay, model and source permissions.
Ordinary messages to the Mac, ordinary messages to the browser, questions to the
browser and answers to the Mac are separate choices. Answers require the
question direction; they do not grant task creation, publication, sending or
resumption permission.

A one-use review expires after five minutes or the chosen grant deadline,
whichever is earlier. Both wall and monotonic time bound the review. Approval
rechecks the current revision, identity proofs, Inbox definition and thread.
The returned review is a copy; editing it cannot expand authority. Grants last
at most 24 hours and never outlive the verified device binding.

Each peer/thread/Inbox tuple has an opaque conversation reference. Renewal keeps
that reference but issues a new permission ID. Previously resolved handles
recheck current permission, identity, possession and scope state on every use;
revocation or replacement denies them. Changing the selected Inbox definition,
even to an identical newly encrypted definition, requires another review.
There are at most 64 retained grants per local owner, bounded to 256 KiB encrypted.
Renewal of an existing tuple remains possible at capacity. Revoked entries remain
inspectable until content deletion; individual removal controls remain unfinished.

Saved grants use a separate encrypted `private_conversation_consents` row at task
schema28. Fresh/updated stores start with no grants. Local export includes saved
conversation choices; deleting local content clears them and increments the
revision tombstone. Restoring a backup locks them. Reviewing one restored grant
revokes the others rather than silently restoring their access. Corrupt storage
denies access, preparation and export rather than silently resetting permission.

## Content boundary

Ordinary messages, questions and confirmed exact answers are distinct schemas.
Questions include task/question identity, task revision and deadline; answers
name that exact question and expected revision. These schemas only validate
framing. A receiver still must verify authenticated endpoint keys, both current
consents, the selected thread/Inbox, parent identity, current task and source
access, and consume replay state atomically with acceptance. An ordinary reply
must never unblock a waiting task. A delivery receipt means Inbox acceptance,
not execution, completion or reading.

Text preserves exact whitespace while rejecting blank content. Encoded messages
must fit the existing 64 KiB authenticated-encryption payload bound, including
UTF-8 and JSON overhead. Tests exercise real HPKE encryption/decryption and header
tampering. No new cryptographic primitive is introduced.

## Verified so far

Nine consent tests cover exact scope/directions, authority separation, foreign and
nonpersonal targets, review clocks/concurrency, native-resolution invalidation,
key-peer revocation, expiry, renewal, restore locks, export/deletion, corrupt
storage and capacity. Four contract tests cover strict message roles, bounds,
authenticated encryption and receipt semantics. Existing task and source checks
remain required. The compiled task27 engine is used by
`check-conversation-upgrade.mjs` to verify real upgrade, old-writer refusal,
wrong-key isolation and original-backup rollback. Synthetic test stores only.

The overall private-content requirement remains open. Passing these module tests
does not establish conversation delivery, browser consent, source authorization,
independent cryptographic review, model quality or live deployment acceptance.
