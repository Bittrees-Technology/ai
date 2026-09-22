# User-held local storage recovery kit — v1 foundation

This module wraps the existing personal storage key for recovery after losing its Keychain entry. It is not yet exposed through HTTP, a CLI, or native menus, and it does not install keys. Independent crypto review and trusted delivery/confirmation remain open. No personal key was exported during implementation.

Recovery requires three separately understood items: a coordinated `.aib` content backup, a 116-byte encrypted key kit, and its independently generated recovery code. The kit alone contains neither plaintext storage key nor code. The code alone does not contain the storage key or task data. Possession of kit plus code recovers the storage key and can decrypt backups encrypted under that key. Keep the code separately from the kit/backup. If both the original key and recovery materials are lost, this module has no provider recovery mechanism.

## Format and construction

The recovery code is `btr1_` followed by the canonical, unpadded base64url encoding of 32 random bytes. It is generated using Node's cryptographic random generator; it is not a user-chosen password. Decoding requires exactly 48 characters and a canonical 32-byte value. No algorithm, iteration-count or allocation setting is accepted from the file.

| Byte range (end excluded) | Contents |
| --- | --- |
| 0–8 | ASCII `BTKEY01` followed by newline |
| 8–24 | Random 16-byte kit identifier |
| 24–56 | Random 32-byte HKDF salt |
| 56–68 | Random 12-byte AES-GCM nonce |
| 68–100 | Encrypted 32-byte personal storage key |
| 100–116 | Full 16-byte GCM authentication tag |

Derive 32 wrapping-key bytes with HKDF-SHA-256: recovery-code bytes as input key material, the kit salt, and UTF-8 `org.bittrees.ai/local-storage-recovery/v1` as context. Encrypt the storage key with AES-256-GCM. Associated data is the context followed by the complete 68-byte header, binding format, kit identifier, salt and nonce. Each creation generates fresh code, identifier, salt and nonce. Unknown magic/version, any nonexact file size, malformed/noncanonical code and authentication failure are rejected with a fixed error.

The HKDF construction follows [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html). Implementation uses [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen) and specifies a 16-byte GCM tag explicitly. No plaintext key is returned before successful final authentication, consistent with [Node's authenticated decryption contract](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding). This choice of primitives and passing tests do not establish independent review of the whole recovery design.

## Implemented flow and limits

`prepareUserRecoveryKit` requires an existing valid storage key. Missing, invalid or locked Keychain adapters fail without creating/replacing a key. It returns the encrypted kit and sensitive recovery code in memory only. Nothing is logged, uploaded or written automatically.

`recoverContentWithKit` holds the same loopback port as offline recovery, unwraps the key, and restores the selected coordinated backup into a new private directory. Both task and memory stores must pass existing key/schema checks. It returns `activated:false` and `keyInstalled:false`: current content and Keychain entries remain untouched. Existing restore logic clears old remote permissions and current source checks still apply when reading recovered data. A mismatched kit can authenticate successfully but cannot restore a backup encrypted under another storage key.

Owned temporary key/plaintext buffers are cleared in `finally` paths. The returned code is a JavaScript string and the cryptographic runtime may hold internal copies; this is not a guarantee of process-memory erasure. Callers of `recoverStorageKey` own the returned buffer and must clear it after use.

Generating another kit does not revoke old kits or change the storage key. Revoking previously disclosed recovery materials requires a separately designed storage-key rotation and re-encryption workflow. This module does not define remote recipient keys, device enrollment, key epochs, credential recovery, signed update trust or R2 encryption. Do not reuse the local-storage key as a remote endpoint key.

Remaining work includes independent crypto review, native kit export with explicit secret-display/save confirmation, verifying that the user retained the code, recovery input without command-line/log exposure, a non-overwriting verified Keychain installation workflow, rotation/revocation and native/real-device acceptance. Existing backup UI continues to explain its current original-Keychain requirement.

## Evidence

Synthetic tests verify randomized fixed-size output, caller-key preservation, every byte's integrity, wrong codes and malformed/truncated/extended files, strict canonical code encoding, and both directions of Node/WebCrypto interoperability. An actual paired task+memory backup is restored through the kit with no Keychain access, while wrong/mismatched kits leave no recovered copy. Preparation rejects absent/invalid/locked fake entries without writes, and occupied-port rejection happens before recovery. These are engineering tests, not independent cryptographic or native interaction acceptance.

## Verified add-only installation foundation

`installRecoveredKey` is an internal coordinator with no app/HTTP/CLI entry point. It holds the companion port, authenticates the kit, rejects an existing different or invalid key, checks current task/memory key verifiers and existing encrypted import jobs through read-only SQLite connections, and restores the selected coordinated backup into a separate validated copy before attempting key installation. Missing/unsupported verifiers or unreadable current stores fail closed. The ownership check does not migrate databases or claim complete data integrity; inactive retained copies are not re-encrypted or activated.

Installation uses an `AddOnlySecretEntry` contract. The Mac adapter invokes a bundled native helper with exactly 32 binary bytes over standard input; no key enters command-line arguments, environment, stdout or stderr. The helper uses Apple's [SecItemAdd](https://developer.apple.com/documentation/security/secitemadd(_:_:)) and treats [errSecDuplicateItem](https://developer.apple.com/documentation/security/errsecduplicateitem) as “already exists.” It contains no update or delete operation. The generic-password service/account and explicit user-domain keychain match the current keyring backend. Selecting that domain uses a deprecated but available macOS API; moving to a different keychain backend requires a separate migration, not a silent change here.

The coordinator reads back and compares the stored key. It reports `created`, `already-present`, `conflict` or `unconfirmed`, always with `activated:false` and the verified copy location. A conflicting concurrent insertion is preserved. A helper timeout, lost acknowledgement or verification failure does not imply that no key was written: the copy remains available and no credential is deleted as rollback. Explicit retry can reconcile an already-present matching key. Production callers must present unconfirmed/conflict outcomes for review and must not treat them as successful recovery or retry silently.

The helper is built into development packages but is not connected to user-facing recovery. Code display/save confirmation, authenticated recovery input, end-to-end native access prompts, signed delivery and independent crypto review remain open. Helper-created entries may require a later native Keychain access decision; matching-key and add-only tests are not proof of unattended personal-device recovery.

Tests exercise correct/matching/conflicting entries, task/memory/import mismatch before writes, backup mismatch, locked adapters, competing insertion, lost acknowledgement and explicit reconciliation, plus port exclusion. `scripts/check-macos-key-install.sh` verifies actual add-only macOS behavior using a disposable `recovery-test-*` credential, and verifies that the helper cannot replace an existing entry created by the actual keyring addon. Synthetic entries are removed; personal entries are never read or changed. The test helper suppresses Keychain interaction, and CI repeats the same bounded checks before packaging.
