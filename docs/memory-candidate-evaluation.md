# Memory candidate extraction: module and Mac probe

This is an internal prompt/output contract and a synthetic model probe. It is not connected to task dispatch, saved memories or the Mac suggestion UI. No default model or installed app changed, no cloud inference ran, and Acer news inference was untouched.

`prepareMemoryCandidates` binds bounded request/result text to a SHA-256 snapshot and a versioned prompt. `parseMemoryCandidates` accepts strict JSON with at most eight typed candidates, bounded text and exact excerpts in the declared request/result source. It rejects changed source text, malformed/extra fields, invented or wrongly attributed excerpts, duplicate type/text suggestions and oversized output. Excerpt offsets are JavaScript UTF-16 string positions. Parsed suggestions always have model origin, candidate state and verified:false. They carry no source grants or task authority.

Exact excerpts establish only that the words occur in the source. They do not prove that an excerpt supports the paraphrase, that the source is correct, or that the candidate's type is appropriate. A regression test deliberately accepts a wrong paraphrase with a real excerpt while keeping it unverified; human review remains necessary. No model output can approve itself.

## Actual local comparison

On 22 September 2026, the installed Mac Ollama runtime ran four synthetic cases per model and prompt version: an explicit lasting preference, pilot decisions, an uncertain release date and a source-text instruction to bypass review. Each model was digest-pinned and reverified by the existing adapter, with an 8,192 context setting, 2,048 maximum output tokens, temperature zero, no tools, loopback-only requests and unload after generation. No task or memory data store was used.

| Model | Prompt v1 structure/excerpt pass | Prompt v2 structure/excerpt pass |
| --- | ---: | ---: |
| Qwen3 1.7B | 1/4 | 3/4 |
| Original Qwen3.5 9B | 4/4 | 4/4 |
| Huihui Qwen3.5 abliterated 9B | 4/4 | 4/4 |

Prompt v1's illustrative union strings were copied literally by the small model. Prompt v2 replaces that ambiguity with a JSON schema and adds explicit category definitions. Full source fixtures, exact prompts, raw outputs, parsed candidates, durations, settings and model digests are retained under `docs/evidence/memory-candidates/`. The v1 template plus JSON source reconstructs its exact prompt. Run the current probe explicitly with:

```sh
node --import tsx scripts/memory-candidate-model-check.ts qwen3.5:9b
```

The script allows only the three existing comparison model names and writes synthetic evidence locally. It is not part of ordinary startup or CI inference.

## Content review of the results

The pass counts above are not semantic accuracy scores. Review of the outputs found:

- Small model v1 attached an unrelated but real request excerpt to a release-date suggestion; its other cases had invalid source labels or placeholders. V2 improved formatting, but still mislabeled evidence in the uncertain-date case, classified a model acknowledgement as a decision and retained boilerplate.
- Original 9B v1 preserved the uncertain wording but classified a scheduling suggestion as a preference and a one-off future decision as a procedure. V2 returned no candidates for the uncertain scheduling or injected-instruction cases, but produced redundant preference/acknowledgement material in the preference case.
- Huihui 9B v1 reduced a possible date to the candidate text “Friday” and classified it as a preference. V2 retained uncertainty more clearly but still labeled “The team will decide after testing” as a procedure. Both versions retained unnecessary no-findings/acknowledgement material.

The original 9B remains a plausible human-reviewed candidate for the next integration step. These four cases per prompt are too small and too closely tied to prompt refinement to establish general reliability, a universal model ranking or successful fine-tuning. No weights were trained. All models still need rejection/edit controls and evaluation on unseen examples.

## Remaining integration

Create suggestions through the existing bounded local task queue, preserve the exact source task revision and model profile, recheck source eligibility after generation, and expose a review screen before storing selected candidates. Store model origin and trusted local provenance; do not let model-supplied excerpts create authority. Keep candidate approval separate from accepting an extraction batch, and keep source-derived candidates out of retrieval until approval. Cancellation, restart, deletion and stale-source behavior need end-to-end tests. The trigger choice is awaiting the user; explicit per-task requests are only a reversible working default, not a confirmed preference. No automatic suggestion rule is enabled.

## Queued extraction foundation

