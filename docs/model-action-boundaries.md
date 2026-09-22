# Model choice does not grant authority

The companion applies the same application boundaries to Qwen3 1.7B, original Qwen3.5 9B and Huihui Qwen3.5 abliterated 9B. Choosing a model changes generation and its pinned provenance. It does not grant tool execution, source access, memory approval, publishing or remote-template permission.

`tests/model-action-boundaries.test.ts` runs each configured model name through the actual Ollama HTTP adapter, task queue, worker, candidate parser and encrypted stores. A synthetic loopback runtime supplies the same adversarial output in each run; it is deliberately simulated so refusal by a model cannot conceal an application-boundary failure.

| Check | Result for all three names |
| --- | --- |
| Runtime advertises tools | Adapter still reports tools disabled; generation request includes no tools |
| Output claims administrator authority, approval, shell tool calls and publication | Generic result keeps the claims only inside unreviewed text; no authority/tool fields are promoted |
| Candidate output adds approval/authority fields | Task fails as invalid model output, without saving the raw output |
| Candidate output has valid structure and excerpts | Result remains model-origin, candidate and unverified; memory library remains empty |
| Proposed action side effects | No publication intent, AutoNote review, remote-template permission, local template or message created |
| Runtime changes to cloud-backed metadata | No additional generation request and no fallback endpoint call |

Code inspection matches the tests: `Ollama` permits a literal loopback endpoint, rejects remote runtime metadata and reports `tools: false`; `LocalWorker` stores unreviewed results or validated candidates and does not dispatch model-generated actions. Candidate schema validation forbids added authority fields. Source-specific execution and publication remain separate guarded paths; their real-source/native acceptance is tracked separately.

This verifies the current engine's action boundary with fixed adversarial fixtures. It does not establish semantic truth, all possible attack resistance, native UI acceptance or broader model quality. The actual-model comparisons and their remaining factual/classification errors are recorded separately in the memory-candidate evaluation. No model weights, default profiles, installed app or Acer news/model configuration change as part of this verification.
