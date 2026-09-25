# Compact Mail summary prompt experiment

Do not promote the compact candidate. It solved the preceding experiment's input-budget problem, but did not preserve factual roles and required details reliably. All sixteen outputs parsed; the production baseline met every predeclared criterion on3/8 cases and the compact candidate on0/8. Production prompts, profiles and limits remain unchanged.

| Variant | Generated and parsed | Input-budget rejections | All criteria met | Prompt bytes |
| --- | ---: | ---: | ---: | ---: |
| Production summary prompt | 8/8 | 0 | 3/8 | 2,052–2,169 |
| Compact replacement instructions | 8/8 | 0 | 0/8 | 1,401–1,518 |

The candidate frequently turned reporting-sender actions into recipient actions and introduced unsupported staff. It repeated attack markers, omitted missing-condition warnings, and misassigned Portuguese actor ownership. These errors remain visible in the retained outputs. The baseline also failed targeted cases, including role omissions, marker copying and incomplete-source handling. Its withdrawn-request case preserved the central facts but omitted the relative timing expressly required by that case's criteria; the review records this as an omission, not a false claim.

These scores measure all specified criteria on eight deliberately challenging synthetic instances. They are not general model-accuracy estimates or comparable to the different earlier case sets. The implementing assistant assessed the outputs; review is neither independent nor blinded. One paired attempt per variant, with alternating order, does not establish a speed ranking. Cases are now exposed regression data and must not be reused as unseen validation after tuning.

## Fixed experiment and evidence

The candidate, cases, criteria and evaluator were committed at `dcde38ea3123f64183467ea13f7e74cf0635db49` before inference. Case-file SHA256: `a0d2f1770fb8d75e9123510c8574171e75c5140ab071eee916d12d185e8a0e9a`. Candidate SHA256: `860bdd139598aae86a2596df7fcd34ed769728b0ab9c4eb2ed93fb3eea13ded2`.

The installed original Qwen3.5:9B digest stays pinned to `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. The Mac-only evaluator uses literal loopback, the production summary request for baseline, the same output schema/parser and runtime, 4,096 context tokens, 1,000 output tokens and temperature zero. All prompts fit the unchanged2,840-byte input budget. It completed with exit0; structural completion is distinct from semantic quality.

The [evidence report](evidence/mail-summary-compact-2026-09-25.json) retains all inputs, prompts, schemas, raw outputs, hashes, timing and per-case reviews. Reproduce on the authorized Mac with `npx tsx scripts/mail-summary-compact.ts`. No source credentials, Mail messages, sends, installed-app changes, model downloads or Acer access occur.

## Remaining inference question

Both prompt experiments used the production adapter's non-thinking mode and temperature zero. The author's [Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B) describes thinking and non-thinking modes with mode-specific sampling recommendations. [Ollama documents per-request thinking control](https://docs.ollama.com/capabilities/thinking); the installed model's local metadata advertises thinking support. That is a capability observation, not proof of a quality improvement or compatibility under this application's output limit.

A bounded comparison of inference settings on fresh, frozen cases is warranted before concluding that a larger model is necessary. Keep the current application limits and defaults unless a separately reviewed change is supported by measured results. No production prompt or model promotion follows from this experiment, and broader quality acceptance stays open.
