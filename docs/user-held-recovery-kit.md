# User-held local storage recovery kit — v1 foundation

This module wraps the existing personal storage key for recovery after losing its Keychain entry. Kit creation and recovery have native development previews, disabled by default; there is no HTTP or public CLI exposure. Independent crypto review and native acceptance remain open. No personal key was exported during implementation.

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

Remaining work includes independent crypto review, acceptance of the native setup preview, recovery input without command-line/log exposure, acceptance of the native add-only recovery workflow, rotation/revocation and real-device acceptance. Existing backup UI continues to explain its current original-Keychain requirement.

## Evidence

Synthetic tests verify randomized fixed-size output, caller-key preservation, every byte's integrity, wrong codes and malformed/truncated/extended files, strict canonical code encoding, and both directions of Node/WebCrypto interoperability. An actual paired task+memory backup is restored through the kit with no Keychain access, while wrong/mismatched kits leave no recovered copy. Preparation rejects absent/invalid/locked fake entries without writes, and occupied-port rejection happens before recovery. These are engineering tests, not independent cryptographic or native interaction acceptance.

## Verified add-only installation foundation

`installRecoveredKey` remains the separate-copy coordinator. The gated native workflow uses `recoverAndActivateWithKit` through the same validation and installation implementation; neither is an HTTP/public CLI entry point. It holds the companion port, authenticates the kit, rejects an existing different or invalid key, checks current task/memory key verifiers and existing encrypted import jobs through read-only SQLite connections, and restores the selected coordinated backup into a separate validated copy before attempting key installation. Missing/unsupported verifiers or unreadable current stores fail closed. The ownership check does not migrate databases or claim complete data integrity; inactive retained copies are not re-encrypted or activated.

Installation uses an `AddOnlySecretEntry` contract. The Mac adapter invokes a bundled native helper with exactly 32 binary bytes over standard input; no key enters command-line arguments, environment, stdout or stderr. The helper uses Apple's [SecItemAdd](https://developer.apple.com/documentation/security/secitemadd(_:_:)) and treats [errSecDuplicateItem](https://developer.apple.com/documentation/security/errsecduplicateitem) as “already exists.” It contains no update or delete operation. The generic-password service/account and explicit user-domain keychain match the current keyring backend. Selecting that domain uses a deprecated but available macOS API; moving to a different keychain backend requires a separate migration, not a silent change here.

The coordinator reads back and compares the stored key. It reports `created`, `already-present`, `conflict` or `unconfirmed`, always with `activated:false` and the verified copy location. A conflicting concurrent insertion is preserved. A helper timeout, lost acknowledgement or verification failure does not imply that no key was written: the copy remains available and no credential is deleted as rollback. Explicit retry can reconcile an already-present matching key. Production callers must present unconfirmed/conflict outcomes for review and must not treat them as successful recovery or retry silently.

The helper is built into development packages and connected only through the default-off native recovery preview. The gated setup preview below implements code display/save confirmation. The native preview below supplies authenticated recovery input through private pipes. End-to-end native access prompts, signed delivery and independent crypto review remain open. Helper-created entries may require a later native Keychain access decision; matching-key and add-only tests are not proof of unattended personal-device recovery.

Tests exercise correct/matching/conflicting entries, task/memory/import mismatch before writes, backup mismatch, locked adapters, competing insertion, lost acknowledgement and explicit reconciliation, plus port exclusion. `scripts/check-macos-key-install.sh` verifies actual add-only macOS behavior using a disposable `recovery-test-*` credential, and verifies that the helper cannot replace an existing entry created by the actual keyring addon. Synthetic entries are removed; personal entries are never read or changed. The test helper suppresses Keychain interaction, and CI repeats the same bounded checks before packaging.


## Native setup preview (default off)

A source-built Mac shell launched with `BITTREES_RECOVERY_PREVIEW=1` exposes **Set up recovery kit (preview)…**. The ordinary app menu has no setup entry. The confirmation explains the preview status and three required recovery items. Creation reads only the existing personal storage key; it never creates, replaces or installs a key. The engine continues running and no model service is restarted.

A dedicated bundled worker accepts one strict, explicitly confirmed request over native stdin/stdout pipes. It checks the preview gate and pipe descriptors before key access, bounds the request to 128 bytes, and emits only the kit/code response. There is no HTTP route, secret command-line argument, environment-carried secret or error logging. Pipes and an environment flag are transport/preview constraints, not an authorization boundary against other processes already running as the same user. The shell bounds the response to 2 KiB and validates its exact field set, version, canonical code/base64, kit length, magic and identifier. Worker failure or a 60-second deadline ends setup with a fixed message.

