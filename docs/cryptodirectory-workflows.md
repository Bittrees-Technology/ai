# CryptoDirectory local workflows

The Mac companion owns two recurring public-source workflows under **Workflows & permissions → CryptoDirectory**. Enable them with an existing CryptoDirectory checkout and a local model profile. They run while the companion is open, survive restarts, and can be paused together. They use the same model queue and execution controls as investor research and CRM tasks. They do not access Acer's news model.

- **Discovery, daily:** inspect up to ten new project websites from the public DeFiLlama catalogue, excluding domains already in the directory. Rotate through candidates across runs. Match against existing directory tags. This first source provides limited coverage outside DeFi; it is not a search of all projects or all tags.
- **Validation, hourly:** rotate through up to ten existing listings, fetch their public website, and compare the listed facts with source text. Save quotations and explicitly report unsupported or conflicting information. Failed requests advance the rotation and are retried on a later complete sweep. Network restrictions are not bypassed.

Results are encrypted in `crypto-directory.db` beside the active local content stores. The recent view shows 100 results; individual assessments remain stored. Source-assessed means the model returned quotations found in the fetched text. It does not mean a human reviewed the entry, a product was security-audited, or investment suitability was established. Models may still misinterpret evidence. The worker never converts a source assessment into the directory's `verified` status.

No listing or published file is modified. Findings are local research for the next curation pass; the weekly IPNS publisher still publishes checked repository releases only. The current scripts/auto-first-pass.mjs formatting check is not used as evidence by these workflows.

Authenticated local API (same pairing/token rules as the other companion APIs):

- `GET /v1/research/directory`: configuration, both workflow states, counters, next eligible times, recent findings.
- `POST /v1/research/directory/configure`: `{enabled:true,confirmed:true,repository:"/absolute/crypto-directory",profileId:"existing-profile-id"}`.
- `POST /v1/research/directory/pause`: cancel the active directory pass and disable future passes.

The paired workflow catalogue sends only fixed workflow identifiers, kind, revision, and state; no source text, local paths, model output, or configuration is sent. Deploy the server's catalogue-kind update before enabling the new companion entries.


## Execution evidence and follow-up validation

Each attempted page assessment now has a durable receipt: run ID, source URL,
model identity and digest, model start/end times, source text fingerprint, and
saved-result fingerprint. A task is completed only in the same transaction
that saves its grounded assessment. Source/model failures and interrupted work
are separate states; they are never counted as completed assessments. The app
shows the latest 100 receipts; historical receipts remain encrypted locally.

A fitting discovery result automatically queues validation, including existing
discoveries saved before this update. The queue survives app restarts, links each
validation result to its discovery parent, and prevents duplicate handoffs for
the same parent. Follow-ups run before the next scheduled catalogue pass. Failed
follow-ups retry after one and two hours; three unsuccessful attempts leave an
explicit needs-attention item. Pausing does not consume a retry attempt.

The owner-only workflow catalogue receives bounded receipt counts, follow-up
counts, and the latest receipt ID/evidence fingerprint. Quotes and project URLs
remain local. Counts describe the recent receipt window, not lifetime totals.
Old results are not given fabricated model-execution receipts. Validation remains
an automated source assessment: it neither publishes listings nor certifies
security or unsupported facts. Local execution requires the Mac/app/model to be
available and execution permissions to remain enabled.
