# Local memory dependencies

The companion now hides a task's content and run history when a local memory it used is missing, expired, no longer approved, or at a different revision. This also applies transitively: if task A supplies memory B, and task C uses B, losing A's own reference invalidates C and memories derived from C. Memory-suggestion prompts contain copied source text, so their parent task and its recorded revision are checked too.

A new task can use the currently approved references. A pin or approval change increments a memory's revision; previously generated output is conservatively hidden even if the text is unchanged. Reverting wording does not restore an older revision. This does not delete retained task results or reviews, automatically regenerate work, or make a memory verified.

## Boundaries

- The trusted worker's latest model snapshot supplies exact selected memory IDs and revisions. Completed memory-backed tasks without a matching snapshot are unavailable. Queued work checks currently approved references until a run records its selection.
- Every memory reference must lead to a completed, unchanged local task belonging to the same owner and tenant. Connected-app tasks and external references do not gain memory authority through this feature.
- A synchronous provenance walk checks current memory approval, expiry, revision, source task revision and nested extraction dependencies. Cycles, more than 64 dependency levels or a 1,000-visit budget fail closed. Task/memory change tokens fence concurrent store writes during the walk.
- `MemoryStore.dependencySources` returns metadata for this walk; it is not an access grant. The local access callback also supplies a synchronous final check after asynchronous validation, preventing earlier successful reads or candidate writes from surviving local ancestor invalidation.
- The worker checks dependencies before preparing inference and immediately before saving output. A late result cannot replace the failed task after dependency loss. Existing cancellation and source checks remain in force.
- Local task lists/details, individual exports, run history, quality reviews and memory-suggestion preparation/review/save enforce the checks. Bulk export conceals dependent task prompts/results and omits their extracted-memory history and quality-review content. Memory get/search/export uses the same transitive local checks. The dashboard explains unavailable references, hides reuse/review/suggestion controls, and discards late history responses when access changes.

Raw encrypted storage and encrypted recovery backups retain historical content until the user deletes it. They are recovery artifacts, not content-authorized response interfaces. No asynchronous transaction or permanent plaintext search index was added.

## Compatibility and evidence

Task schema **21** is an access-behavior boundary; it adds no table or content rewrite. Schema20 and older companion engines refuse it so an older implementation cannot open an upgraded store without these dependency checks. Memory schema2, import schema1 and browser schema1 are unchanged. Original older backups can be restored separately with compatible helpers; they contain historical data and the older access behavior, and do not carry forward later changes or deletions.

[Actual prepared-engine compatibility receipt](evidence/local-memory-dependency-schema-compatibility-2026-09-23.json) records a task20→21 upgrade using the extracted PR134 engine and a synthetic three-task/two-memory chain, review preservation, current coordinated restore with dependency denial, refusal by the actual older engine, and separately restored original task20/memory2 backup. Reproduce after building with:

```sh
node scripts/check-local-memory-dependency-upgrade.mjs '/path/to/PR134/Bittrees AI.app/Contents/Resources/engine'
```

`tests/local-memory-dependencies.test.ts` covers deletion, text/approval/pin changes, expiry, ancestor task deletion, ownership, absent stores/snapshots, mismatched versions/IDs, cycles/bounds, worker refusal, authenticated API/export concealment and invalidation between validation and final read/write. Existing worker race tests use actual local provenance. Browser tests cover unavailable-reference controls, desktop/narrow layouts and late history after access changes; they run only in disposable GitHub CI.

These are local dependency and synthetic compatibility checks. External-source/cross-app memory, semantic retrieval quality, personal data upgrades, native interaction and independent acceptance remain open. The installed Mac app, models/defaults, source grants, hosting and Acer-server's model/runtime/news processing are unchanged.
