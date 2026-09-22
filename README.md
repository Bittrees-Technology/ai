# Bittrees AI

Local AI execution for explicitly authorized Bittrees app data.

Status: local foundation under development. Contracts, an encrypted SQLite task/inbox store and an authenticated Express API factory are implemented and tested. A local Ollama adapter and serial model worker are implemented. A development macOS launcher and local dashboard are available. Signed distribution, production connectors and remote encryption remain pending. Repository creation does not activate any app permissions.

## Development

Use Node.js 24 LTS. Run `npm ci`, `npm run check`, `npm test`, `npm run contracts`, and `npm run build`.

`modules/contracts` contains strict versioned JSON schemas and generated OpenAPI shapes. `modules/domain` contains a deny-by-default authority intersection. Source adapters must obtain current rights from the source; request fields never establish identity or authority. Contracts reserve API shapes and do not imply those endpoints are implemented.

The intended storage split is local SQLite and hosted PostgreSQL. Local inference will start with Ollama. Prompts, results and memory stay local unless explicitly published through a source-owned action or later encrypted remote mode. Remote status uses a strict metadata allowlist.

Product content is retained until the user deletes it, with export/deletion controls required before a personal-data pilot. Future encrypted remote access will use a user-held recovery key; Bittrees will not hold recovery secrets. None of these future capabilities is a current security guarantee.

Planning checklists remain local project guides and are not published in this repository. This repository contains implementation, interface contracts, tests and operational documentation only.

Licensed under MIT. Imported models retain their own licenses.

## Local task foundation

`Store` provides owner-scoped tasks, serial conversation claims, explicit dependencies, fencing generations, heartbeat leases, bounded transient retries, cancellation, event/outbox transactions, export and deletion. Inference and network actions must run outside its synchronous transactions. `localApi` authenticates every route, rejects untrusted Host/Origin headers and currently rejects all source references. Worker claims are internal and are not exposed as user HTTP routes.

Prompts and results use AES-256-GCM with record-bound authenticated data. Input fingerprints use a keyed HMAC. IDs, status and timing metadata remain visible in SQLite; this is not full database encryption. The macOS Keychain adapter loads or creates the storage key and refuses to replace a missing key for existing data. The development launcher uses this key-store adapter; signed packaging is pending. Whole-file encrypted backup/restore is available for snapshots up to 32 MiB; restore refuses to overwrite an existing database. Keep the original key separately available: backups contain no key. An older backup can retain deleted content.

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

The launcher connects this API to the local dashboard. Generated OpenAPI currently documents only the initial request/message/command subset; the routes above are implemented and covered by integration tests. No public HTTP service is enabled by importing this module.


## Development launcher and dashboard

On macOS with Node 24 and Ollama installed, run npm ci, npm run build, then npm start from this repository. Open http://127.0.0.1:43127. Enter the one-time code from the private file whose location is printed by the launcher. Codes expire after ten minutes and ten failed attempts; restart to pair again. The browser receives an HttpOnly, SameSite=Strict session cookie, valid for at most eight hours. Tokens are not passed in URLs or exposed to client JavaScript. Locking revokes the session. The service accepts mutations only from its exact local origin; browser pairing grants no source-app permissions.

Data lives in ~/Library/Application Support/Bittrees AI/; its storage key stays in macOS Keychain. The service reserves its loopback port before accessing the key/store, so a second instance cannot replace pairing or initialize competing keys. Stop with Ctrl+C. Shutdown stops the worker, drains HTTP requests and removes the pairing-code file; restarting invalidates prior browser sessions. Interrupted generations are not automatically resumed as though completed.

The dashboard implements task creation and detail/history, pause/resume/cancel, model profiles/defaults/switching, memory candidates/review/edit/pin/forget, explicit memory selection, export and local deletion. It labels unfinished model imports and app connections. Refreshing the browser loses unsent text; failed submissions retain it while the page remains open and reuse the same idempotency key for an unchanged retry. Retained task content is not automatically shared with any external app.

This is a development build, not a signed installer or public release. Update by stopping the companion, backing up the data and original key, checking out a reviewed release, reinstalling exact lockfile dependencies and rebuilding. Do not downgrade a store schema without a compatible backup. Installer signing, automatic update integrity, visual/keyboard acceptance and remaining P3 features are still pending. Device resource display is described below.


## Personal Inbox

