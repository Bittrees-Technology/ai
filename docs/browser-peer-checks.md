# Browser and Mac key-possession checks

`BrowserPeerChecks` and the verified host's `checkAPI` implement explicit browser challenge/respond/complete operations using the existing Mac wire format. Each endpoint must finish its own independent challenge. Answering the other device's challenge grants no local proof or task permission. The signed-in page mounts manual browser controls over this retained backend and host API. Task consent and private task/result/approval transport remain unfinished.

## Retained exchange

Begin requires the reviewed peer and expected key/peer revisions. Current retained keys and the reviewed peer public key are resolved through the real providers. A common-database transaction validates the current lifecycle, selected slot and peer record while reserving the shared sender sequence and an immutable preparation. Five-minute deadlines are capped by the device lease. A different tab cannot revoke the key or pin between those checks and the write.

Preparations contain only the challenge/response payload. Each is encrypted with AES-256-GCM under a fresh nonextractable WebCrypto key, a random 96-bit IV and identity-bound authenticated data. That key is retained alongside its ciphertext using IndexedDB CryptoKey cloning. It is local restart material, not a new user-held recovery key or a backup that restores authority. No raw preparation key or nonce is returned by the public API. The browser profile and same-origin code remain trusted; this is not full-profile encryption or hardware-backed key protection.

HPKE Auth encryption runs outside database transactions. Publication rechecks the original record revision/content, active key and peer in one strict write transaction. Interrupted preparations can be resumed explicitly after reload using the original ID and sequence. Already published ciphertext is returned unchanged; resume cannot regenerate an existing wire message or revive a stopped exchange. Actual challenge/response schemas, route/key epochs, original nonce and canonical transcript hashes match the Mac implementation.

Incoming challenges are authenticated before a response is reserved. The unique response key identifies the original challenge sender and operation, so exact concurrent replies converge on one durable record. Changed requests and transcripts conflict. Completion authenticates the response and requires the original challenge nonce/hash, exact local and peer proofs, correct route/epochs and unexpired exchange. The completion write rechecks all durable authority. Exact response retries reconcile a saved result; a different resealing cannot replace it.

Wall-clock rollback and monotonic elapsed time are checked throughout online operations. Exchange expiry stops late completion/delivery; an already completed proof is usable only while its exact key, peer revision and verified binding remain current. Metadata history is not current authority. Browser restart does not provide a durable monotonic clock or protection against hostile profile/time rollback.

## Host, maintenance and limits

The host obtains fresh server-verified registration around every online exchange operation and resolves real key/peer state internally. No key handles leave `checkAPI`. Scope cancellation, logout, registration/key changes and closed storage invalidate in-flight work. A lost final server verification can follow a committed local write: report uncertainty and refresh status rather than infer rollback. Offline owner-local status, stop and deletion remain available without an online lease.

Status exposes only bounded metadata and revisions, never preparation keys, nonces or secret content. Stop requires the exact current record revision and rejects a completed proof. Clear deletes all check records, including preparation keys/ciphertext, and locks a minimal owner/device marker. It preserves shared sequence counters. Explicit reset requires a different verified browser device identity with a valid retained key. Recovered keys, old ciphertext and deletion markers alone cannot reactivate proof or task authority.

There are at most256 check records per local owner and one in-flight operation per provider instance. Capacity never silently prunes history. Quota/transaction failures preserve committed state; a failed publication or completion remains available for explicit reconciliation. Storage version change closes the provider. Shared storage migration must finish before this provider opens. Opening it lazily keeps unrelated key recovery available when old ciphertext history requires repair.

Future task consent/use must validate completed proof and current key/peer/permission rows within its own atomic transaction; a prior asynchronous `validFor` result must not be cached as authority. The current outbox still receives trusted fixture callbacks and is not mounted for production tasks.

## Verification scope

Disposable GitHub tests use actual browser IndexedDB/WebCrypto and actual Mac key, peer and check modules with encrypted disposable SQLite and simulated native slots. They cover bilateral exchange and reload, encrypted nonextractable preparations, immutable replies, altered payload/transcript/type/routes/epochs, failed publication/completion and exact retry, expiry versus current proof, cross-tab revocation during cryptography, scope/clock cancellation, offline stop/deletion/fresh-device reset, concurrent response reservation, and the actual host with SIWE/HTTPS/cookies/PostgreSQL, remote revocation and post-commit verification failure. Test status is recorded in the local checklist evidence after CI completes. These tests do not prove personal Safari/WKWebView behavior or independent protocol acceptance.

Browser common database4, Mac task23 and remote8 remain unchanged. Installed PR40, prepared PR142, local model defaults and Acer-server's model/runtime/news jobs remain unchanged. No live deployment, personal-profile migration, local browser/native automation or task permission is enabled. Signed delivery, historical restore/rotation, lease renewal, relay retention and independent/personal/native acceptance remain open.

The signed-in browser now mounts [manual device-check controls](browser-check-controls.md). Browser task consent and private transport remain separate work.
