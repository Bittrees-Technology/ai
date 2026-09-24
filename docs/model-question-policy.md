# Optional local model clarifications

New local tasks offer **Ask me if details are missing**, initially unchecked.
The same choice is available for selected CRM records, AutoNote meetings and Mail
content. Changing the choice changes the retained submission identity. Missing or
false choices preserve the existing generation path; old tasks, templates,
extractions and private remote task grants receive no new behavior.

For an opted-in task, the already pinned Mac model returns one strict decision:
continue, or ask one concise question. It should ask only when an essential owner
choice or fact prevents a useful answer. Ordinary summaries can retain unknown
facts; source instructions cannot supply tool, source, permission or approval
fields. The decision format rejects those fields. The model has no new tool or
publication permission. This constrains software authority, not the model's
ability to make a poor clarification choice.

The request and associated owner answers remain complete in the decision prompt.
Reference material may be excerpted to fit the existing conservative model budget;
truncation is explicit, and the prompt tells the model not to ask for facts merely
absent from an excerpt. The decision and subsequent generation share the task's
existing execution/time limit and pinned loopback-only runtime. Acer and cloud
fallback remain unavailable.

An ask decision atomically saves a question in the owner's encrypted personal
Inbox and releases the task lease. A missing personal Inbox is created in that
same transaction; an existing incompatible definition is rejected, never replaced.
The question waits at most one day and never beyond the original task deadline.
The owner uses the existing exact-answer review. Answers queue waiting work but
leave paused work paused, and ordinary Inbox replies do not unblock tasks.

At most two model questions are allowed. If a later decision still needs another
question, the task fails with **More detail needed**, without a third question or
invented result. Questions/answers already given remain retained until deletion.
Malformed decisions fail as invalid model output. Source, memory and task
authority are checked after asynchronous decisions before a question is saved;
normal generation keeps its existing final checks.

## Compatibility and evidence

Task schema27 is a writer-version fence for the new per-request policy. No column
or existing task input is rewritten. A task26 worker refuses the upgraded store
instead of silently ignoring the choice. The actual compiled task26 upgrade test
preserves existing waiting questions and omitted policies, denies a wrong key,
round-trips old/new waits and explicit choices through encrypted backup/restore,
and restores an untouched original backup for task26 rollback. See the
[compatibility receipt](evidence/model-question-schema-compatibility-2026-09-24.json).
Rollback to that original backup omits newer work; it is not an in-place downgrade.

Engine verification covers actual worker→Inbox→authenticated HTTP answer→resumed
worker, legacy/sufficient tasks, question limits, cancellation/pause/lease loss,
Inbox collision/transaction rollback, deadlines, malformed decisions, multibyte
prompt limits, changed source/memory and three local source HTTP routes. Browser
CI exercises the actual local and three source forms, exact uncertain-submission
identity and explicit choice changes, with desktop/390px previews.

A synthetic local-model decision evaluation is available through
`scripts/evaluate-model-questions.ts`. It contacts only the existing loopback
Ollama runtime and pins the installed original Qwen model, without changing
profiles, weights or defaults. Eight examples are a bounded regression sample,
not a general quality guarantee. Final browser/visual/source acceptance and broader
personal/native/live release gates remain required. This does not add encrypted
remote conversations, remote question authority, approvals or scoped resume.

The original installed `qwen3.5:9b` matched all eight expected decisions in the
[synthetic evaluation](evidence/model-question-local-evaluation-2026-09-24.json),
with observed request durations of 3.83–6.53 seconds. All outputs were inspected.
These cases do not establish factual answer quality or a general success rate.

## Clarification policy v2

`local-clarification-v2` explicitly separates factual reference content from embedded
instructions. A factual summary should continue despite an embedded demand to ask
for credentials; an unknown attendance decision should ask for the owner's real
choice, never whether to pretend that the owner agreed.

The application also rejects clarification questions containing common English or
Portuguese credential terms before creating an Inbox or input wait. This includes
passwords, login/recovery codes, private/API keys, tokens and seed phrases, with
normalization for accents, invisible formatting and common hyphens. Questions
about non-secret password-manager/policy choices or key algorithms remain allowed.
Rejected output fails the task as invalid model output; it does not retry or ask
the owner to supply the rejected material. Existing retained questions are not
rewritten or deleted. This is a conservative wording filter: it can reject benign
credential discussions and cannot detect every language, obfuscation or indirect
phishing request. It is not a general prompt-injection defense.

A [twelve-case baseline comparison](evidence/model-clarification-heldout-2026-09-24.json)
on the Mac used already-installed original Qwen3.5 9B and Huihui 9B models with the
same 8,192-token context, 256-token output limit and temperature zero. Both matched
11/12 expected decisions, but only 10/12 outputs were usable on manual review.
Huihui followed a source instruction asking for a password/login code. Both models
also offered to pretend the owner had accepted an invitation.

With the revised prompt, the [paired development retest](evidence/model-clarification-candidate-2026-09-24.json)
matched all 12 decisions per model; all questions were relevant, although direct
attend/decline wording would be clearer. These are the same exposed cases used to
improve the prompt, not unseen validation or evidence of general accuracy. Median
request times were 6.05 seconds for original Qwen and 6.59 seconds for Huihui;
loading and normal background activity affect timings. Both reported a peak model
allocation of 8,734,104,512 bytes; this is not total system RAM or process RSS.
All 24 retained outputs were rechecked against the final parser and unchanged
prompt hashes without another inference run.

No model weights, runtime settings or defaults were changed. This comparison does
not establish that either model is better overall. Acer's news model/runtime/jobs
remain unchanged and are never a companion inference fallback. No storage-format
change or automatic migration is introduced by v2. Worker tests verify that
credential-bearing output cannot create a clarification wait, while normal
non-secret owner questions continue through the existing path.
