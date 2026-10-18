# Task coordinator and agent profiles

The Mac task coordinator serializes whole execution bodies, not just model calls: local inbox tasks, investor research, qualification, CRM project work, directory checks, central workflow work, CRM task sync, recurring runs/verification and saved investor reviews. Source discovery/status synchronization and user edits can continue; they do not execute a second model task. Model downloads and explicit model diagnostics are not task execution.

Workflows → Task queue & agents shows the active task, waiting tasks, recent returns/holds, agent profiles and draft results. Queue pause prevents new execution; cancel signals the active worker and retains the slot until it actually returns. Source-specific adapters retain authority, cancellation and evidence rules. A worker return is not proof of external task completion.

Queue metadata and profiles use the existing encrypted local vault. Queue pause persists. After restart, interrupted queue records are held for source reconciliation, never blindly replayed. Original source schedulers remain responsible for durable retries and current authorization. No original schedule is activated or paused by this feature.

Profiles specify role, methodology, bounded reference knowledge, and local model profile. Assignments select the model at the next pin and append supporting context without replacing fixed workflow validation. Source workflow IDs are `local-tasks`, `investor-research`, `crm-project-work`, `qualification-research`, `directory-evidence`, `central-workflows`, `saved-investor-evidence`, and `recurring-work`. Changed assignments/profiles invalidate active reasoning. Existing workflows without assignments retain their current model and prompt. Profiles confer no source or tool authority.

Draft tasks have caller-generated immutable operation IDs, pinned profile revisions, local model digest and output receipts. Resubmission is idempotent; a conflicting input is denied. Drafts cannot write sources or mark CRM tasks complete. All active specialists share the same single task slot under the deterministic coordinator; no separate always-running coordinator model is required.

## REST transport

Existing authenticated local workspace endpoints: GET `/v1/agents`; POST `/v1/agents/profiles`, `/bindings`, `/tasks`, `/queue`. They inherit pairing authentication and origin checks; they are not publicly exposed.

Remote inter-agent transport is prepared in `modules/agents/rest.ts` and `rest-server.ts`: real HTTPS only, exact operator-pinned origin, scoped bearer/current authority, immutable operation/idempotency ID, bounded JSON and timeout, redirects denied, source receipt required for completion. The server does not trust forwarded headers as TLS. No remote listener or peer is enrolled. Deployment must bind existing Roles delegation to `authorize`, persist idempotency in `submit`, and recheck source authorization when executing. Do not expose the local pairing API remotely or infer remote authority from a profile.

## OpenRouter

Transport prepared, not activated. No key reads, provider calls, automatic model fallback or network policy changes. Current prepared adapter accepts only explicitly selected `:free` model IDs with zero prompt/completion/request price ceilings, no provider fallbacks, required parameters and zero-data-retention routing. These filters are not evidence of the user's account billing controls; verify account allowance and hard-stop controls before any activation. Paid models require a separately approved maximum amount and duration.

Source workflows cannot export their content to OpenRouter. A future explicit cloud draft approval must identify the selected model and exact task content; stored knowledge is not globally exportable. See the local cloud approval proposal for the pending boundary. Mock transport tests are not live cloud or remote-agent verification.