The local Inbox supports inbox discovery, recent conversation previews, bounded message pages, local messages and replies, optional reply deadlines, explicit read/acknowledgement receipts and open/overdue/closed check-ins. Personal inbox creation derives its user and tenant on the server. Every query and receipt remains owner-scoped; reading does not complete tasks, and only a saved reply closes its parent check-in. Open check-ins are prioritized over closed ones.

Messages are local records, not outbound mail or implicit model tasks. Unsent text survives switching dashboard sections while the page remains open, but not a reload. An unchanged failed save reuses its idempotency key. The conversation list currently shows the 100 most recent conversations; full export retains all records. Browser visual/keyboard acceptance remains pending.


## CRM connection pilot

The Connections panel can initiate source-owned CRM consent using a one-time PKCE challenge. The user selects records, reviews read-only scope and expiry in CRM, then pastes the short-lived code into the companion. Source activation remains disabled by default in CRM; this release does not enable it. A source operator must separately enable that pilot. Record loading and local draft creation require explicit user actions. Reviewed-write modules are available for integration; publication controls and external-source memory remain pending.

One CRM identity is stored per personal macOS profile in the separate org.bittrees.ai.connector.crm Keychain entry. Tokens never enter browser responses, exports, prompts or URLs. The panel reports stored/expired credentials, not an unverified claim of current access. Source subject/workspace and exact selected record count are visible; no SSO or identity match is inferred.

The module restricts requests to https://crm.bittrees.org, rejects redirects, uses a 15-second deadline and a 2 MB response bound, validates strict read responses and exact identity/resource scope, and checks local expiry/removal before releasing source data. Every read reaches the source for current permission checks. Network errors are sanitized. A failed/uncertain one-time exchange requires new consent; it is never blindly replayed.

Disconnect CRM in Connections to revoke the source grant before deleting its local credential. A durable disconnect-pending state pauses reads before dispatch; network or Keychain failures retain this state across restarts for safe retry. The source endpoint acknowledges already-cleared tokens, supports expired grants, and stays available when the source feature is disabled. Alternatively, revoke on CRM's consent page and remove the local credential separately. Local removal alone does not revoke the source grant. Task/memory deletion and export do not manage connector credentials; Connections owns that separate control. Disconnecting or removing the credential fences pending module reads. UI visual acceptance remains pending. Selected-record draft integration is described below.


## Source-bound draft engine

The trusted CRM task adapter derives the source subject, workspace, grant, policy, exact record revisions and a hash of the permitted record projection. It stores that binding atomically with the queued request in encrypted SQLite (introduced in schema version 5). Reusing a request key under a different source binding is a conflict. Caller-provided source references remain rejected by the generic HTTP task endpoint. Connector credentials and source record bodies are not stored in task inputs.

The worker fetches current selected records before inference and revalidates the exact binding before committing a draft. Source edits, changed projections, lost access or local disconnect prevent completion. Source context is marked as untrusted data; no model tools or publication are enabled. Run history records encrypted source provenance. Local-task memory cannot be created from these source-bound tasks.

Source-bound detail and run-history APIs revalidate access before returning derived content. List and bulk export conservatively conceal derived results and references; they are not complete exports of source-derived content. Source outages also conceal results. Existing independent exports cannot be retracted. Current task storage retains encrypted results until deletion, but this is not authority to expose them after revoke.

The launcher wires the source adapter, worker and guarded read projection, including the selected-record workflow below. The generic create endpoint remains local-only. Complete CRM pilot acceptance remains pending.


## Selected-record CRM draft workflow

Connections → CRM now loads the permitted record names on demand, lets the user select a subset and a local model profile, and creates an idempotent local draft request. The trusted adapter derives authority and source revisions; the browser cannot submit them. No destination writes are performed. The source feature still requires separate operator activation.

Source task details refresh their access-checked result/history every 15 seconds while focused. Losing focus clears the source view and record-choice list; late choice responses cannot restore a cleared view. This is periodic revalidation, not instantaneous revocation of already displayed data. Disconnect/local credential removal signals active source generation to abort.

Export this task uses GET /v1/requests/:id/export and revalidates current source authority before returning its complete task/result and run history. The bulk export continues to conceal source-derived results; export an authorized source task individually. A denied or offline source returns an error instead of a partial success. The synthetic HTTP workflow is tested; actual browser/keyboard acceptance, real-source/local-model pilot quality, reviewed CRM writes and external memory remain pending.


