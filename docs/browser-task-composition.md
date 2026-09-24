# Reviewed browser task composition and recovery

The verified browser host can prepare source-free query, summarize and draft tasks for one independently consented Mac. A separate one-use review captures the exact input, peer and current permission before confirmation. Returning or editing the displayed review cannot change the retained input. Confirmation requires both explicit confirmation and acknowledgement, consumes the review before any asynchronous work, and keeps its original two-minute wall and monotonic deadline through publication.

The signed-in page now mounts [reviewed task controls](browser-task-controls.md). Encrypted handoff remains explicit; automatic transport is not connected. No task operation chooses a model, memory, source, tool, conversation, approval or publication authority. The Mac remains responsible for its own consent and local execution profile. Acer-server inference and news jobs are unchanged and are never a fallback.

## Durable preparation

The complete strict task payload is serialized and checked against the 65,536-byte envelope limit before reserving anything. The limit counts UTF-8 and JSON escaping, not only prompt characters.

A preparation encrypts that exact payload under a random nonextractable AES-256-GCM key with a random 96-bit IV. Authenticated data binds the original operation, owner scope, exact sending context and issue/expiry times. A single strict IndexedDB transaction commits the preparation, reserved entry and shared sender sequence under current retained key, peer, possession-check and permission validation. A full disk or failed transaction cannot leave a counter consumed without its preparation.

The task is then sealed for the Mac and committed under the same guarded authority. The publication transaction compares the retained preparation metadata/ciphertext. It does not export a local key handle. Invalidation, elapsed review time, revoked or changed consent and local identity changes deny publication even when encryption started earlier.

## Explicit recovery

A restart after reservation reads the saved encrypted input and original header, verifies current authority, and finishes the same operation. It never extends the deadline or assigns a replacement operation/sequence. A committed task returns its exact saved ciphertext, including when another tab wins publication or final server verification was lost. It does not encrypt committed ciphertext again. A stale expected revision can reconcile an already committed operation; a still-reserved task requires its exact revision. Delivery separately requires an exact current revision inside the transaction.

Confirmation is never retried automatically. The caller must inspect history and explicitly resume the saved operation. A lost server response can follow a successful local commit, so failure must not be presented as proof that nothing was saved. Stopped, expired, damaged or differently authorized reservations cannot be resumed. A fresh grant has a different permission identity and cannot authorize an older task.

## Owner-local history

The host exposes status, explicit export, stop and deletion under its established signed-in owner/scope without requiring active sending permission or a live registration request. Logout, scope change and cancellation still invalidate these operations.

Export includes this browser's original reviewed input and encrypted wire history. It deliberately releases the owner's own task input only after explicit export confirmation and exact history revision; Mac results remain encrypted. Reading a result still uses current verified identity and the retained result permission. Exports contain no preparation key or restore authority. Already exported copies are independent.

Stop preserves content and prevents subsequent retries. It cannot retract copied ciphertext or cancel a task already accepted by the Mac. Deletion removes entries and preparation keys/ciphertext, retains the minimal shared sequence counters, and locks the existing device marker. Setup/reset remain explicit and use a narrow verified host initializer before keys or permission pairing. Initialization creates no task authority; reset requires a different freshly verified browser device identity. There is no automatic retention cleanup; input/history stay until owner deletion. Corrupt preparation contents can still be cleared when the owner marker and expected revision remain valid.

At most256 task entries/preparations are retained per owner. Browser origin code, profile integrity and the existing owner context remain trusted. This local encryption is not hardware-backed protection or protection against malicious same-origin code/profile rollback. Owned byte buffers are cleared where possible; JavaScript strings/runtime copies cannot be reliably erased.

## Compatibility and verification

Common browser database6 adds only `task_preparations`. Existing entries retain their old shape; new entries carry `composed: true`. CI builds the actual PR156 provider at `9fbecfcc864843fc59fd43daf447f65178244be7` from its hash-verified module archive, creates database5 history through that provider, then checks preserved keys, permissions and exact ciphertext, monotonic sequence allocation, old-writer refusal and failed-upgrade rollback. Legacy reservations without saved input cannot be reconstructed by this feature.

Disposable GitHub Chromium, Firefox and WebKit exercise real IndexedDB/WebCrypto and the actual Mac receiver/worker with synthetic input/output. Verified-host coverage uses real SIWE, HTTPS cookies and PostgreSQL. No personal browser, installed Mac app, personal Keychain or local model is used. Mac task schema23 and remote database8 are unchanged. Live relay retention, independent protocol review and personal/native acceptance remain outstanding.
