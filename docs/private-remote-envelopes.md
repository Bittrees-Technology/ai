# Private remote content: envelope foundation

Status: internal development codec, not an enabled remote-content feature or a completed E2EE claim. No live HTTP endpoint, relay table, device enrollment, key persistence or UI uses this module. The subsequent internal [task-admission backend](private-task-admission.md) imports it and atomically creates bounded local tasks under explicit trusted per-peer consent; startup does not enable it. The existing remote-status allowlist remains unchanged. This step supplies the cryptographic substrate for R2; its acceptance gates remain open.

## Decisions and dependencies

| Area | Development decision / remaining gate |
| --- | --- |
| Recovery | User confirmed user-held recovery and no Bittrees content recovery. Remote endpoint keys must be distinct from the local storage key and its existing recovery kit. A separate encrypted endpoint-key backup and explicit user-held restoration flow are required; neither is implemented here. |
| Local retention | User confirmed local content stays until deletion, with export/delete. Envelope admission expiry is not deletion of already accepted local history. |
| Relay retention | Pending user choice: remove ciphertext after acknowledged delivery, or retain until explicit deletion. Operational-metadata retention remains a separate pending choice. No relay persistence or cleanup policy is implemented by this codec. |
| Recipients | One explicitly paired endpoint per envelope, same owner, with a separately pinned public key and encryption-key epoch. Never accept a replacement key merely because the relay supplies it. New devices receive fresh keys and no historical keys automatically. Multiple recipients require separate envelopes and explicit scope. |
| Enrollment | Existing R1 login/pairing establishes account/device credentials, not encryption-key trust. R2 must bind full key fingerprints and owner/device identities to a reviewed local pairing transcript, with out-of-band comparison before accepting a peer. |
| Rotation and revocation | Encryption-key epochs are distinct from R1 credential epochs. New keys require explicit trusted enrollment and monotonically increasing epochs; old epochs cannot admit new actions. Pending old envelopes expire or are denied. Historical decryption/recovery and retained-old-key removal need explicit controls; rotation cannot retract delivered copies. |
| Client/update trust | Browser code and updates from ai.bittrees.org, the browser itself and the native client are trusted endpoints. A compromised site can serve code that reads keys/plaintext; ciphertext-only database storage does not prevent that. Native signing/update trust, web delivery integrity and independent review must precede production privacy claims. No protection against compromised endpoints or malicious updates is claimed. |

These engineering choices define the experimental wire format. They do not settle unresolved retention choices or approve a production security design. Work that depends on those choices, including persistent delivery and key-history policy, remains gated.

## Format and cryptography

The implementation is `modules/remote/private-envelope.ts`. It pins `@hpke/core` **1.9.0**, with the resolved `@hpke/common` version and integrity hashes in the lockfile. It uses HPKE **Auth** mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM from the library over WebCrypto. It implements no custom cipher, KEM, KDF or nonce derivation. The dependency audit at introduction reported zero known vulnerabilities; that is not an independent cryptographic audit.