## Reviewed-write transport and durable proposals

Trusted modules can reserve an immutable note/task proposal from a completed source-bound draft and the source's separate write permission. Each encrypted proposal retains its operation ID, exact source projection, destination, content, review digest and confirmed receipt across restarts. A lost response is marked uncertain; an explicit retry uses the same operation or review identity. Nothing automatically approves or publishes a proposal. Approval belongs to the signed-in user on CRM's private exact-review page; the companion receives only an opaque review link.

Write requests are fixed to the CRM origin, bounded and strictly validated against the saved connection. Credential changes wait for an in-flight write response to be captured. The source reconciles existing receipts before validating stale review content, allowing a committed record to be recognized after later edits without authorizing a changed new write. A deleted destination receipt never recreates a record.

Authorized per-task export includes proposal records; bulk export still conceals source-derived content. Deleting local task data cascades to local proposals, not independently staged or published CRM content. Schema 6 adds the encrypted proposal ledger; use a compatible backup to roll back to older binaries. The local mutation routes and dashboard workflow below integrate the write service and protect deletion while requests are in flight. Browser and live-user pilot acceptance remain open.


## Companion review and publication controls

Each CRM draft now includes a publication panel. Enable a separate write grant on CRM first, load the current draft, edit an exact note/task proposal, and save it locally. The selected target and permission epoch are checked again before saving. Sending for review is a separate explicit action that transfers the saved content to CRM. The private source page shows exact content, destination and audience and owns approval. Returning to the companion and choosing Publish approved proposal / reconcile receipt asks CRM to publish only if its current checks pass.

The proposal list exposes only operation/review/receipt metadata, even if source content has changed or become unavailable. View saved content and draft editing require current source access; sensitive views clear on focus loss and revalidate every 15 seconds. Unsent proposal editor content clears on focus loss, so save locally before switching to CRM. Saved proposals are immutable; changed content needs a new proposal and approval. Reconcile uncertain publications before making replacements.

Local task deletion is rejected while reservation, preparation or publication is in flight, so it cannot discard a pending receipt. After completion, deletion removes local proposals but does not revoke grants or erase independently staged/published CRM content. Confirmed local receipts report historical outcomes, not current access or ongoing record existence. Full HTTP tests cover scope changes, forged local approval, source denial, content-gated export, duplicate submission, receipt recovery and overlapping deletion. Browser/keyboard acceptance and a real-source user pilot remain pending; production activation remains disabled by default.


## Local device resources and import cancellation

Device now reads an authenticated, no-store `/v1/device` snapshot every ten seconds while visible. It shows platform/architecture, processor count, total/free physical memory, the companion process memory (excluding Ollama), free space on the data volume and the actual import file/total limits. Missing disk information is shown as unavailable. It does not return hostnames, account names, local paths or network interfaces. Memory and disk snapshots are advisory; model context and runtime copies can require more resources.

Model import commits reserve their active slot before asynchronous review/file verification, so duplicate commits and cancellation are handled throughout that phase. Cancellation during runtime creation remains uncertain; reconciliation inspects the unique model name after restart and never blindly creates another model. Synthetic tests cover pre-dispatch cancellation, overlapping commits, active-create cancellation and recovery. Reviewed import controls are described below; browser/keyboard acceptance remains pending.


## Reviewed model import jobs

Models now offers local macOS file selection and public Hugging Face repository imports. The browser never supplies filesystem paths: a fixed native chooser supplies local paths to the trusted adapter. Local selection stages and hashes files. Repository lookup accepts an exact commit and selected artifact paths, presents license/size/hash metadata, and requires an explicit approval before downloading. Both paths then require a separate exact installation review before sending artifacts to loopback Ollama. Gated/private repository authentication is not connected by this interface.

One import operation runs at a time. Jobs return promptly and the visible Models panel polls their status. Cancellation aborts selection, download or runtime requests; cancellation during installation may leave an uncertain outcome. Restart never resumes a download or creates a replacement model automatically. Reconciliation inspects the original unique model identity. Installed models appear in the profile selector, but their output quality is not yet validated.