The native dialog displays the recovery code and offers an explicit clipboard copy. The next dialog hides it and requires re-entry from the saved copy before enabling kit saving; three mismatches cancel setup. The user can paste a saved code, so this confirms possession rather than proving durable external storage. The code/session expires after ten minutes. Cancellation, Quit, engine failure and stale callbacks discard the in-memory session. Clipboard contents are user-controlled and are not automatically cleared. Swift strings, alert controls, clipboard history and runtime copies prevent any guarantee of secret-memory erasure.

Only the encrypted 116-byte kit is saved. A private sibling directory/file (0700/0600), file synchronization and no-overwrite hard-link publication prevent replacing an existing file or symlink and avoid publishing a partially written kit. Filesystems that cannot support that operation fail rather than downgrade it. Ordinary failures remove staging files; a process crash may leave a private staging directory, and directory-entry power-loss durability is not guaranteed. The recovery code is never included in the kit file. Creating another kit does not revoke earlier kits.

Synthetic protocol tests cover strict confirmation, absent/locked entries without key creation, successful unwrapping and silent denial without the preview gate. Compiled Swift checks cover code confirmation, attempt limits, malformed response rejection, private save permissions, existing-file/symlink refusal and staging cleanup. The full shell is typechecked and packaged in CI. Native interaction, personal Keychain prompts, expiry/cancellation while dialogs are displayed and real-device acceptance still require manual review; tests have not exported a personal key. The installed app and prepared PR98 archive do not contain this preview. All work is Mac-only; the Acer-server model and news processing remain unchanged.


## Native kit recovery preview (default off)

With `BITTREES_RECOVERY_PREVIEW=1`, the Mac shell offers recovery before engine startup and a **Recover with kit (preview)…** menu. A fresh device must recover before ordinary startup creates a new unrelated storage key. In this preview, an engine startup failure leaves recovery accessible instead of exiting the app. Default-off startup behavior remains the same.

The user selects a coordinated `.aib` backup and matching `.btkey` kit, enters the saved code in a secure native text field and explicitly confirms recovery and selection. The shell discards its web session, stops only its own engine when present, and waits for its exit. Secret input goes to a bundled worker over stdin; no secret arguments, environment values, logs, HTTP or dashboard fields are used. Request size is bounded to 32 KiB with strict fields/absolute paths; the worker fixes the personal base and bundled KeyInstall helper itself. It opens the kit without following symlinks or blocking on special files and accepts exactly 116 bytes. Private pipes and the preview flag do not authenticate against another process running as the same user.

One exclusive companion-port operation validates current store ownership and the backup, restores a new private managed copy, performs add-only key installation and reads the key back. Only a confirmed matching key permits atomic content selection. A fresh device may need private directories created, but recovery never creates a new unrelated key. Current copies are retained and the old selection becomes the rollback target. Remote control/template consent is cleared by restoration. A first-ever recovery has no prior original dataset to roll back to.

The reply contains only a version, activation flag and key status, or an allowlisted error code. The native parser rejects extra fields, malformed types, unknown statuses and inconsistent activation claims. Confirmed activation offers **Open companion**; other outcomes leave the engine stopped and require explicit review/retry. If selection fails after a verified key installation, both key and recovered copy are retained. Conflicts and unconfirmed writes never select the copy, replace credentials, roll back a key or silently retry. The shell does not infer that a missing/failed reply means no write occurred. Retained complete copies can be inspected through Device after normal operation is restored; they remain under the personal `stores` directory.

Quit before the owned engine exits skips recovery. Quit during a recovery operation waits for completion without killing the worker or starting the engine. Unlike read-only kit creation, there is deliberately no shell timeout that kills recovery during a possibly completed key write. Native access prompts or a stalled provider can therefore require attention; they are not treated as proof of failure. Input buffers are cleared where owned, but Swift/JavaScript strings, process internals and field/runtime copies prevent guaranteed memory erasure.

Synthetic tests restore real task and memory data on a fresh target, preserve previous selected copies, reject invalid/extra/unconfirmed/symlink input before key reads, exercise uncertain/conflicting writes and selection failure, and verify explicit successful retry. Compiled Swift tests cover fresh-device/live-engine sequencing, Quit before/during recovery and strict success/error parsing. Existing native disposable-key tests cover helper/addon interoperability. These do not prove end-to-end personal Keychain prompts, dialogs, keyboard/accessibility, process crashes, power-loss durability or trusted signed distribution. No personal kit recovery, installed-app replacement or Acer-server change occurred.
