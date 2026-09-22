# Mac Mail reply-intent evaluation

Eight new synthetic cases were fixed before changing the prompt: receipt only, decline without an invented reason, a question, conditional approval, a withdrawn/revised proposal, Portuguese acknowledgement, separate sender/user actions and exact requested wording. These are held out from the earlier seven-case comparison, but become development cases after this inspection; they are not an independent final acceptance set.

The same original Qwen3.5 9B runs each case before and after the prompt change through the production Mail prompt/parser and Ollama adapter on Mac loopback only. Settings: context 4096, maximum output 1000, temperature zero, thinking disabled, unload after generation. Exact prompts, outputs, model digest and elapsed times are retained in the evidence. No live mailbox, source credentials, sending, saving, model-profile change or Acer access is involved.

Reproduce the current prompt with `npx tsx scripts/mail-intent-check.ts`. The script validates structure and citations only. Semantic observations are manual inspection by the coding assistant, not independent human acceptance or a guarantee of accuracy.

## Results and decision

[Exact evidence](evidence/mail-reply-intent-2026-09-22.json) includes all attempts, including the oversized candidate rejected before inference.

| Case | Baseline observation | Bounded candidate observation |
| --- | --- | --- |
| Receipt only | Extra JSON brace rejected; raw reply makes no promise. | Valid concise receipt. |
| Decline | Valid reply; summary awkwardly says sender requested to be spoken at launch. | Valid decline and correct direction. |
| Tracking question | Valid request for tracking. | Valid concise question. |
| Conditional approval | Valid conditional reply without immediate approval. | Valid JSON, but copies the user constraint “Do not approve it now” into the reply, changing its addressee. Regression. |
| Revised proposal | Valid summary and decline. | Extra JSON brace rejected. |
| Portuguese receipt | Valid receipt without reservation/payment commitment. | Valid concise Portuguese receipt. |
| Sender versus user | Extra JSON brace rejected; raw reply reverses who receives the Thursday draft. | Valid Saturday review commitment; sender retains Thursday sending. |
| Exact wording | Correct raw reply but empty citations rejected. | Exact reply with valid source-context references. |

Baseline: **5/8 valid structures**. Bounded candidate: **7/8**, with a material instruction-copying regression. The initial longer candidate failed capacity checks on all eight inputs before generation; the shorter candidate retained the original context/output limits.

**The candidate is not adopted.** Production prompt, parser, model profiles and installed companion are unchanged. Run it explicitly with `MAIL_INTENT_PROMPT_VARIANT=candidate npx tsx scripts/mail-intent-check.ts`; the probe refuses this comparison if the baseline instruction block changes. These runs support testing schema-constrained generation separately from reply-intent improvements, followed by a fresh unseen acceptance set. They do not establish reliable drafting, general multilingual quality or broad injection resistance. Human review remains necessary, and no source send/save permission is introduced.
