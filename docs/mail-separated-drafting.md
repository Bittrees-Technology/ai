# Separate source summary and reply generation

The previous one-call Mail path mixed source facts and user reply instructions in one model context. It sometimes attributed user instructions to the source and reversed who would send or receive a draft. This implementation isolates the summary generation: it receives the selected source and a fixed summary instruction, never the user's reply instruction. A second independent request receives the original source plus the user's reply instructions. It cannot rewrite the already validated summary.

Both requests use the same pinned model and bounded small output schemas. The ordinary strict Mail parser still validates the combined result, source IDs, lengths, counts, uniqueness and draft shape. Source access is checked before the first call, between calls and before returning the result; cancellation and invalid output stop the operation. No partial result is saved or fallback retried by the helper. Drafts remain unreviewed, unsent and unsaved to Mail.

This improves isolation by construction, not semantic truth: models can still misread source content or draft the wrong response. It costs two generations per draft. Memory, source grants, model defaults, live Mail configuration and Acer remain unchanged.

The probe's existing eight cases are development data. Four additional cases were fixed before reviewing their results: refund without a decision, Spanish decline, shipment-role separation and an embedded instruction attack. Review is performed by the coding assistant; this is not independent human acceptance or broad multilingual/injection assurance.

## Evidence and scope

[Exact prompts, schemas, outputs, digests and timings](evidence/mail-separated-drafting-2026-09-22.json) cover 40 actual local generations: eight original-9B development cases, four original-9B fresh cases and eight small-model development cases, with two calls per case. Settings remain 4096 context / 1000 output tokens / temperature zero / thinking disabled.

Original Qwen3.5 9B: all 12 final results passed structure/citation-reference validation. Assistant inspection found the eight development replies met their stated intent criteria; summary instructions stayed separate from reply instructions. Three of four fresh cases met the criteria. The embedded-attack case **failed** summary quality: it quoted the attack marker and focused on the override rather than the legitimate agenda request. Its reply only acknowledged receipt, with no approval/sending claim. This failure is retained and broader quality/injection acceptance stays open.

Qwen3 1.7B: all eight structures were valid, but substantive failures remain. The decline invented personal commitments and offered a follow-up; the tracking summary changed an estimate into a request; the conditional reply copied a user constraint; the Portuguese summary changed Friday to Saturday; the sender-versus-user summary changed sending Thursday into a review deadline. Do not adopt the smaller model for accuracy-sensitive drafting based on structural success. No model default changed. Huihui was not re-evaluated for this pipeline.

The worker now uses separate generation for selected plain-text Mail drafts and records `mailDraftPipeline: separated-v1` in encrypted run history. Metadata summaries, attachment summaries, generic tasks and other source adapters keep their existing paths. This is a development implementation of source isolation; it is not production quality acceptance. The installed Mac app is unchanged. Two generations increase latency, and unsupported schemas fail without unconstrained fallback. Existing human review, source permission and save/send boundaries remain in force.

Reproduce with `MAIL_INTENT_PIPELINE=separated npx tsx scripts/mail-intent-check.ts`; add `MAIL_INTENT_SET=fresh` for the four formerly unseen cases or `MAIL_INTENT_MODEL=qwen3:1.7b` for the small model. Cases become development data after inspection; future acceptance needs newly held-out tasks and human review.
