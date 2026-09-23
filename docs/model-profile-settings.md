# Configurable local model profiles

Models now exposes the existing engine's context budget, reply limit and temperature (labelled Variation). The initial values stay 4,096 / 512 / 0.2. Saving explicitly creates a new immutable profile and selects it as the default for future work. Existing tasks keep their chosen profile unless the user separately switches that task. A new default does not rewrite completed results or run history.

The form accepts the existing contract ranges: whole-number context from 256 to 131,072 tokens, reply limit from 1 to 8,192 tokens, and finite temperature from 0 to 2. It also mirrors the Store requirement that context exceed reply limit by at least 257 tokens. Empty, non-finite, out-of-range and unusable combinations cannot be submitted from the form. The server's existing validation and local-model pinning remain authoritative.

Profile choices in Tasks, CRM, AutoNote, Mail and Templates show settings to distinguish profiles using the same model. Saved profiles also show their IDs. Tasks repeats the selected settings below the selector so they remain readable when a narrow native menu clips its option text. Projections that only include model/ID retain an ID fallback. Source-free run history displays recorded settings from that run, not the current default. Connected-app history concealment remains unchanged.

Larger context/output requests may need more memory and time; these settings neither guarantee fit nor improve factual accuracy by themselves. The engine retains its conservative input-byte budget and other size checks. This change does not configure global concurrency, enforce a resident-memory ceiling, increase a model's native context capacity, retrain it or change the runtime timeout. Device resource management and model-quality acceptance remain separate work.

Verification combines form validation, same-model distinction, actual authenticated local HTTP → Ollama adapter → worker → recorded-history tests with a disposable loopback model server, and full-dashboard Chromium/Firefox/WebKit scenarios in GitHub CI. Synthetic runtime responses do not establish actual model quality or performance. No installed profile, app bundle, model download/weight, cloud setting, source grant or Acer-server/news job is changed during this implementation.

The existing Avenir/system typography and ink/mist/evergreen palette are retained. The three controls share one labelled fieldset, use a three-column desktop layout and stack on narrow screens. Saved configurations remain left aligned and wrap long IDs.
