# Mac summary sampling comparison — 25 September 2026

Predeclared screening experiment: eight fresh synthetic emails, two generations per case, alternating baseline/candidate order. Cases, criteria and evaluator are committed before inference. Retain every result and failure; do not retry or tune cases after observing output.

Use installed original `qwen3.5:9b` at digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7` on the Mac's literal-loopback Ollama0.17.7. Production prompt, JSON schema, parser,4096 context and1000 output limits stay identical. Thinking stays disabled. Both variants use fixed request seed250925. Baseline otherwise preserves production settings; candidate overrides temperature0.7,top_p0.8,top_k20,min_p0,presence_penalty1.5,repeat_penalty1.0 only for that request. Raw request/response evidence records the actual settings; the unchanged pinned profile in the manifest describes the production adapter input, not the candidate's override.

The [author model card](https://huggingface.co/Qwen/Qwen3.5-9B) recommends those non-thinking general-task settings. Ollama's [version0.17.7 options](https://github.com/ollama/ollama/blob/v0.17.7/api/types.go) include the corresponding fields. The author also recommends larger output budgets; this experiment deliberately measures compatibility with the unchanged companion budget and is not a model-ceiling benchmark.

Manual semantic review must score every predeclared criterion, distinguishing omitted required details from false assertions and unsupported actions. Structure alone is not semantic success. Candidate promotion requires a clear improvement without new false-assertion/action failures and a separate broader repeated-sampling/full-reply evaluation. One fixed seed and eight cases cannot establish stochastic reliability. This review is not blind or independent; fresh instances target failure patterns observed earlier.

No production prompt, saved profile, model download, runtime default, installed app, personal Mail data or Acer service changes. Inference completed; results are retained below.

## Result

Do not promote the candidate. Both variants parse8/8; baseline meets every criterion on7/8 and author-sampling on6/8. Both repeat the reported attack marker despite the fixed generic-summary criterion, while correctly describing its rejection; this is not evidence of obeying the malicious instruction. Candidate also omits recipient/sender roles in the optional-courier case. No false assertions were identified under this manual rubric.

These are different cases from earlier studies, so the baseline score cannot establish improvement over those earlier scores. One seed cannot estimate sampling variance. Production defaults remain unchanged.

[Full request/response evidence and per-case review](evidence/mail-sampling-comparison-2026-09-25.json) retain all16 actual generations, frozen source/case/script hashes, criteria and limitations. Frozen evaluator commit: `89df073a489311fc1b8461383b61822afbfa7024`. Both variants use the same production prompt/parser and budget; all request overrides were verified from the captured requests.
