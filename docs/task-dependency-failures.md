# Local task prerequisite failures

A dependent task previously stayed queued forever when a prerequisite failed, was cancelled or expired. It could also keep later independent work in the same conversation from starting. The local worker now settles these impossible tasks as **failed** before selecting eligible work. Tasks explains which prerequisites did not complete and that no automatic retry will occur.

The ordinary authenticated request API already accepts up to32 existing, same-owner dependency IDs. This change neither introduces task authority nor treats conversation ordering as an implicit dependency: a later task without an explicit dependency may run after earlier failed work becomes terminal. Creating tasks, reusing prompts, source consent and remote submission remain explicit existing operations.

## Transaction and lifecycle

Each `Store.claim` invocation first performs existing remote-template invalidation and deadline handling. Within the same SQLite immediate transaction it selects at most128 unfinished tasks with a same-user/same-tenant prerequisite already in `failed`, `cancelled` or `expired`. It captures the direct terminal prerequisites in a strict owner-local result, encrypted with the existing per-task result purpose. Each affected task becomes failed, advances its revision/generation, clears worker/lease fields, closes any unfinished run and creates one `dependency_failed` event with its durable outbox entry. It does not create a model run or invoke inference.

Selection is bounded before transitions. Deeper chains and larger batches settle over subsequent worker polls, preserving short bounded transition batches without recursive writes. The Mac launcher already polls every500ms while running; reconciliation does not run while the app is stopped. This is a128-transition bound, not a hard wall-clock or database-scan bound. Existing task/dependency indexes serve the owner/task lookups; queue-wide capacity and broader scheduling remain separate work.

A transient failure that is scheduled for retry remains queued, and a paused prerequisite remains paused. Neither causes dependent failure. Completed dependencies still permit normal execution. Pausing a dependent cannot make an already terminal prerequisite succeed, so that dependent also settles as failed. Its own expired deadline retains the existing expired outcome. Terminal tasks cannot resume, and idempotent creation returns the same saved failure rather than restarting it. Existing supported operations cannot change a completed prerequisite back to unfinished or attach dependencies after creation.

Revisions, encrypted reason, run termination, event and outbox writes commit or roll back together. Terminal records are excluded from later scans, preventing duplicate events. Same-owner checks apply both when creating dependency links and when reconciling them. No source text is copied into failure details: only existing task IDs and terminal statuses are retained. They remain local in ordinary authenticated task reads/export; remote metadata continues to use the unchanged allowlisted status projection. Source-bound tasks retain their existing current-access result concealment.

## Interface and compatibility

The Tasks detail notice lists the direct prerequisite IDs/statuses with a clear terminal explanation. It does not display an inferred model answer. Terminal tasks with no model runs now say **No model run was started** instead of **Waiting to start**. Inspecting failure details does not retry, publish or change grants.

Task schema19 and browser schema1 are unchanged. Existing schema19 stores reopen without a migration; saved encrypted failure results survive restart and supported backup/restore. Older schema19 code preserves these terminal records but does not reconcile additional queued dependency failures. The [separately retained compatibility receipt](evidence/dependency-failure-schema-compatibility-2026-09-23.json) tests current Store source with the actual prepared PR104 schema12 engine: task preservation after upgrade, old-engine refusal and separate original-backup rollback. No personal app, Keychain or data was used.

Six new engine scenarios cover all three terminal causes and deeper chains, transient retries/pauses/success, bounded batches with two open database connections and owner isolation, transaction rollback on outbox failure, actual worker continuation with no blocked-task inference, authenticated local result reads and encrypted backup/restore. The React notice also has desktop/narrow browser coverage in disposable GitHub Chromium/Firefox/WebKit. These fixtures do not constitute personal/native acceptance.

Installed and prepared apps, model defaults, hosted services and Acer-server's model/runtime/news jobs remain unchanged. Mac execution has no Acer inference or fallback.
