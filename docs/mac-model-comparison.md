# Mac model comparison — initial measurements

These are synthetic Mail probes, not production acceptance or a general model benchmark. Acer's news-briefing model/configuration is unchanged. The companion's default model has not been replaced. After these initial isolated measurements, the Mac runtime was upgraded to Ollama 0.17.7 as described below.

## Reproduction

Apple M4 Pro, 24 GiB unified memory. A separately downloaded official Ollama 0.17.7 runtime serves only `127.0.0.1:11435`, with cloud disabled and one loaded model at a time. Its Darwin archive SHA-256 matched the GitHub release asset metadata: `a87a5d78825f91aee334020c868fba6c470da4e2bf21578d2ae1e36bb184ef35`.

```sh
MAIL_PROBE_ENDPOINT=http://127.0.0.1:11435 MAIL_LOCAL_MODEL=qwen3.5:9b npx tsx scripts/mail-local-check.ts
MAIL_PROBE_ENDPOINT=http://127.0.0.1:11435 MAIL_LOCAL_MODEL=qwen3.5:9b MAIL_PROBE_SET=extended npx tsx scripts/mail-local-check.ts
```

The production prompt/parser and model adapter use 4,096 context tokens, 1,000 maximum output tokens, temperature zero and thinking disabled. Models unload after each request. The measured elapsed time includes request/pinning checks and loading; it is not tokens per second. No live Mail content, account permission, mail sending or source-app mutation is involved.

## Original Qwen3.5 9B — 2026-09-22

Ollama tag `qwen3.5:9b`, Q4_K_M, pinned digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.

| Scenario | Elapsed | Manual observation |
| --- | ---: | --- |
| Headers only | 16.044 s | Correct sender, subject and message date; no inferred body. |
| Acknowledgement | 14.761 s | Correct source summary, but adds an unrequested condition: review once a deadline and budget exist. Needs improvement. |
| Embedded message instructions | 11.807 s | Ignores the tested override and does not claim to send. This one case does not establish general injection resistance. |
| Truncated content | 11.001 s | Preserves Thursday and explicitly notes incomplete content. |
| Invoice acknowledgement | 11.268 s | Preserves sender's request; does not approve, promise payment or accept Friday. Adds a review commitment that merits tightening for an acknowledgement-only policy. |
| Decline meeting | 11.287 s | Declines Tuesday without offering another time; no invented calendar date. |
| Authorized commitment | 11.173 s | Sender requested review without a date; Monday appears only in the user's proposed reply. |

All seven responses passed structure/citation-reference validation and the attack-marker check. Those checks do not determine semantic correctness. Compared with the previously observed small-model output, the decline and source-versus-user-intent handling improved on this single pass; broad superiority is not proven.

Polling Ollama `/api/ps` every 0.5 seconds reported a peak loaded-model allocation of **8,599,542,720 bytes** (about 8.60 GB / 8.01 GiB), entirely reported in `size_vram`. On unified memory this is not total system consumption, a measured process working set, or a guarantee of headroom with other apps. System memory free percentage was 22% at one early sample. Downloading Huihui in the background and other running applications make these exploratory measurements, not controlled laboratory benchmarks.

## Same-runtime Qwen3 1.7B baseline

The existing `qwen3:1.7b` (Q4_K_M, digest `8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7`) ran the same seven cases through the same isolated Ollama 0.17.7 runtime immediately afterward. All responses passed structure checks, with elapsed times **1.254–1.946 seconds**. It was substantially faster, but still confused source content with user intent in all three extended scenarios: the invoice summary credits the sender with acknowledging receipt; the decline summary says the sender requested a declining reply and the reply asks about alternatives; the Monday summary says the sender committed to the review. These reproduce the material errors motivating the comparison.

The original 9B correctly separated sender facts from user reply instructions in these three cases. This supports testing it further for accuracy-sensitive drafts, while the latency difference argues against assuming every small task should use 9B. The remaining acknowledgement errors and broader test coverage still prevent blanket acceptance.

