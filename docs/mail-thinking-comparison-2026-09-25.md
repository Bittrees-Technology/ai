# Mac thinking-mode compatibility comparison — 25 September 2026

Keep thinking disabled for this request format on the installed Mac runtime. All eight `think:true` requests returned an empty final `response`; the runtime placed structured JSON in `thinking` instead. The unchanged companion adapter correctly rejected all eight. This does **not** establish that thinking reduces model quality or that Qwen has reached its quality ceiling. We did not reinterpret the thinking field as a final answer.

The eight paired `think:false` controls all produced valid final answers. Three met every predeclared semantic criterion. Missing actor ownership, omitted material details and copied reported instructions remain reasons to require human review.

| Same eight synthetic cases               | Thinking off |                                   Thinking on |
| ---------------------------------------- | -----------: | --------------------------------------------: |
| Attempts / actual generations            |        8 / 8 |                                         8 / 8 |
| Valid final answers                      |            8 |                                             0 |
| Answers meeting every required criterion |            3 | 0 usable answers; semantic quality not scored |
| Generated tokens per request             |       98–196 |                                       119–191 |
| Median observed request duration         |      14.62 s |                                       16.92 s |

All requests reported `done:true` and `done_reason:stop`, below the fixed 1,000-token ceiling. The observed failure is not evidence of output-budget exhaustion. Timing is descriptive, not a useful speed ranking between a usable and unusable output path.

## Fixed method

Cases, criteria and evaluator were committed before any inference at `452d12bf2f8077d1bf2f30368ad438b835db5ce0`. Case SHA-256: `b51f8caf885cd69a44fa9141e818cf1e6021b9cc836bdbd839243e367fa2e109`.

Both variants use the production `mailPrompt`, summary schema, `Ollama` adapter and `mailResult` parser. The model is the already installed original `qwen3.5:9b`, digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`, on Mac Ollama 0.17.7. Context 4,096, maximum output 1,000 and temperature zero are unchanged. Prompts fit the existing 2,840-byte input budget.

The evaluator wraps transport only within its own process. It admits only the literal Mac loopback runtime, validates the production generation request, then changes only the per-request `think` boolean. Redirect refusal, pinned-model validation, prompt limits and the 1 MiB response bound remain in force. The wrapper restores the original transport afterward and retains actual request/response data. It changes no production source or saved profile.

One attempt per variant, alternating pair order; no silent retries. The process exits 1 because the eight thinking outputs fail final-response validation. The raw JSONL SHA-256 is `61e27e4eb51696a0135a9ca0a379b6313d5e0d071bf5fe5a584b39ef33afb8f4`. Every attempt and review note is retained in [the evaluation](evidence/mail-thinking-comparison-2026-09-25.json). The cases are synthetic and contain no personal mail or keys.

## Semantic review limits

The implementing assistant reviewed the outputs, without blinding or independent review. Each case has explicit required details; omission is distinguished from a false claim. For example, the trolley summary retains permission and timing but omits explicit sender ownership of the porter. The withdrawn-payment summary is factually consistent but omits the explicit instruction not to pay again. These are counted as missing requirements, not invented payments or actors. The Spanish summary preserves sender actions in first-person selected-email context and passes.

These are eight targeted, previously fixed instances informed by exposed earlier failures, not a representative accuracy benchmark. Only the summary phase was exercised; no full reply draft, tool execution or live source workflow was tested. The exposed cases cannot become future unseen validation.

Further work should isolate structured-output/thinking compatibility before considering this option for production, and evaluate author-recommended non-thinking sampling on new fixed cases. Any wider runtime/model change needs its own evidence. No model was downloaded, no default changed, and no installed companion, personal data, live permission or Acer model/news job was touched.
