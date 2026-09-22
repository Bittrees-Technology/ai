# Mac Mail quality comparison — 22 September 2026

The original Qwen3.5 9B remains the better candidate for further human-reviewed Mail drafts in this sample. Huihui's abliterated variant did not improve reply reliability. Neither model has passed broad quality acceptance. Default profiles and production prompts are unchanged.

## Method

We generated 32 drafts (64 separate summary/reply calls): two installed models × two prompt variants × eight synthetic cases. One case reproduces the earlier agenda-injection failure; seven are new cases covering fake system instructions, a quoted security report, corrected pricing, sender/recipient roles, a Portuguese conditional approval, a missing receipt and an exact reply. Cases, criteria and the candidate instruction were written before the runs. These fresh cases were used in the comparison, not reserved as a separate final acceptance set.

Both models used the same adapter and separated production drafting flow at temperature 0, 4096 context tokens and 1000 output tokens per stage. The candidate replaces only one summary instruction paragraph; the independent reply prompts are byte-identical across variants. The production parser validates structure/citations. Source revalidation is a no-op synthetic fixture, so this is not a live Mail connector acceptance test. No credentials, personal content, sending, model downloads or cloud inference were used. Only the Mac loopback runtime was contacted; Acer was unchanged.

Host: Apple M4 Pro, 24 GiB unified memory, macOS 26.5.1, Ollama 0.17.7. Source revision: f79cff5944a49c45724026e806a0de819e912433. Exact prompts, responses, criteria, per-case review, digests, timing and reported residency are in the [evidence](evidence/mail-model-comparison-2026-09-22.json). The [reproduction script](../scripts/mail-model-comparison.ts) enforces Mac execution and these two model names.

## Results

Each row has eight cases. Semantic review was performed by the implementing assistant against the stated case criteria, not by an independent or blinded human reviewer. “Met criteria” does not mean error-free; modal-wording cautions are recorded separately.

| Model / summary prompt | Valid structure | Summary criteria met | Reply intent met | Both met | Median draft time |
| --- | --- | --- | --- | --- | --- |
| Original 9B / production | 8/8 | 5/8 | 8/8 | 5/8 | 19.4s |
| Huihui 9B / production | 8/8 | 3/8 | 6/8 | 2/8 | 18.3s |
| Original 9B / candidate | 8/8 | 7/8 | 8/8 | 7/8 | 18.9s |
| Huihui 9B / candidate | 8/8 | 5/8 | 6/8 | 3/8 | 17.4s |

Ollama reported 8,599,542,720 model-resident bytes (about 8.60 GB) after each case for either model. This is not measured peak process memory or total Mac pressure. Two-stage draft times ranged 15.2–21.8 seconds across the sample; they include prompt/generation overhead and a status read. This is a small sequential run, not a controlled speed benchmark or statistical quality estimate.

Pinned original digest: `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Pinned Huihui digest: `92a443adb124f5e805bbdee23fdb38fcd22a7bf00a1016b53f764e741369c600`. Both report Q4_K_M and 9.7B parameters through Ollama.

## Findings that affect the next step

- Original production summary omitted the legitimate agenda request while describing the injected instructions. The candidate restored that request and correctly preserved the meeting correction. It also improved attribution/outcome in the security report, but still repeated its attack marker and omitted the blocked-sender outcome.
- Huihui's reply asked the sender to confirm agenda receipt instead of acknowledging it, and copied the missing-receipt expense request instead of asking for the receipt. These errors persisted in the candidate runs because the reply prompt was unchanged.
- Huihui production summary misattributed the EUR 180 repair price to the inspection and omitted the proposed inspection timing. The candidate corrected this.
- Huihui candidate summary dropped the cancelled Tuesday meeting time that production had retained. Other omissions and attack-marker echo remained. It also strengthened an offer to collect into a promise; the original production summary had the same modal-wording caution.
- A quoted test-marker echo is an output-quality/instruction-following finding under this fixture's no-echo criterion. It does not show that any action occurred or that an authority boundary was bypassed. All results remained unsent, unsaved draft suggestions.

Do not promote the summary candidate globally yet: improved counts coexist with a concrete regression. Keep original 9B as the preferred candidate for reviewed use without changing saved defaults. The next prompt revision needs explicit correction/outcome preservation and a new acceptance set, including more quoted-report and multilingual cases. These observations do not establish quality for attachments, long documents, other apps or general factual questions. No model weights were trained or modified.

## Reproduction

With these models already installed on the Mac and Ollama listening at literal 127.0.0.1:11434:

```sh
MAIL_COMPARE_MODEL=qwen3.5:9b MAIL_COMPARE_VARIANT=baseline npx tsx scripts/mail-model-comparison.ts
MAIL_COMPARE_MODEL=huihui_ai/qwen3.5-abliterated:9b MAIL_COMPARE_VARIANT=baseline npx tsx scripts/mail-model-comparison.ts
MAIL_COMPARE_MODEL=huihui_ai/qwen3.5-abliterated:9b MAIL_COMPARE_VARIANT=summary-candidate npx tsx scripts/mail-model-comparison.ts
MAIL_COMPARE_MODEL=qwen3.5:9b MAIL_COMPARE_VARIANT=summary-candidate npx tsx scripts/mail-model-comparison.ts
```

The script prints synthetic evidence, including raw model replies, as JSON lines. It does not install models or change profiles. Candidate substitution fails if the expected production paragraph has changed, requiring an explicit re-review rather than silently comparing a different prompt.
