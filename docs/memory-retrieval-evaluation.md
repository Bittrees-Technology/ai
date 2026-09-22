# Local memory retrieval evaluation

The `duplicate-crowding-v1` fixture is synthetic and uses an isolated in-memory store, a fixed clock and 110 approved records. It contains 105 copies of one short text, each with its own source, plus five distinct relevant texts. The expected six texts are manually enumerated in `scripts/memory-retrieval-check.ts`. It performs no inference and accesses no personal store.

Run with Node 24:

```sh
node --import tsx scripts/memory-retrieval-check.ts
```

Baseline: main `17902f30bae4e3f9d6b66a8830ad2ef9824a8111`, before the retrieval change. The same fixture was run before and after. Saved JSON output is under `docs/evidence/memory-retrieval/`.

| Measurement | Before | After |
| --- | ---: | ---: |
| Requested/returned results | 6 / 6 | 6 / 6 |
| Distinct texts returned | 1 | 6 |
| Recall of six expected distinct texts | 1/6 | 6/6 |
| Duplicate result slots | 5 | 0 |
| Original stored records | 110 | 110 |

The initial full-text shortlist of 100 could consist entirely of copies. Search now considers up to the existing 1,000-record owner ceiling and returns at most one exact text per memory type, after access/version checks. Existing relevance, freshness, bounded feedback and pin ordering choose the representative. Search does not merge sources, approval state or feedback, and does not delete records. Each representative carries only its own current authorized provenance. A denied candidate does not prevent an authorized copy from being considered.

The comparison key deliberately preserves case, whitespace and punctuation. Negated or differently worded statements remain distinct; conflicting statements are not automatically reconciled. This avoids treating meaningful changes, including code indentation, as identical. Semantic deduplication and contradiction handling remain separate work.

Regression tests additionally verify owner isolation, preservation of different text/type variants, retained records, access revocation during final checks and unverified labels. Existing expiry, stale-version, deletion and worker checks still apply. This fixture demonstrates removal of exact-copy crowding only; it does not establish general relevance quality, source diversity, multilingual accuracy or a reason to add embeddings. Broader held-out and user-reviewed evaluation remains open.