Job history is encrypted in model-imports/jobs.db with the device storage key. Staged model artifacts and review manifests are protected by the private application directory and are not application task content. Import history/staging is separate from task/memory export and backup. Its Delete control removes the local job and staged files, including interrupted partial downloads; it does not uninstall an Ollama model or undo a runtime request already dispatched. Keep the original storage key and a stopped copy of the import directory to preserve this separate history. The importer caps retained jobs at 100; clear old local records to make room.

Tests cover separate download/install approval, wrong digest, encrypted history/restart, wrong-key refusal, interrupted state, cancellation, uncertain reconciliation, cleanup and authenticated path-selector denial. Native picker script compilation passes on macOS; interactive chooser and browser/keyboard acceptance remain pending. Existing GGUF/Safetensors module and real-model evidence does not establish every imported architecture's quality. No schema change is made to task storage; the separate import-job database starts at schema 1.

## AutoNote credential and transcript foundation

The AutoNote connector module supports one explicitly approved meeting per personal profile, using source-owned consent and a single-use PKCE code. Its separate `org.bittrees.ai.connector.autonote` macOS Keychain entry stores the credential; status never returns the token. Requests use only the fixed AutoNote HTTPS origin with redirects disabled, bounded responses and a timeout. The launcher and Connections workflow now use this module for selected-meeting drafts.

Reads validate the saved account/workspace/grant, selected meeting, policy, transcript version, unique segment IDs and finite timestamp bounds. The companion independently recomputes the source projection hash and enforces the one-MiB transcript limit. Unexpected fields, recording keys, notes and integration credentials are rejected. The module cannot approve a save or publish to CRM. Its review transport below stages drafts for the separate AutoNote-owned save path.

Disconnect persists a suspended state before contacting the source, survives restart after an uncertain response, and deletes the local credential only after acknowledgement. Explicit local removal is separate from source revocation. Pending reads cannot return after either operation invalidates their connection. Source activation, reviewed saves and end-to-end pilot acceptance remain pending.

## AutoNote trusted draft engine

`AutoNoteTasks` derives the selected meeting's authority, revision and transcript hash from the source response and saves the binding atomically with the encrypted request. One binding belongs to exactly one app and workspace. An explicit source router selects the matching adapter; absent adapters do not fall back. The worker checks current access and exact source content before generation and again before saving. Credentials and transcript bodies do not enter task input or run provenance.

AutoNote output must be bounded JSON containing summary claims and suggested actions, each referencing existing segment IDs. The companion resolves timestamps from the validated transcript and labels all action owners/deadlines as unconfirmed suggestions. Malformed output, unknown citations and model-supplied approval/timestamp fields fail without a saved result. Citation membership does not prove factual correctness: drafts still require human review. Existing local model context/output limits apply; oversized transcripts fail rather than silently truncating evidence.

CRM adapters and the CRM publication ledger explicitly reject AutoNote bindings. Meeting saves/publication remain AutoNote-owned. The launcher, HTTP and dashboard now integrate the engine as described below. `npx tsx scripts/autonote-local-check.ts` runs a synthetic-only check against the installed local Qwen model, without connecting to a source app or publishing. This check verifies one small example, not general meeting-summary quality.


## AutoNote companion workflow

Connections → AutoNote starts separate source consent, accepts its one-time code, and reports the saved account/workspace/expiry. Load permitted meeting returns only the approved meeting label and version; an explicit action creates a cited local summary with the selected model profile. Meeting labels clear when the window loses focus. App-specific controls distinguish source revocation from local credential removal. Disconnect interrupts only generation associated with that app.

Source task detail and individual exports use the matching adapter for fresh access/content checks. Lists and bulk exports conceal source-derived results; denied individual exports fail instead of returning partial content. The source detail clears on focus loss and revalidates every 15 seconds while visible. AutoNote tasks show unconfirmed suggestions and do not offer the separate CRM publication controls. Explicit submission and receipt controls are described below; this release does not activate production source access. HTTP integration is tested, while browser/keyboard and real-source pilot acceptance remain open.


## AutoNote review transport

The connector can check the source review permission, stage an immutable bounded proposal, and recover metadata-only review/receipt status using the existing AutoNote credential. It cannot enable review uploads or approve a save. Source-session review remains on AutoNote’s private page.

Proposal validation matches the source’s canonical field order and limits. Responses must match the exact proposal digest, meeting, operation ID and resulting version; contradictory deleted/saved states and unexpected fields are rejected. The connector holds credential mutations until an in-flight response is captured, uses only fixed AutoNote endpoints and never automatically resubmits uncertain requests. Expired idempotent reviews remain expired rather than creating replacements. Durable operation history and explicit staging/reconcile controls are described below. Source review links open the exact draft through AutoNote’s current signed-in account.

