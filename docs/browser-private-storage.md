# Shared browser private storage

Browser endpoint database version4 combined existing key slots, lifecycle and public peer pins with ciphertext task history and durable channel counters. Version5 added [retained browser task permissions](browser-task-consent.md); current **version6** adds encrypted [task preparations](browser-task-composition.md). The [browser check backend](browser-peer-checks.md) uses the shared store and has visible exchange controls. [Permission controls](browser-permission-controls.md) are mounted on the signed-in page; the verified task host supports exact-content review and explicit recovery. The signed-in page mounts [reviewed task controls](browser-task-controls.md); automatic network transport remains unfinished. The Mac wire contracts are shared without changing their encoded fields or hashes.

## Upgrade and recovery

`openBrowserPrivateDatabase` opens the additive version6 database, then fences the actual old ciphertext-outbox writer by upgrading `org.bittrees.ai.private-outbox` from version1 to version2. Version2 preserves its original stores; it exists only to prevent version1 writers from reopening. Normal version-change handling closes existing clients. New outbox consumers wait for migration completion.

The two databases cannot share an IndexedDB transaction. Migration therefore uses a restartable journal:

1. Read and validate each bounded owner partition, including the original owner/channel hashes and a next-sequence counter greater than every retained reservation.
2. Atomically copy unchanged parsed records and their canonical snapshot digest into the common store. Reject conflicting existing records; never overwrite them.
3. Read back and compare the exact copy before deleting that owner's legacy records in a separate transaction.
4. Before marking the migration complete, verify every copied snapshot against its committed digest, reread those exact snapshots in the final write transaction, and account for all source/destination records. A restart after legacy cleanup still performs this verification.

Concurrent migrators serialize their writes, accept an identical committed copy and do not publish two migrations. Old optional receipt/result fields retain their existing null defaults. Invalid records, orphaned entries/counters, changed copies, quota errors and incompatible database versions fail closed without silently discarding records. A committed source cleanup cannot be rolled back across databases; if the only remaining destination copy is subsequently damaged, migration stays unavailable and preserves that copy for diagnosis. No automatic repair, authority restore or downgrade is attempted.

Key-only lifecycle, recovery-kit export and peer maintenance open version6 directly without depending on outbox migration. A broken legacy history must not force key deletion. Upgrading key storage can fence an old key client before a later outbox migration fails; the current recovery APIs remain the supported path. An aborted common-database upgrade leaves the previous database intact.

The journal retains at most32 owner markers, each containing hashed scope, copy digest, counts and cleanup state, plus one completion marker. Migration bounds are256 entries and1024 channels per owner; over-limit histories remain untouched and require an explicit future repair/export path. Same-origin code, storage integrity and the browser profile remain trusted. These checks do not protect against hostile profile rollback, physical corruption or whole-origin deletion.

## Shared sequence reservation and deletion

The original domain-separated owner/device/channel hashes are unchanged. Task and check/response reservations use `reserveBrowserSequence` inside their caller's guarded strict write transaction. The helper validates the stored counter, refuses exhaustion, caps new channels at1024 per owner and never prunes or reuses counters. A failed publication rolls back its counter allocation. It does not supply identity, peer or task authority; check and task callers include current key/peer validation in the same common-database transaction.

Deleting task history removes original-input preparations and their nonextractable keys, plus task, receipt and result ciphertext and locks the existing owner/device marker. It now retains the minimal shared channel counters, because deleting task content must not rewind future device-check sequences. The same device still cannot reinitialize a deleted outbox. Key and public-pin deletion retain their separate existing semantics; exported material is an independent copy.

## Verification and boundaries

Disposable CI builds the actual PR151 key/peer/outbox providers from commit `3d692912ebecb14a04748b92226435ef1eb36e9f`, checking each source hash. The previous APIs create retained nonextractable keys, an encrypted recovery kit, a reviewed peer pin, all four outbox states, and real authenticated receipt/result ciphertext. Migration tests check exact preservation and result decryption after reload, old-client refusal, concurrent multi-owner upgrade, deletion locks, interrupted copy/cleanup/final publication, copied-data corruption, orphan/counter denial with key recovery still available, shared allocation and rollback, and capacity/exhaustion. Faults are injected into real IndexedDB operations; they do not simulate physical disk failure. Existing PR143/149 key-compatibility and browser protocol tests remain required.

This is repository/CI integration, not a personal-profile migration or live deployment. Mac task schema23, remote database schema8, installed PR40, prepared PR142 and Mac model defaults are unchanged. Acer-server's existing model, runtime and news jobs remain unchanged; Mac inference has no Acer fallback. Automatic private transport, relay retention, independent protocol review and personal browser/native acceptance remain open.