[Maintainer documentation](https://github.com/dajiaji/hpke-js) describes WebCrypto/runtime support. The [nonce-reuse advisory](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4) affects core versions through 1.7.4 and identifies 1.7.5 as patched. In addition to using a later pinned version, this module uses one-shot `seal`/`open` calls with a fresh context per envelope; callers cannot supply a nonce or ephemeral key or reuse a sender context.

An envelope is strictly `{ header, enc, ciphertext }`. Header fields, in authenticated order, are:

1. `version` = 1, `suite` = `HPKE-Auth-P256-SHA256-AES256GCM`.
2. `ownerId`, `senderId`, `recipientId`: lowercase opaque UUIDs, with distinct endpoints.
3. `senderKeyEpoch`, `recipientKeyEpoch`: positive safe integers.
4. `messageId`, `operationId`: opaque UUIDs; operation ID is the application idempotency identity.
5. `sequence`: positive safe integer for the directed endpoint/key-epoch channel.
6. `issuedAt`, `expiresAt`: safe integer milliseconds; admission lifetime at most 24 hours, positive and unexpired, with at most 30 seconds of future clock tolerance.

HPKE `info` is UTF-8 `org.bittrees.ai/private-envelope/v1`. Additional authenticated data is UTF-8 JSON of the fixed-order array containing those twelve header values. Strict parsing reconstructs canonical field order independently of input JSON property order. Suite/version changes and extra fields fail, without downgrade negotiation. Header metadata is visible; UUID syntax does not hide traffic relationships or prevent a malicious sender from encoding information in identifiers. Future producers must generate IDs internally rather than accept user labels.

`enc` is the canonical unpadded base64url encoding of a 65-byte uncompressed P-256 point. `ciphertext` is canonical unpadded base64url with a 16-byte authentication tag. Plaintext is bounded to **1–65,536 bytes**; the codec returns bytes, not an implicitly approved task. The encrypted inner task/message/result/approval schema is a later layer. This foundation does not pad messages, hide lengths/timing or claim forward secrecy after recipient-key compromise.

The caller supplies pinned native `CryptoKey` objects. The codec accepts P-256 ECDH key pairs, including nonextractable private keys, without exporting them. Mutable headers, key-pair containers and plaintext are snapshotted before asynchronous work. Owned temporary plaintext is cleared on completion/failure where possible; JavaScript/WebCrypto copies and caller-owned memory cannot be guaranteed erased. Errors expose one fixed code, without raw crypto errors, input content or causes. Expiry is checked again after cryptographic work.

## Authentication is not permission or replay consumption

[HPKE's security discussion](https://www.rfc-editor.org/rfc/rfc9180.html#section-9) describes limitations, including application-level replay handling and lack of recipient-compromise forward secrecy. Auth mode is not a digital signature or non-repudiation mechanism, and does not establish source-app authority. Existing source permissions and exact-content approval checks still apply after decryption.

The opener requires the expected complete header from trusted current routing/epoch checks; candidate message/operation/sequence identities must be durably consumed before dispatch. It authenticates sequence and operation identity, but deliberately has no durable replay database. Opening the same envelope twice with the same expectation succeeds cryptographically; a regression test makes this limitation explicit. **Do not dispatch actions directly from this API.** Required integration sequence:

1. Verify current login/device lease, local permission and pinned endpoint keys/epochs; bound in-flight work and validate the candidate incoming identity.
2. Decrypt and strictly validate the encrypted payload; recheck current local/source authority after asynchronous work.
3. Atomically persist receipt, sequence/replay/idempotency state and pending local task/review before acknowledging delivery. Conflicting reuse must fail; an exact duplicate returns its original receipt without executing twice.
4. Execute only through the existing guarded local queue and reviewed source actions. Exact-content approvals bind the proposal/revision/content and cannot be supplied by model output.

Producers need a durable outbox of the **original ciphertext bytes**. Re-encrypting a retry produces a fresh ciphertext and must not silently replace an existing operation. Restore/rollback must disable remote acceptance until its replay/key epochs are reconciled; restoring an old database cannot roll back accepted-message authority.

## Verification and remaining release gates

Tests use disposable WebCrypto keys and public RFC test material. The selected library suite matches the first Auth/P-256/HKDF-SHA256/AES-256-GCM encryption from the [RFC-pinned vectors](https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json). A small fixture records upstream URL/hash and the selected vector; its key material is public test data, never an application credential. Both codec directions interoperate with independent direct HPKE calls. Tests cover each authenticated header field, wrong sender/recipient, modified ciphertext/encapsulation, unexpected epochs/sequences, invalid/expired lifetimes, extra fields, malformed encodings, plaintext fallback rejection, the payload size boundary, mutable-input snapshots, post-operation expiry and concurrent fresh contexts.

This proves bounded implementation behavior under these tests, not full browser/native acceptance or an independent protocol review. Remaining work: authenticated endpoint enrollment and persistence, user-held endpoint recovery and historical-key controls, durable replay/outbox/receipt state across restore, ciphertext-only relay routes/logs/quotas with chosen retention, encrypted payload validation and exact action approvals, offline/reconnect UX, actual browser/native interoperability, signed delivery/update trust and independent review. Local model inference remains on the Mac; Acer's existing news runtime is untouched.

A subsequent [local private-peer enrollment backend](private-peer-enrollment.md) supplies reviewed public-key pins, replacement/revocation history and restore locking in task schema13. It is not yet connected to live invitation exchange or the native/browser UI. Endpoint private-key persistence/recovery, reciprocal enrollment and current network authentication remain open. The subsequent [local task-admission backend](private-task-admission.md) now atomically consumes replay identities with the ordinary task queue, but has no live transport or UI integration.

The subsequent [durable sender backend](private-task-outbox.md) persists original task ciphertext and verifies encrypted queue-acceptance receipts with owner-scoped history and restore locks. This closes local sender persistence for the first task type; live transport, destination receipt production, key lifecycle and other encrypted interaction types remain open.