## Durable AutoNote submission ledger

Schema 7 adds encrypted AutoNote operation history tied to each completed source-bound task. Each draft has one immutable submission identity, preventing a changed retry key from reserving a duplicate submission. Reservation derives the payload from the validated generated result, strips companion-only citation/status fields, and requires current source permission. It does not send anything.

Explicit preparation records uncertainty before network dispatch. A lost response or failed local receipt write therefore remains uncertain after restart. Explicit reconciliation asks AutoNote for the original operation's receipt without resending the draft or requiring the old transcript version; saving into AutoNote itself changes that version. Responses must retain the same review identity, digest and expiry. Saved/deleted outcomes are terminal, and source approval remains outside the companion.

Task backups include this ledger, and local task deletion cascades to its local operation history. A compatible backup is required when rolling back to binaries that understand only schema 6. The HTTP deletion guard refuses to erase task history during an active reservation, send or receipt lookup. Source review links preserve source-owned approval. This increment does not enable source permissions or add automatic sends.


## AutoNote submission controls

A completed AutoNote task offers separate actions to prepare its immutable submission locally, explicitly send it for source review, and check the original receipt. Enable review uploads on the AutoNote consent page first. The companion cannot approve a save. The source review link opens the exact draft in AutoNote. Source access is checked again, and saving still requires explicit confirmation there.

Submission status and historical receipts remain readable after a save changes the meeting version. Viewing exact content or exporting the task and its submission still requires fresh source access and an unchanged source projection. Visible submission content clears after 15 seconds or when leaving the window. An uncertain send retains its original identity for explicit retry or receipt recovery; there is no automatic resend.

Deleting local task data removes local submission history after active operations finish, but independently staged source drafts must be deleted on AutoNote. HTTP tests exercise authentication, forged approval rejection, immutable retries, guarded content/export, concurrent deletion and saved-receipt recovery. Local browser/keyboard and real-source pilot acceptance remain open.


## Three-repository AutoNote acceptance

`scripts/autonote-integration-check.ts` exercises the actual companion connector, trusted task worker, encrypted submission ledger, AutoNote route/save code and existing AutoNote-to-CRM publication code. GitHub checks install pinned AutoNote/CRM revisions and use disposable PostgreSQL schemas in a dedicated `autonote_test` database. For a local run, set `DATABASE_URL`, `AUTONOTE_REPO` and `CRM_REPO` to installed checkouts. Never point it at a production database.

The check proves PKCE transcript consent, cited synthetic generation, separate review permission, uncertain staging recovery, source-owned save, historical receipt recovery after the version changes, rejection of unaccepted actions, normal action acceptance, and publication to the separately approved CRM destination. It drops a successful CRM response, retries through the original path and verifies exactly two destination records/receipts, then checks fresh-preview deduplication and revoked destination access. Transport invokes actual source code in-process and refuses external requests; inference is deterministic test output. This is contract/workflow evidence, not browser, hosted-network or model-quality acceptance.

## Roles own-access connection foundation

The Roles broker uses a separate `org.bittrees.ai.connector.roles` Keychain credential and fixed HTTPS origin. Single-use PKCE consent grants only `read_own_access`; the module cannot change roles, enroll agents or call authority decisions. Read responses must match the saved grant/profile/expiry and independently verified projection hash, with strict fields, bounded size and fresh observations. Reported effects remain separate from unverified effective/confirmed/acknowledged access. Arbitrary source fields, emails, credentials and authority claims are rejected.

Disconnect suspends the saved credential before sending to Roles and retains that state after uncertainty for explicit retry, including after restart. Local removal is separate from source revoke; either fences in-flight reads. This backend is not wired into the dashboard yet, and no Roles data enters task prompts or memory.

`ROLES_REPO=/path/to/installed/roles npx tsx scripts/roles-integration-check.ts` runs actual Roles consent/read/disconnect routes and the companion broker against isolated in-process Postgres. CI pins the source revision. It verifies profile privacy, canonical response hashes, source-outage denial and disabled-feature disconnect without network requests or live credentials. Companion UI/browser and real-source pilot acceptance remain open.
