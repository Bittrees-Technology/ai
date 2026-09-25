# Retained encrypted resume offers

A Mac resume permission can now prepare an encrypted offer for its exact paired browser, task revision and local model identity. The payload contains no task prompt, source content or publication permissions. An offer is information for a separate browser review; possession does not authorize a resume.

Preparation requires current private consent, unchanged local key and peer proofs, an unused resume permission, and the original paused task revision. It reserves the shared outgoing sequence and stores the encrypted preparation in one transaction. A failed write rolls back both. The request ID is retained: exact retries reuse the record, while changed requests conflict.

Explicit encryption retains one original ciphertext. Concurrent independent lifecycles converge on the committed envelope; reopening and later retrieval preserve it. Each encryption/reveal rechecks current authority and the unchanged paused task. Revoked, expired, changed, recovered or stopped entries cannot be published. Stopping needs no remote connection and does not revoke the separately saved resume permission.

Schema 38 adds owner-scoped encrypted offer storage with a 256-record bound. Owner export includes offers, deletion erases them and recovery locks them. The actual compiled schema-37 source is pinned by source/archive/module hashes. Upgrade acceptance preserves unused and consumed private grants, task/profile state and the original encrypted request/reply; the old writer refuses schema 38. The untouched old backup can still roll back using the old writer, with authority locked.

This internal package exposes no new HTTP route or network sender. Mac offer review/delivery, independent browser consent, atomic shared browser replay admission, relay retries/acknowledgements and browser command/receipt controls remain required. No startup flag, installed app, model default or Acer news job is changed.

Eight new engine tests cover original ciphertext, concurrency/reopen, scope, strict request identity, expiry/stop, changed tasks, revoke-during-key-resolution, rollback after injected insertion failure, export/deletion and locked recovery. Browser/native CI and current migration artifacts are required before integration. The unresolved shared delivery review failure continues to gate merging.

Validation before CI: all 934 engine tests pass, typecheck/builds and unchanged public contract export pass. Pinned actual 37→38, 36→38 and 35→38 storage checks and the historical 31→38 authenticated conversation check pass locally using disposable synthetic state. Focused conversation CI now retains traces/error context on failure without changing assertions, retries or timeouts. The independent Mac resume UI check runs even when that earlier step fails; the failed job still blocks acceptance and the full suite is not bypassed.
