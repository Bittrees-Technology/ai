# Browser encrypted AutoNote approval inbox

The internal receiver retains authenticated encrypted manifest/chunk envelopes in the shared protected browser database. Version18 adds one empty store and fences previous writers; it does not migrate or grant source authority. Persisted rows contain ciphertext, hashes/indexes and public key/peer proofs, never plaintext notes.

Explicit `receive` requires current verified browser identity, matching protected local keys, the paired Mac and completed peer-key checks. The manifest must arrive first. Chunks match its offer, detail hash, times and count. Immutable retained rows and the shared incoming replay record commit together; exact duplicates reuse the retained result, while index collisions, missing replay records or changed proofs fail closed. Owner/global packet caps bound retained storage.

Explicit `reveal` decrypts the complete set, checks indexes, identities and canonical full-note hash, and revalidates current key/peer/replay/storage state in a final transaction before returning the exact source review. Missing, expired or changed sets cannot become a review. Receiving or revealing does not approve notes, send a decision, or save at the source.

Partial ciphertext survives closing/reopening. Ciphertext export returns no authority; deletion removes retained packets and preserves replay tombstones, preventing deleted offers from being silently reimported. The host must use fresh permission and a new offer for a new review after deletion. Key rotation or changed pairing blocks old proof reuse. This package provides no backup import path.

The CI browser acceptance uses actual protected browser key and peer lifecycles against synthetic retained Mac keys. It covers partial delivery, incomplete-review denial, reopened progress, exact replay, reordered remaining chunks, exact reconstruction, ciphertext export, deletion and replay denial. Existing browser migration assertions now expect version18. Local checks cover type/build only; browser execution stays in disposable CI.

Remaining integration: browser host/relay selection and receiving controls, local review lifetime and explicit approve/reject decision, encrypted decision return, Mac source-save dispatch and encrypted result receipts. No live activation is performed by this module.

The browser host now exposes explicit metadata inspection, exact queue selection, authenticated receive followed by relay acknowledgement, and reveal/export/delete APIs. A transport guard participates in receipt admission. Host/session/key cancellation invalidates the inbox. Metadata, ciphertext export and local deletion use owner-scoped maintenance without network key verification; receiving and plaintext reveal still require fresh verified paired scope.

A browser setup panel is mounted under the existing private-delivery flag. It displays retained progress and the complete source audience/notes only after explicit reveal confirmation. Plaintext is cleared on focus loss, hiding, Escape, context change and expiry. Approve/reject decision return is not implemented in this receiving panel. One additional CI fixture checks the actual identity/relay/ciphertext/acknowledgement path; the visible panel flow is checked separately with bounded synthetic responses.
