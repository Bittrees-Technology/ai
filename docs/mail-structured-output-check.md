# Mail structured-output compatibility

This evaluates JSON reliability separately from reply intent. The original production prompt remains unchanged. Ollama documents the optional `format` field for JSON/schema generation ([official API](https://github.com/ollama/ollama/blob/main/docs/api.md)); documentation is not evidence that a particular runtime/model/schema combination succeeds.

On Mac Ollama 0.17.7, all eight original-Qwen3.5-9B Mail cases initially failed when given the complete Zod-derived schema. A separate synthetic request returned HTTP 500 with “failed to load model vocabulary required for format”. The application returned MODEL_UNAVAILABLE and did not silently retry without constraints.

A tiny JSON/one-field-schema probe then succeeded for Qwen3 1.7B, original Qwen3.5 9B and Huihui 9B (six requests total). This rules out a blanket lack of support for those combinations on the installed service; it does not isolate which full-schema constraint causes the error. The revised generation schema therefore constrains shape, required fields and nonempty arrays, while strict length/count/uniqueness/source checks remain in the production result parser. No parser limit is relaxed.

All inputs are synthetic, use literal Mac loopback, thinking disabled, temperature zero and unload after each request. No Acer access, source account, sending/saving, profile change or runtime upgrade occurs.

## Result and adoption decision

The smaller Mail schema yielded **8/8 parser-valid outputs**, compared with 5/8 for the unchanged baseline prompt without a format in PR88. Exact prompts, schemas, outputs, digests and timings are in [the evidence](evidence/mail-structured-output-2026-09-22.json). This is one run per synthetic case, not a stability guarantee.

Meaning remains problematic: the sender-versus-user reply still reverses who will receive the Thursday draft, and the conditional-approval summary incorrectly attributes the user's restriction to the source message. The baseline had rejected the former for malformed JSON; valid formatting now exposes the same incorrect meaning as an unreviewed result. Therefore format support is **not enabled in companion workers** pending combined factual/intent acceptance. Existing production prompt, parser, model profiles and installed app remain unchanged.

The adapter now supports an optional per-call JSON/schema format for explicit evaluation. It snapshots the format before asynchronous work, caps serialized schema size at 16 KiB and preserves pinning, cloud denial, cancellation and output bounds. An unsupported request fails without retrying unconstrained or on another model. The strict result parser remains necessary even if a runtime claims schema support.

Reproduce the six small compatibility requests with `npx tsx scripts/model-format-check.ts`; reproduce the eight Mail cases with `MAIL_INTENT_FORMAT=schema npx tsx scripts/mail-intent-check.ts`. Leave `MAIL_INTENT_PROMPT_VARIANT` unset to isolate formatting from the rejected prompt experiment. Next: evaluate combined source/user-intent separation on fresh cases before enabling structured drafting, and verify any runtime upgrade independently. Acer stays separate.