The internal `Store.memoryExtractions.create` boundary now creates an explicitly confirmed, owner-bound request for one completed local task and its exact revision. It selects an existing immutable model profile, stores the generated prompt in the encrypted task queue, and stores the source hash, parent revision and prompt version in a separate encrypted binding. Generic task prompts, tags and idempotency keys cannot create that binding. Exact retries reuse the task; changed intent conflicts. Each owner may have at most twenty unfinished extraction requests. External source tasks and extraction results cannot be used as parents.

The normal local worker runs these requests with its existing model pinning, cancellation, lease, restart and model-unavailable retry handling. It rechecks the source snapshot before saving, validates the candidate contract, and stores only structured, unverified candidates with parent and model provenance. Invalid model output fails without retaining the raw output or retrying automatically. Completion checks the binding again inside the write transaction. Schema eleven adds the encrypted binding table; backups/reopen preserve it, and deleting task history cascades to it. Use a compatible backup when rolling back to an older binary.

Regression coverage includes exact retry, owner isolation, explicit confirmation, revision mismatch, no recursive extraction, invalid output, cancellation during inference, source changes before completion, queue-capacity rollback, generic-task collision rejection, schema-ten migration, encrypted backup/restore and deletion. Inference runs outside database transactions. This establishes the queue/worker foundation used by the local request and review controls below. No automatic extraction rule, memory approval, hosted operation, model default change or Acer news/model change is enabled.

## Local request and review controls

The Tasks detail now offers **Prepare suggestions**, followed by a confirmation showing the selected profile and source task revision. **Request local suggestions** creates the queued extraction. Once the extraction task completes, **Review suggestions** fetches its currently valid suggestions with exact supporting excerpts. **Save as memory candidate** saves one server-selected suggestion with model origin and the original task revision. It remains unapproved and absent from retrieval until separately approved in Memory. Existing Memory controls support editing, deletion and export; local retention remains until deletion.

Authenticated loopback routes are `POST /v1/requests/:id/memory-suggestions` for a parent task, `GET /v1/requests/:id/memory-suggestions` for a completed extraction, and `POST /v1/requests/:id/memory-suggestions/save` for a confirmed candidate index and extraction revision. Callers cannot provide replacement text, source references, origin or approval. The server revalidates stored candidates and exact source quotes; a synchronous precommit check rejects source/result changes after asynchronous memory access checking. Exact repeated saves deduplicate through the memory store without resetting approval or creating extra records.

The dashboard controller preserves the same invocation on uncertain request retry, prevents concurrent clicks, requires explicit preparation, clears review on refresh/focus loss and ignores delayed responses after hiding. End-to-end tests use this controller against the actual authenticated HTTP API, local worker and encrypted stores with synthetic content. The existing Avenir, light background, blue/green controls and left-aligned detail layout are retained; supporting excerpts sit directly below each suggestion. Native visual/keyboard acceptance remains open under the existing automation restriction. No automatic extraction rule, cloud inference, installed-app replacement or Acer model/news change is enabled.

## Actual Mac queue-to-memory pilot

`scripts/memory-suggestion-pilot-check.ts` exercises the dashboard controller, authenticated loopback API, encrypted in-memory task queue, actual original Qwen3.5 9B Ollama inference, review, repeated candidate save, retrieval exclusion and deletion. It creates only synthetic stores and uses the Mac's literal loopback runtime. It does not read installed app data or credentials, change defaults, approve the candidate, or contact Acer. Run with Node 24 and the installed original 9B model; no download is performed. Evidence is in `evidence/memory-candidates/mac-original-9b-queued-pilot.json` with exact prompt, source, raw result, model digest/settings, task history and review/save outcomes.

The recorded run completed in 20,432 ms, including local model loading and request/queue overhead, and returned three structurally valid candidates. The first accurately repeated the explicit preference. The second redundantly retained the instruction to remember that preference; the third classified a future acknowledgement as an outcome. This confirms the workflow, not broader model quality. Mechanically saving the first candidate twice retained exactly one model-origin unapproved record, search returned zero unapproved matches, and deletion removed it. No human content approval is claimed. A preliminary run reached deletion but the probe incorrectly tried to parse its HTTP 204 response as JSON; that probe-only defect was corrected before the complete recorded rerun.
