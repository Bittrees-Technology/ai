# Encrypted AutoNote approval transport — work in progress

Local exact review/save is implemented in PR221. Remote browser approval needs a separate peer permission; read, conversation and resume permissions confer no write authority.

The current transport foundation splits the canonical complete source review (up to the connector's existing 2,000,000-byte limit) into 16-KiB byte parts. The manifest binds the source approval, parent grant, source operation, meeting, source digest, complete-detail hash, count and expiry. Each chunk has an independent operation ID for the shared incoming replay index, plus its offer ID, full-detail hash and position. All packets, including the manifest, must travel inside authenticated encrypted envelopes. Headers must bind the manifest offer ID, chunk ID, decision ID or receipt decision ID as appropriate; sequence/message IDs are reserved and retained before sending, never regenerated on retry.

A complete set is required before displaying an actionable review. Assembly rejects missing, repeated, changed, mixed or expired data and verifies both the full canonical detail and source proposal hashes. A multipart test passes the real HPKE codec with notes larger than a single envelope and verifies complete reconstruction and rejection paths. This is framing/integrity evidence, not authorization or a delivered browser approval feature.

Remaining implementation for this package:

- Implemented internally: explicit current Mac-to-browser approval consent, bound to one source operation, complete notes hash, source approval credential, verified peer/key proofs and expiry. It is stored in the existing encrypted submission record. Changed notes, source/peer changes and revocation deny resolution. The actual encrypted restore check retains metadata but denies use through restored key/peer locks. Host and UI wiring remain pending.
- Persist the encrypted offer and all message/sequence identities before relay upload; support bounded multipart progress and exact retry after a lost response.
- Authenticate and durably admit browser manifest/chunks with the shared replay index. Preserve incomplete progress without enabling approval; expose export/delete/cancel controls.
- Let the browser review the complete notes and audience, then explicitly produce a decision bound to both hashes. Admission on the Mac must consume replay state before dispatching the existing source save flow.
- Persist/save/reconcile once, and return an encrypted confirmed or uncertain receipt. Restart and restore must never automatically resend a source save.
- Wire the real host routes and controls, then verify one integrated browser-to-source flow in disposable CI. Native/personal/live activation remains separately gated.

No source token is present in any packet. These modules currently have no relay, listener, runtime activation or approval dispatcher. `frameOffer` derives packet scope only from freshly resolved separate consent; its caller must retain the resulting IDs and bytes once before any encryption/upload.