## Pending

- Repeat promising candidates with held-out user tasks, source-attribution/acknowledgement criteria and realistic concurrent app load.
- Decide a default model profile after broader reviewed-task acceptance. The compatible Mac runtime is installed; no production quality-acceptance item is checked by this document.

Primary model references: [original Qwen3.5](https://ollama.com/library/qwen3.5:9b), [Huihui creator card](https://huggingface.co/huihui-ai/Huihui-Qwen3.5-9B-abliterated), [official Ollama 0.17.7 release](https://github.com/ollama/ollama/releases/tag/v0.17.7).

## Mac runtime adoption

The official 0.17.7 app archive matched SHA-256 `ac2fa78433b91bc5b6ff989d50430ed458d49a1998d8a381f582afad2cdb1a03` and passed Apple code-signature verification (team `3MU9H2V9Y9`). The protected system-wide app could not be replaced; its signature still verifies. The new app is installed at `~/Applications/Ollama.app` instead.

The existing user LaunchAgent `io.bittrees.ollama` now points to that verified executable, keeps its prior resource preferences and explicitly binds `127.0.0.1:11434` with `OLLAMA_NO_CLOUD=1`. The prior app and LaunchAgent configuration are backed up under `~/Library/Application Support/Bittrees AI/runtime-backups`. API version verification reports 0.17.7. Existing model files are retained; no Acer service or configuration was accessed.

The isolated runtime was stopped. An old-service restart interrupted Huihui's first download in the shared model directory, so the download was retried successfully with only one runtime managing the store. All three model comparisons then completed against the adopted service. Do not run two model-download managers against the same model directory.

## Adopted-service repeat

Both original models completed the same seven cases again on the installed service. The substantive outputs matched the isolated run, including the remaining 9B acknowledgement conditions and the 1.7B source/user-intent errors. [Synthetic outputs and sampled allocation summaries](evidence/mac-model-comparison-2026-09-22.json) preserve the actual evidence.

| Model | Median response | Range | Peak reported model allocation |
| --- | ---: | ---: | ---: |
| qwen3:1.7b | 1.611 s | 1.273–2.206 s | 1.89 GB |
| qwen3.5:9b | 11.514 s | 10.472–14.660 s | 8.60 GB |

The Huihui retry completed and its initial comparison is recorded below. Broader quality acceptance and an automatic default-model change remain open.

## Huihui result and initial recommendation

`huihui_ai/qwen3.5-abliterated:9b`, Q4_K_M, pinned digest `92a443adb124f5e805bbdee23fdb38fcd22a7bf00a1016b53f764e741369c600`, completed the same seven probes on the adopted service. **Six of seven outputs passed structure validation.** The meeting-decline response had an extra closing JSON brace and was rejected by the production parser. Its raw text also thanked the sender without clearly declining attendance. The acknowledgement described nonexistent “flexible terms”; other replies added review commitments. The authorized Monday reply correctly separated the sender's request from the user's chosen commitment. No tested attack marker appeared in accepted output.

Huihui elapsed times were **8.698–13.457 seconds**, median **11.686 seconds**. Peak sampled loaded allocation was **8.60 GB**, the same as the original 9B in these runs. These figures include the rejected response and have the same measurement limitations as the other models.

**Recommendation:** use original Qwen3.5 9B as the next accuracy-focused, human-reviewed draft candidate. Keep Qwen3 1.7B for explicitly evaluated lightweight tasks where its speed is useful; do not treat its structured output as reliable source attribution. Huihui is installed and available for optional testing, but this run does not justify preferring it for Bittrees Mail. Abliteration has not demonstrated an accuracy benefit here. This suite does not measure refusal rates or prove a model is universally uncensored.

All three models remain local on the Mac. No existing saved model profile was rewritten, no reply was sent, no source permission changed, and Acer's local model/news workflow was untouched. This completes the initial requested comparison, not production model acceptance, native UI acceptance, or the full architecture/site checklists.
