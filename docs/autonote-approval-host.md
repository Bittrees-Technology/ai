# Companion controls for encrypted AutoNote approval

This package connects separate peer approval consent and the durable outbox to the authenticated companion API. It uses the existing verified device identity, protected key/peer stores, relay custody, and shared private-key operation lock. Construction does not access native keys, grant permission, upload, or save notes.

`BITTREES_PRIVATE_AUTONOTE_APPROVAL=1`, existing private-key enablement, and a verified remote identity are required for grants and delivery. The new setting is disabled by default. Local revocation, stop, and removal remain possible when delivery is disabled.

- `GET /v1/private-autonote-approvals/:operationId`: retained permission and packet metadata, without credentials or ciphertext.
- `POST /v1/private-autonote-approvals/prepare`: review one grant, revoke, create, send, stop, or remove action at an exact source-review revision.
- `POST /v1/private-autonote-approvals/confirm`: consume the 60-second review with explicit confirmation and acknowledgement.
- `POST /v1/private-autonote-approvals/cancel`: invalidate the pending review and fence in-flight approval work.

A grant review identifies the exact notes hash, source permission, paired peer and protected keys. Confirmation re-resolves source and key proofs and rejects changed context. Creating an offer encrypts locally without sending. Sending one packet rechecks the relay connection and recipient, permission, exact retained message, and expiry; attempts are persisted before submission. Retry is another reviewed send and uses the same envelope. The relay callback checks permission at the client's pre-submit boundary. Relay storage does not mean browser approval or a source save.

The parent private-key lock participates in existing task-data deletion and backup guards. Logout/key invalidation cancels pending reviews. The routes do not accept caller-supplied credentials, ciphertext, live authority callbacks, or source-save instructions.

Validation extends the existing source/peer fixture with host cancellation, one-use confirmation, encrypted preparation without upload, explicit relay submission and stopping. The relay sender is synthetic in this fixture; hosted browser delivery and end-to-end source-save approval remain unfinished. Dashboard controls and browser multipart admission are the next integration step.

Dashboard delivery controls now sit beside a prepared AutoNote submission. Omitting `index` from a reviewed send selects all parts without retained relay receipts, pins their message IDs in the review, and sends sequentially within the review lifetime. Already receipted parts are skipped. A failed or cancelled batch leaves its persisted progress; a later explicit review can retry the remaining identical envelopes. Single-packet requests remain supported for recovery tooling.
