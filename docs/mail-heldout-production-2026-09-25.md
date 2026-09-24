# Mac Mail quality: twelve new production-flow cases

Original Qwen3.5 9B remains the stronger candidate for reviewed Mail drafts in this sample. Neither model passed all summary criteria, and Huihui introduced clear reply-intent errors. This evaluation does not promote a prompt, switch a default, train weights, or establish broad Mail quality acceptance.

Twelve new synthetic case instances and separate summary/reply criteria were committed before inference. Each model ran each case once using the unchanged production `separatedMailDraft` flow and parser: 24 drafts and 48 generations. Original Qwen ran first, followed by Huihui. Both installed models used pinned digests, temperature 0, 4,096 context tokens and 1,000 output tokens per stage. The cases cover conditional orders, actor direction, receipt-only replies, conditional authorization, corrected times, Portuguese, Spanish, French, quoted instruction attacks, unread attachments, truncated text and an exact two-line reply.

| Model                 | Valid structure/citations | Summary criteria | Reply criteria | Both criteria | Median draft time |
| --------------------- | ------------------------- | ---------------- | -------------- | ------------- | ----------------- |
| Original Qwen3.5 9B   | 12/12                     | 9/12             | 12/12          | 9/12          | 19.29 s           |
| Huihui abliterated 9B | 12/12                     | 7/12             | 9/12           | 6/12          | 19.06 s           |

These are manual assessments by the implementing assistant, not an independent or blinded review. Borderline wording and stylistic cautions are recorded separately and not counted as unequivocal criterion failures. Passing a row's criteria does not mean the text needs no editing. The sample is small and deliberately exercises known failure families; the new instances were not used to tune the prompts before this run.

Both models changed permission for the recipient's technician to leave a key into a promise by the sender. Both repeated the quoted attack marker in one summary; original Qwen retained the incident outcomes, while Huihui invented a vendor claim that a transfer had occurred and omitted the rejected request, suspension and open investigation. Original Qwen also omitted a required no-next-step statement. Huihui additionally omitted the no-shipment fact and the reported attachment, and failed to acknowledge missing details in a truncated selection.

Huihui's three clear reply failures asked the sender to confirm the recipient's own action, copied the sender's Portuguese shipping statements with reversed actors, and repeated a Spanish invitation instead of declining it. Original Qwen followed those intents. Cautions still matter: its Portuguese reply echoed a negative user constraint as an explicit refusal. Huihui used “before we proceed,” repeated source text unnecessarily, produced literal `I` signatures, and added a no-further-action conclusion and name placeholder. The evidence records each case, criterion, output and assessment rather than hiding these behind a format pass.

Host: Apple M4 Pro, 24 GiB memory, macOS 26.5.1 and Ollama 0.17.7. Both models reported 8,599,542,720 bytes of model allocation after each case. This is not peak RSS, total system use or a memory-pressure measurement. Draft times include loading and the status read during normal Mac activity; the small median difference is not a reliable speed ranking.

[Full evidence](evidence/mail-heldout-production-2026-09-25.json) includes fixed inputs/criteria, exact prompts/formats/raw outputs, model digests, source/prompt hashes, per-case timings, allocation observations and manual notes. The frozen case hash is `e22bcb5ff08c0a4a4b2db64fb39c177919dddf9983480303daef10dff82ae191`; source commit `903c9ecc6833af38e2fadfe38cbb82196e3bd0d5` contains the cases before execution. These instances are now exposed regression cases for any future candidate; a later promotion needs new acceptance inputs.

The reproduction script uses only literal Mac loopback and the two reviewed, already-installed model digests. It reads no personal mail or source credentials, creates no task store, and never saves or sends a message. Source revalidation is a synthetic no-op, so this does not test a live connector. No Acer service/model, installed companion, saved profile, production prompt or runtime configuration changed. Long files, actual attachment contents, other apps and personal workflows remain unaccepted by this sample.

```sh
MAIL_HELDOUT_MODEL=qwen3.5:9b npx tsx scripts/mail-heldout-quality.ts
MAIL_HELDOUT_MODEL=huihui_ai/qwen3.5-abliterated:9b npx tsx scripts/mail-heldout-quality.ts
```

The script checks structure and prints raw synthetic evidence; it cannot automatically judge semantic quality. Keep original Qwen as the first candidate for further reviewed use. The next improvement must address factual roles, quoted-report outcomes, omissions and negative-instruction echo, with a separate fresh acceptance set. No model/default switch is justified by these results.
