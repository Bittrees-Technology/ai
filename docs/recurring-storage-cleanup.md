# Reviewed recurring storage maintenance

The local workflow uses a fixed offline filesystem adapter. The model cannot supply commands or extend its cache scope. Native review binds the preserved original instructions and schedule to a private source fingerprint, and each operation checks the current approval revision and epoch. Revocation cancels in-flight verification and prevents reapproval from reviving it.

The adapter considers only allowlisted reproducible download and compiler caches. It checks repository status, open files, build processes, file identity and recent changes; rejects symlinks, hard links and unknown entries; and revalidates immediately before descriptor-relative removal. Incomplete bounded discovery holds cleanup. Durable encrypted records precede mutation; uncertain outcomes require reconciliation and are not retried with another operation ID.

Reports record measured free-space change, skipped candidates and completion evidence. Native reports use a separate filename from original reports, reuse validated historical measurements, and retain 30 recognized daily reports without removing unrelated logs. Notifications deduplicate unchanged conditions.

Installation alone does not activate this workflow. A private `storage-cleanup-scope.json` in the companion data directory must contain the reviewed `sourceFingerprint`; native review and explicit approval are also required. The verification button clearly discloses that it can perform reviewed cache cleanup. Keep the original schedule active until complete native verification, then pause and verify the unchanged original before enabling its local replacement. Verify the first natural scheduled run separately.

Packaging runs `scripts/build-storage-source.mjs` after TypeScript compilation. This checks the source hash and includes the pinned Python asset; narrow native staging must run it too. Keep private scope files, machine paths and live receipts out of public commits.
