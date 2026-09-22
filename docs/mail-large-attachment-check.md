# Multi-part local-model observations — 22 September 2026

Run `npx tsx scripts/mail-large-attachment-check.ts` with the installed original Qwen3.5 9B; an optional MAIL_LOCAL_MODEL chooses another installed candidate. This synthetic-only probe uses the production planner, generation adapter and parser on a 5,592-byte document containing 36 unapproved project estimates and a final cancellation. No source permission, mailbox or Acer access is exercised. Mock validation callback counts are explicitly not source-authorization evidence.

[Exact source, part boundaries and model outputs](evidence/mail-large-attachment-probe-2026-09-22.json) retain all three runs, using the pinned digest and 4096 context/1000 output/temperature-zero settings. All file code points were covered in every plan; all outputs passed structural and part-citation validation. This does not establish factual accuracy.

The initial capacity-only split produced three parts in 44.1 seconds. It cut records mid-sentence, and the first result generalized pending-review/no-payment status beyond the visible fragment of Project 13. A nearest-sentence split still separated that record's amount from its status. The final planner prioritizes a complete line within the last half of available capacity, then a sentence, with an exact bounded split for unbroken text. This preserves useful record boundaries without deleting text or exceeding the prompt budget.

The final line-first run took 56.8 seconds across four parts. It preserved proposal/approval distinctions and the last cancellation/withdrawn EUR 3600, but its first result incorrectly said ten projects/EUR 100–1000 when the part contains twelve/EUR 100–1200. Parts three and four also leave the earlier Project 36 estimate and later correction separate, illustrating the explicit lack of cross-part reconciliation. Do not count this as a quality pass or claim boundary selection fixes model counting.

Boundary tests and the 142-test suite verify mechanics, including exact coverage, Unicode, budgets, citations, access loss and no partial persistence. Native packaging passes. The installed development app remains PR 40 pending further multi-part quality work; this increment does not alter source activation, user model profiles or Acer. Next work includes trustworthy amount/count checks and cross-part synthesis with source citations, alongside broader native/source acceptance.

## Reconciliation follow-up

The bounded reduction path was run on the same synthetic document using the same original Qwen digest/settings. It completed four source-part calls and three reconciliation calls in 111.9 seconds. [Exact run](evidence/mail-attachment-synthesis-2026-09-22.json) retains the full source, raw calls and resulting citations. Historical `part` events in this run include reduction calls at indices 4–6.

The final result retained Project 36 cancellation/withdrawal and no payment authorization, but omitted the first group's amount range. It also described “both sections” despite reducing several source parts and carried ambiguous pending-review wording into the cancelled project's context. Do not mark factual completeness or cross-part reasoning accepted. Original part summaries are retained below the synthesized draft for inspection, and synthesis is labeled attempted/unverified. The installed app remains PR40 while this quality work continues.
