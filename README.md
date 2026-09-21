# Bittrees AI

Local AI execution for explicitly authorized Bittrees app data.

Status: local foundation under development. Contracts, an encrypted SQLite task/inbox store and an authenticated Express API factory are implemented and tested. A local Ollama adapter and serial model worker are implemented. No packaged launcher, deployed dashboard, production connectors or remote encryption is available yet. Repository creation does not activate any app permissions.

## Development

Use Node.js 24 LTS. Run `npm ci`, `npm run check`, `npm test`, `npm run contracts`, and `npm run build`.

`modules/contracts` contains strict versioned JSON schemas and generated OpenAPI shapes. `modules/domain` contains a deny-by-default authority intersection. Source adapters must obtain current rights from the source; request fields never establish identity or authority. Contracts reserve API shapes and do not imply those endpoints are implemented.

The intended storage split is local SQLite and hosted PostgreSQL. Local inference will start with Ollama. Prompts, results and memory stay local unless explicitly published through a source-owned action or later encrypted remote mode. Remote status uses a strict metadata allowlist.

Product content is retained until the user deletes it, with export/deletion controls required before a personal-data pilot. Future encrypted remote access will use a user-held recovery key; Bittrees will not hold recovery secrets. None of these future capabilities is a current security guarantee.

Planning checklists remain local project guides and are not published in this repository. This repository contains implementation, interface contracts, tests and operational documentation only.

Licensed under MIT. Imported models retain their own licenses.

## Local task foundation

`Store` provides owner-scoped tasks, serial conversation claims, explicit dependencies, fencing generations, heartbeat leases, bounded transient retries, cancellation, event/outbox transactions, export and deletion. Inference and network actions must run outside its synchronous transactions. `localApi` authenticates every route, rejects untrusted Host/Origin headers and currently rejects all source references. Worker claims are internal and are not exposed as user HTTP routes.

Prompts and results use AES-256-GCM with record-bound authenticated data. Input fingerprints use a keyed HMAC. IDs, status and timing metadata remain visible in SQLite; this is not full database encryption. The macOS Keychain adapter loads or creates the storage key and refuses to replace a missing key for existing data. A packaged launcher is still pending. Whole-file encrypted backup/restore is available for snapshots up to 32 MiB; restore refuses to overwrite an existing database. Keep the original key separately available: backups contain no key. An older backup can retain deleted content.

A task blocked on a failed prerequisite remains queued until cancelled; automatic dependency-failure propagation and configurable capacity are pending. Messages, read/delivery/acknowledgement receipts and due/closed/overdue check-ins are persisted. Messages and tasks share conversation sequencing; receipts do not complete tasks. Personal-device inboxes may name an agent or manager but cannot add another user. No source-app side effects are attempted or retried by this foundation.

## Model execution

`LocalWorker` runs one local task at a time outside database transactions, renews its lease, saves the model profile/digest for each run and refuses stale/cancelled results. Outputs remain unreviewed drafts; no tool call is executed. The Ollama adapter uses only a literal loopback endpoint, rejects redirects and known remote models, checks the selected digest before and after generation, bounds responses, and supports abort signals. The separately installed runtime is trusted software; these checks are not an OS network sandbox.

The adapter supports installed local models. Encrypted saved profiles are immutable; editing creates a new profile. Changing a default leaves existing tasks unchanged. Explicit switching fences the previous attempt and retains its model/run history. Synthetic HTTP tests cover pin changes, cloud-model rejection, cancellation and no tool exposure. Resource scheduling, LM Studio and memory retrieval remain pending.

## Reviewed model imports

`ModelImports` stages GGUF or Safetensors files selected by trusted local application code. Review binds file hashes, sizes, provenance, license and a selected prompt format before installation. It rejects pickle/code files, symlinks, repository execution hooks, mixed weight formats and excessive disk/memory estimates. Safetensors conversion depends on the installed Ollama version; unsupported architectures return a controlled error. Prompt templates are fixed reviewed options, not code downloaded from a model repository. These validations do not sandbox the runtime's native model parser.

`HuggingFaceDownloads` downloads explicitly selected files at an exact commit, verifies available LFS hashes and sizes, restricts HTTPS redirects to approved hosts, and never forwards the Hub token to a CDN. Download review and installation review are separate steps. Imports do not authorize tools or app access, including for abliterated models. Capability and quality testing remain separate from successful installation.

Interrupted creation is reconciled by inspecting its unique model name; it is never blindly retried. Partial downloads are removed, while staged imports and receipts remain until explicitly cleaned up. The importer currently exposes trusted module APIs only; file picker, progress UI, profile management UI and automatic staging cleanup are pending. Do not expose arbitrary filesystem paths through HTTP.

Synthetic local GGUF import and generation passed with Qwen3 1.7B. A commit-pinned SmolLM2 135M Safetensors import converted and generated text on Ollama 0.15.5, but failed an exact-response quality check. Qwen3 Safetensors conversion is unsupported by this runtime version; its GGUF path works.

## Private memory module

`MemoryStore` stores encrypted, owner-scoped candidates in a separate SQLite file. Only reviewed, unexpired and currently authorized records enter a temporary in-memory full-text index. Ranking reports relevance, freshness, bounded user feedback and pinned status. Model-derived statements remain unverified; retrieval does not change feedback. The trusted source adapter supplies access checks and must exclude private CRM owner notes before ingestion.

Review/edit, pin, forget, source invalidation and permission-filtered export are implemented at module level. The authenticated API exposes candidate creation from completed local tasks, review/edit/pin, search, feedback, forget and export. A request may explicitly select up to eight reviewed memories; the worker records their versions and rechecks access/state after generation before saving the draft. No automatic memory selection is enabled yet. The personal-pilot access adapter permits only unchanged completed local tasks owned by the caller; external app sources remain disabled. UI integration and retrieval quality acceptance remain pending. Each owner is limited to 1,000 entries in this pilot. Search indexing is ephemeral; memory database backups use the same encrypted backup helper with the memory store's key. Old backups retain their own lifecycle. Cross-app memory is not enabled by this module.


## Companion controls

Authenticated loopback routes expose installed models (`GET /v1/models`), immutable profile creation/listing and future-task defaults (`/v1/profiles`, `PUT /v1/profiles/default`), task run history and explicit model switching (`GET /v1/requests/:id/runs`, `POST /v1/requests/:id/model`). Pause/cancel and switching signal the running worker after committing the state change; fencing remains the durable safeguard.

Memory routes are enabled only when a trusted `MemoryStore` is supplied to `localApi`. `POST /v1/requests/:id/memories` accepts a user-written candidate attached to that completed local task, never caller-selected source authority. `PATCH /v1/memories/:id` requires the current revision. Search and feedback use POST to keep text out of request URLs. Combined export includes authorized memories; deleting all local task data also deletes owner memory before tasks. Separate memory deletion requires `X-Confirm-Delete: all-local-memory`. Existing older exports/backups retain their separate lifecycle.

The API remains a factory, pending the launcher and dashboard. Generated OpenAPI currently documents only the initial request/message/command subset; the routes above are implemented and covered by integration tests. No public HTTP service is enabled by importing this module.
