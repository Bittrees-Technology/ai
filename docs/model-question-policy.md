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
