# Paired synthetic Mail summary experiment

The longer instruction prefix is not suitable for promotion. On eight new targeted cases, both the production summary prompt and the candidate met every predeclared criterion on three cases. The candidate also exceeded the existing input budget on three cases before generation. Production prompts, profiles, model selection and limits are unchanged.

| Variant | Attempts | Generated and parsed | Input-budget rejection | All criteria met |
| --- | ---: | ---: | ---: | ---: |
| Production summary prompt | 8 | 8 | 0 | 3/8 |
| Production prompt plus fidelity prefix | 8 | 5 | 3 | 3/8 |

The criteria include preservation of specified details, not just absence of false statements. Both variants omitted recipient ownership of a courier/colleague. The baseline echoed a prohibited attack marker and misdescribed a quoted instruction to announce an erasure as an instruction to erase records. It also omitted a delivery amount and an explicit no-reply statement. The candidate preserved the delivery amount, but failed before inference on three other cases. These are not eight independent estimates of general model accuracy, and the scores are not comparable to the different twelve-case draft evaluation.

The unchanged runtime reserves output and safety space from the 4,096-token profile using a conservative byte budget. With 1,000 output tokens, input is bounded to 2,840 bytes. Three candidate prompts were 2,887, 2,852 and 2,869 bytes. They produced no model output. The evaluator exited with status1 and retained those failures; it did not enlarge context, truncate source data or retry them silently. Thirteen actual generations completed across sixteen paired attempts.

## Reproducibility and limits

- Cases, criteria, candidate text and evaluator were committed at `805bffd54bdf8e1837360a0b594700a5a0778d37` before inference. Case-file SHA256: `44b36be9b384198ac135c955175354d2e28bc32a0b6048d3b1886c87c3347cce`. Candidate-prefix SHA256: `818fc37edbc60bd0e6b89c1f9baa5cb825f959a3afb1aca66462edf35c96fafb`.
- The already-installed original `qwen3.5:9b` digest is pinned to `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Inference uses only the Mac's literal `127.0.0.1:11434` endpoint. The evaluator rejects other platforms and changed digests; no models are downloaded.
- The baseline uses the exact production summary request, prompt builder, output schema, parser and runtime. The candidate adds one fixed prefix. Neither variant runs the reply phase, accesses Mail, writes a draft or sends a message. Source authorization and personal/native acceptance are outside this experiment.
- Paired order alternates by case. Each variant receives one attempt; timings are retained without a speed ranking. The implementing assistant reviewed the outputs, so assessment is neither independent nor blinded.
- The prefix was informed by prior exposed errors. These new instances were fixed before generation, but are now exposed regression cases. Future tuning needs a further frozen evaluation set.

The next candidate should shorten summary instructions while preserving actor ownership, modality, negative facts and actual outcomes of quoted instructions. It must be tested against the same input limits before production changes. Neither this result nor valid JSON closes the broad model-quality requirement.

The [complete evidence](evidence/mail-summary-fidelity-2026-09-25.json) includes exact inputs, criteria, prompts, schemas, raw outputs, parsing results, hashes and per-case notes. Reproduce only on the authorized Mac with `npx tsx scripts/mail-summary-fidelity.ts`; failed capacity checks intentionally make the process exit nonzero. No Acer model, runtime or news job was accessed or changed.
