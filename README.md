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

Prompts and results use AES-256-GCM with record-bound authenticated data. Input fingerprints use a keyed HMAC. IDs, status and timing metadata remain visible in SQLite; this is not full database encryption. The macOS Keychain adapter loads or creates the storage key and refuses to replace a missing key for existing data. The development launcher uses this key-store adapter; signed packaging is pending. Module-level whole-file encrypted task backup/restore is available for snapshots up to 32 MiB; restore requires the app to be stopped and a new destination without existing SQLite recovery files. It stages and migrates the snapshot privately, clears remote-control consent, closes and syncs the database, then publishes it atomically without overwriting an existing destination. Interrupted preparation can leave a private staging directory, but never a destination with restored permission. Restored receipts remain history; fresh control consent is required. This does not guarantee power-loss durability of the destination directory. Keep the original key separately available: backups contain no key. An older backup can retain deleted content.

A task blocked on a failed prerequisite remains queued until cancelled; automatic dependency-failure propagation and configurable capacity are pending. Messages, read/delivery/acknowledgement receipts and due/closed/overdue check-ins are persisted. Messages and tasks share conversation sequencing; receipts do not complete tasks. Personal-device inboxes may name an agent or manager but cannot add another user. No source-app side effects are attempted or retried by this foundation.

## Model execution

`LocalWorker` runs one local task at a time outside database transactions, renews its lease, saves the model profile/digest for each run and refuses stale/cancelled results. Outputs remain unreviewed drafts; no tool call is executed. The Ollama adapter uses only a literal loopback endpoint, rejects redirects and known remote models, checks the selected digest before and after generation, bounds responses, and supports abort signals. The separately installed runtime is trusted software; these checks are not an OS network sandbox.

The adapter supports installed local models. Encrypted saved profiles are immutable; editing creates a new profile. Changing a default leaves existing tasks unchanged. Explicit switching fences the previous attempt and retains its model/run history. Synthetic HTTP tests cover pin changes, cloud-model rejection, cancellation and no tool exposure. Broader resource scheduling and LM Studio remain pending; explicit reviewed memory retrieval is described below.

## Reviewed model imports

`ModelImports` stages GGUF or Safetensors files selected by trusted local application code. Review binds file hashes, sizes, provenance, license and a selected prompt format before installation. It rejects pickle/code files, symlinks, repository execution hooks, mixed weight formats and excessive disk/memory estimates. Safetensors conversion depends on the installed Ollama version; unsupported architectures return a controlled error. Prompt templates are fixed reviewed options, not code downloaded from a model repository. These validations do not sandbox the runtime's native model parser.

`HuggingFaceDownloads` downloads explicitly selected files at an exact commit, verifies available LFS hashes and sizes, restricts HTTPS redirects to approved hosts, and never forwards the Hub token to a CDN. Download review and installation review are separate steps. Imports do not authorize tools or app access, including for abliterated models. Capability and quality testing remain separate from successful installation.

Interrupted creation is reconciled by inspecting its unique model name; it is never blindly retried. Partial downloads are removed, while staged imports and receipts remain until explicitly cleaned up. The importer currently exposes trusted module APIs only; file picker, progress UI, profile management UI and automatic staging cleanup are pending. Do not expose arbitrary filesystem paths through HTTP.

Synthetic local GGUF import and generation passed with Qwen3 1.7B. A commit-pinned SmolLM2 135M Safetensors import converted and generated text on Ollama 0.15.5, but failed an exact-response quality check. Qwen3 Safetensors conversion is unsupported by this runtime version; its GGUF path works.

## Private memory module

An internal [memory-candidate contract and Mac model probe](docs/memory-candidate-evaluation.md) now records bounded, source-snapshot-bound suggestions with exact excerpt checks. Suggestions remain model-generated, unapproved and unverified; excerpt presence does not prove a paraphrase. Real synthetic runs compare the small model, original 9B and Huihui 9B across two prompt versions. Queue/UI/persistence integration and broader quality acceptance remain open; no automatic extraction rule is enabled.

The Mac Memory screen offers explicit local search with source/version references and explanations of term matches, recency, user feedback and pin status. These are ranking signals, not factual confidence. Search neither approves a candidate nor selects it for a task, and repeated searches cannot inflate usefulness. Editing the query, clearing, leaving the screen or losing focus clears previews; late responses cannot restore them. Changes to the saved memory list invalidate the displayed search.

Candidate entry from a completed local task now exposes preference, fact, decision, outcome and procedure. Saved-memory details show user/model origin, source version and retention without claiming that approval verifies content. Retention remains until deletion by default, and access still depends on the source. Automatic candidate extraction, external-source memory, semantic deduplication and broader retrieval evaluation remain open. Controller privacy tests and actual authenticated HTTP/store tests verify all five types, review filtering, source versions, unchanged usefulness and concealment after source deletion; these do not prove native visual acceptance.

`MemoryStore` stores encrypted, owner-scoped candidates in a separate SQLite file. Only reviewed, unexpired and currently authorized records enter a temporary in-memory full-text index. Ranking reports relevance, freshness, bounded user feedback and pinned status. Search considers the bounded owner corpus and shows at most one exact text per type, preserving the selected record’s own authorized provenance without deleting or merging saved copies. Case, whitespace, negation and differently worded claims remain distinct. The [synthetic retrieval evaluation](docs/memory-retrieval-evaluation.md) records duplicate-crowding and equal-coverage source-diversity measurements and their limits. A request-local repeated-source penalty (0.75 per overlap, capped at 2) reorders candidates only within the leading base-ranked term-coverage group. It never merges source authority, changes saved feedback or deletes pinned memories. Model-derived statements remain unverified; retrieval does not change feedback. The trusted source adapter supplies access checks and must exclude private CRM owner notes before ingestion.

Review/edit, pin, forget, source invalidation and permission-filtered export are implemented at module level. Text edits without explicit renewed approval return a memory to candidate state. Reads, searches and exports discard snapshots changed, deleted or expired during asynchronous access checks; add/review recheck expiry before committing. These version checks also prevent the worker from passing a concurrently edited memory to inference. The authenticated API exposes candidate creation from completed local tasks, review/edit/pin, search, feedback, forget and export. A request may explicitly select up to eight reviewed memories; the worker records their versions and rechecks access/state after generation before saving the draft. No automatic memory selection is enabled yet. The personal-pilot access adapter permits only unchanged completed local tasks owned by the caller; external app sources remain disabled. The local dashboard exposes candidate/review and search controls; native interaction and broader retrieval quality acceptance remain pending. Each owner is limited to 1,000 entries in this pilot. Search indexing is ephemeral; memory database backups use the same encrypted backup helper with the memory store's key. Old backups retain their own lifecycle. Cross-app memory is not enabled by this module.


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

The Roles broker uses a separate `org.bittrees.ai.connector.roles` Keychain credential and fixed HTTPS origin. Single-use PKCE consent defaults to `read_own_access`; the module cannot change roles, enroll agents or call authority decisions. Read responses must match the saved grant/profile/expiry and independently verified projection hash, with strict fields, bounded size and fresh observations. Reported effects remain separate from unverified effective/confirmed/acknowledged access. Arbitrary source fields, raw email subjects, credentials and executable authority claims are rejected.

Disconnect suspends the saved credential before sending to Roles and retains that state after uncertainty for explicit retry, including after restart. Local removal is separate from source revoke; either fences in-flight reads. The launcher and Connections panel now wire this broker into explicit connection and own-access controls. No Roles data enters task prompts or memory.

`ROLES_REPO=/path/to/installed/roles npx tsx scripts/roles-integration-check.ts` runs actual Roles consent/read/disconnect routes and the companion broker against isolated in-process Postgres. The private Roles repository runs this check against a pinned public companion revision. It verifies profile privacy, canonical response hashes, source-outage denial and disabled-feature disconnect without network requests or live credentials. Companion UI/browser and real-source pilot acceptance remain open.


Connections → Roles opens source consent and accepts its single-use code. Load my access observations fetches only the saved profile and shows reported roles/permissions separately from unverified authority, effective access and enforcement acknowledgement. The view clears on focus loss, after 15 seconds, or when the grant/observation expires. Empty observations do not imply that the account has no source permissions.

Disconnect at Roles revokes at source before removing the credential; uncertainty remains visible for retry. Local-only removal requires acknowledging that source permission remains. These actions do not cancel another app’s inference, and the access view is not stored in task history, bulk exports or memory. Authenticated HTTP tests cover consent completion, forged profile rejection, Origin, privacy, uncertainty/retry and app isolation. Local browser/keyboard and real-source pilot acceptance remain open.


### Optional own-policy broker scope

The broker supports `begin({includePolicy:true})` to request an optional source checkbox for `read_own_policy`. Source consent may leave this unchecked and return the original wallet-only grant. A v2 dual-scope grant is rejected unless requested locally; v1 credentials remain unchanged and cannot read policy. Matching action/revision pairs are validated on exchange and every Keychain load.

`readPolicy()` verifies the exact grant/profile/expiry, strict bounded projection, canonical hash, maximum 15-second validity, row expiry and consistent status/authority fields. Stored policy records remain distinct from fresh access decisions and downstream enforcement. Email subject references are hashes; authorized resource strings may contain identifying information. All records are non-executable. Pending disconnect pauses reads across restarts, and credential removal fences in-flight responses.

The actual private-source integration check now exercises v1 and v2 consent, nonempty own-policy filtering, response hashes and source revoke. The authenticated local policy route and Connections controls expose this opt-in flow. Production access and real-user pilot acceptance remain separate release gates.


Connections → Roles offers an unchecked request for own-policy records before starting source consent. The saved connection displays its actual granted scope; wallet-only connections need a new source consent to add policy records. A separate load button retrieves the saved profile’s records without accepting identity selectors. The view explains expiry, suspension, source-owned authority and wallet requirements, and clears on focus loss or snapshot expiry (at most 15 seconds). It does not create tasks, memories or export entries. HTTP checks exercise wallet-only denial and dual-scope loading, Origin/authentication, malformed opt-in, forged profile selectors, local removal and uncertain source disconnect. Local visual/keyboard and real-source pilot acceptance are still open.

## Selected Mail connector foundation

The Mail broker uses its own `org.bittrees.ai.connector.mail` Keychain credential and fixed `https://mail.bittrees.org` origin. PKCE consent occurs in Mail and binds one wallet, mailbox, folder and selected message with exact metadata/plain versions. Metadata-only connections cannot fetch bodies. The broker also accepts separately selected attachment grants as described below. Draft-saving and sending scopes remain unavailable.

Every read validates bounded fields, exact grant/selection/expiry/scopes and the source projection hash. HTML, unexpected attachment fields, unknown properties and changed content versions are rejected. Mail text remains untrusted input. The broker never interprets it as authority or executes message instructions. Credentials expire within the source's short grant lifetime; Mail rechecks the original session, MFA and mailbox assignment on each read. Uncertain source disconnect pauses the saved credential across restarts, and local removal fences in-flight content.

`MAIL_REPO=/path/to/installed/mail npx tsx scripts/mail-integration-check.ts` runs the actual private Mail routes, D1 schema in isolated SQLite, Python selected-read helper and this broker with synthetic messages only. It verifies metadata/body separation, selected-message filtering, canonical hashes, freeze denial and disabled-feature disconnect. No private source or source credential is required in public GitHub CI; CI uses independent broker fixtures. Browser/real-user acceptance, Mail deployment and Acer rollout remain open.


The Mail task adapter binds one reviewed source snapshot to a local summary or suggested reply. It checks access before generation and again before saving, so revocation, credential removal or content changes discard the result. Replies require an available, explicitly permitted plain body. Model output must use a strict summary/reply format and cite supplied sections; citations are resolved to the source message/version. Citation checks establish reference validity, not whether every generated claim is supported; all results remain unreviewed. Truncated content is labeled incomplete. No recipients, tool calls, sending or source draft saving are supported, and caller-supplied source references or external memory cannot create these tasks. The actual-source integration also exercises this worker with synthetic model output; real model quality and user acceptance remain open.


The companion launcher now initializes Mail with its separate Keychain entry and source validator. Authenticated `/v1/connections/mail` controls support consent, status, disconnect and explicit local credential removal. `POST /selection` reads only selected metadata; `POST /drafts` accepts an explicit summary/reply kind and metadata/plain choice, deriving all source identity from the saved consent. Individual result views and exports revalidate Mail access; bulk lists/exports conceal source-derived content. Disconnect/local removal cancels only active Mail inference. These routes do not enable Mail's source feature flag or send mail.


Connections now includes a Mail panel with source consent, expiry/disconnect states and explicit local removal. Loading the selected message shows only its headers; a separate unchecked body option is available only when Mail granted plain-text scope. Replies require that option. Header previews and body selection clear on focus loss or permission expiry, and stale asynchronous previews are discarded. One-time codes are cleared on focus loss and after submission. Task detail identifies Mail correctly, offers a plain-text draft download and a JSON task export, and rechecks source access for both. Downloads are discarded if focus/view changes while access is being checked. No clipboard access, recipient selection or sending is performed. Browser, keyboard and real-model acceptance remain open.


`npx tsx scripts/mail-local-check.ts` probes the production Mail prompt/parser with four synthetic cases using an installed local Ollama model. It found and drove removal of example placeholders that the small model copied instead of summarizing. See [observed results and remaining quality issues](docs/mail-local-model-check.md). The final probe produced valid structures/references, but unsupported reply commitments remain: this is not a completed quality or injection-resistance gate.


Use `MAIL_PROBE_SET=extended npx tsx scripts/mail-local-check.ts` to inspect additional invoice, meeting-decline and authorized-commitment cases with explicit manual criteria. These expose source/user attribution errors even when output structure and citation references pass; the script reports that quality acceptance is not evaluated automatically.

## Mac companion preview

Build the native macOS development app with `bash scripts/package-macos.sh` using Node 24. See [Mac companion](docs/macos-companion.md) for pairing, lifecycle, verification and remaining signing requirements.

### Selected attachment broker

The broker supports `mail-ai-selected-v2` grants containing exactly one MIME part ID and reviewed whole-message version, under a separate `attachment` scope. Legacy metadata/plain grants retain v1. Body and attachment versions must match when both are selected. `read("attachment-text")` uses only the stored selection; it cannot list files or provide replacement selectors. Reads verify the grant revision, exact part/version, canonical source hash, allowed plain-text filename/type, 32 KiB UTF-8 bound and byte count, and absence of control characters/truncation/extra fields. A grant without body permission cannot read the body. Disconnect and local removal fence in-flight extraction.

Broker tests cover restart, contradictory grants, substituted file/version/type/content, and disconnect races. The private-source integration runs actual source consent/HTTP and Python extraction on a synthetic multipart message, proving the companion receives the selected file without the other attachment/body, and rejects changed message versions. No live message is read. Attachment task generation and dashboard selection are described below; native/user acceptance and deployment remain open.

### Selected attachment summaries

Mail tasks and the authenticated draft endpoint accept `attachment-text` for summaries. The dashboard offers this only for an attachment grant, separately from body drafting, and clears the selection on focus loss. The task binds the raw version and encoded part ID, and the worker revalidates source access before and after generation. File contents enter only attachment sections; citations record the message, version, attachment ID and section. Local results identify the filename/size and remain unreviewed. Attachment-only replies are unavailable. Individual view/export rechecks permission; bulk exports remain concealed. Source text beyond the selected model's prompt/context limits is rejected, never silently truncated or sent elsewhere. Real-model quality, large-file summarization and native interaction acceptance remain open.

### Larger attachment handling

When a selected attachment does not fit the chosen local model's single prompt, the worker plans bounded sequential parts before inference. Planning preserves every Unicode code point and accounts for JSON escaping, the user request, output reserve and the existing conservative runtime budget. One pinned model handles all parts. Each part has a unique offset-based citation ID; a model cannot cite another part it did not receive.

Access is rechecked between parts and before saving. Cancellation, revocation, malformed output or capacity failure discards all partial answers. Nothing partial is stored as a completed summary. Successful output reports the number of processed parts and is explicitly a set of part summaries, with no cross-part synthesis; relationships or contradictions spanning parts may be missed. All results remain unreviewed. Requests too large for even one part, more than 128 parts or oversized accumulated results fail rather than truncate or switch to cloud compute. Long real-model quality and native user acceptance remain open.

### Cross-part reconciliation

Oversized attachment results now include a bounded pairwise reconciliation of the part summaries, retaining the original part summaries underneath. Each merge receives only unverified intermediate claims, preserves their original citation IDs, and rechecks source access. Unknown citations, invalid output, capacity or authority failure prevents saving the result. At most seven reduction rounds handle 128 parts; no cloud fallback or silent partial completion occurs.

Coverage labels synthesis as `attempted-unverified`. All input parts being processed does not prove every fact survived summarization. The model can carry forward a bad count, omit detail or inadequately reconcile a correction. See the [observed multi-part limitations](docs/mail-large-attachment-check.md). Native/release quality acceptance remains open.

## Remote status foundation (not activated)

`modules/remote/status.ts` defines the R1 metadata boundary and projects only task ID, paired-device ID, generic state, revision and update time from an actual local task. Remote routing IDs must be UUIDs; source labels, conversation IDs, model names, titles, prompts, results, memory and raw errors are excluded. Status batches are bounded to 100 unique task IDs. The earlier reserved remote-status schema now requires UUIDs; no deployed remote consumer exists to migrate.

Remote controls accept only pause/cancel with expected revision and a maximum five-minute lease; resume and content approvals belong to later encrypted-content work. Templates carry only opaque locally approved IDs/revisions, never free-text arguments. Receipts contain only an allowlisted outcome. These shapes and local lease checks do not authenticate a caller or authorize execution.

Hosted Express/PostgreSQL storage, verified email/SIWE sessions, explicit pairing, durable deduplication, revocation, live status sync and companion dispatch are still to implement. Remote metadata retention is awaiting the user's decision; local content retention remains until deletion. No remote listener or data upload is enabled by these contracts. Future HTTP paths must sanitize validation errors and keep request bodies out of logs. R2 encryption and key recovery remain separate work.

### Remote status PostgreSQL repository

`modules/remote/status-store.ts` and `modules/remote/migrations/001-status.sql` implement internal device/status storage. Verified pairing must create device rows; the repository exposes no enrollment or authentication shortcut. Owner/device/epoch identity is supplied by future trusted authentication, never accepted as public authorization.

Device-row locking serializes sequence updates and revocation. Exact latest-batch replay is idempotent; conflicting/gapped sequences and stale task revisions roll back atomically. Status rows contain only allowlisted columns. Revocation removes status rows, expiry hides them, and explicit cleanup purges expired rows. Unchanged deliveries do not extend retention. Retention must be explicitly configured as 1, 7 or 30 days; this development support does not select the user's policy. Device/revocation tombstone retention and database backup retention remain deployment decisions. `listPage` returns 1–100 statuses and a UUID `nextCursor` (null at the end), using indexed keyset traversal. Every page checks owner/device access and current expiry/revocation; the cursor grants no authority. This is a live view: concurrent inserts before the cursor appear on the next traversal from the beginning, and expired/deleted rows disappear. The compatibility `list` helper returns the first page only. Production quotas remain pending.

`REMOTE_TEST_DATABASE_URL=... npx tsx scripts/remote-status-integration-check.ts` creates and cleans an isolated schema in a test database. It verifies real transactions, concurrent duplicates, wrong-account denial, rollback, expiry, repository reopen, a publisher queued behind revocation, and complete 205-task pagination with cursor replay after expiry/revocation. CI runs it against PostgreSQL 17. This is not a hosted relay or an end-to-end authentication test. No migrations run automatically on app startup and no remote upload is activated.

The implementation follows [node-postgres transaction ownership](https://node-postgres.com/features/transactions) and [PostgreSQL row-lock behavior](https://www.postgresql.org/docs/current/explicit-locking.html). Future routes must keep validation/database exceptions and request bodies out of logs and user-facing errors.

### Remote pairing and device credentials (internal only)

Apply `modules/remote/migrations/002-pairing.sql` after `001-status.sql` in an isolated relay database. `RemoteDeviceStore` is an internal repository, not a sign-in service or a public pairing endpoint:

1. The companion creates a fresh cryptographically random verifier locally and submits its S256 challenge to `begin`. A five-minute request returns an ID and a random approval code; only the code hash is stored.
2. An authenticated owner explicitly approves that request with `approve`. The owner ID must come from a verified browser session, never request-body identity. A request cannot be approved twice or rebound to another owner.
3. The companion confirms the expected account locally, then redeems with its verifier. Approval code possession alone cannot redeem. A row lock makes redemption one-use even under concurrent calls; credential creation and request consumption commit together. If the response is lost after commit, begin a new pairing rather than replaying issuance.
4. `authenticate` validates a random bearer credential against its stored hash and device expiry/revocation. Its returned identity is for `RemoteStatusStore.publish` only; it is not an owner session, source grant, status-reading permission, or control permission. Publication independently rechecks the device lease/revocation. Existing owner-scoped `RemoteStatusStore.revoke` invalidates credentials and removes status rows.

The S256 verifier construction follows [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636); the integration test includes its appendix B vector. This repository is not a complete OAuth/OIDC flow. Random bearer credentials follow the opaque-token approach described in [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). No token/verifier is logged. Device lifetime is mandatory configuration (one minute to thirty days), with no hosted policy activated. Explicit cleanup can remove expired pairing requests.

Real PostgreSQL checks cover unapproved requests, invalid proof/code, account substitution, competing approvals, concurrent redemption, cancellation, expiry, rollback during expiry, hashed storage, repository reopen, authenticated status publication and revocation after authentication. Remaining release work includes verified login, CSRF/Origin/TLS protections, local account confirmation and trusted UI, endpoint rate limits/quotas, rotation delivery/Keychain persistence, automated cleanup, and account/session revocation integration. No remote listener, enrollment or upload is enabled by this package.


`RemoteDeviceStore.rotate` atomically replaces a valid device credential and increments its epoch while preserving the original expiry, owner, scope, task statuses and sequence checkpoint. Old secrets no longer authenticate; identities authenticated before rotation fail the status store's epoch check. Two concurrent rotations using one secret yield one success. Rotation cannot revive revoked/expired access or extend its approved lifetime. If a committed rotation response is lost, re-pair; there is no old-secret grace period. Clients must serialize rotation with publication and securely save the new secret before continuing. Integration tests verify concurrent rotation, stale-identity rejection, deduplicated delivery with the replacement credential, expiry rollback, revocation and epoch exhaustion. Client delivery/persistence remains unimplemented.

### Independent wallet sessions (internal, not hosted)

`RemoteSessionStore` and migration `003-sessions.sql` add an independent companion account/session foundation using [SIWE / ERC-4361](https://eips.ethereum.org/EIPS/eip-4361). Wallet sign-in is a reversible development default while the user's email-versus-wallet preference is unanswered. `siwe` constructs/parses the standard message and `ethers` verifies ordinary EOA signatures offline. Smart-contract wallets (EIP-1271), delegated wallet formats and email login are not supported by this first implementation; no RPC fallback is attempted.

`begin` creates a five-minute exact server-issued message and a separate browser-binding secret. Verification requires the same message hash, requesting-browser secret and wallet signature; it binds HTTPS origin, chain, address, nonce, issue/expiry times and request ID. Concurrent verification consumes one challenge and issues one session. Only token hashes are stored; login messages/signatures are not retained. Accounts are stable per wallet/chain and carry no source-app roles. Sessions are bound to origin/chain and have a mandatory configured lifetime of one minute to one day. Logout removes that session; existing independently approved devices require explicit device revocation. Cleanup removes expired challenges/sessions.

The HTTP layer must keep the browser-binding secret in an appropriate protected cookie, enforce exact Origin/CSRF and rate limits, set secure HttpOnly session cookies, avoid logging tokens/signatures, and revalidate the session for each owner operation. Do not take owner IDs from client bodies. This repository alone does not implement these protections or an atomic account-wide revocation flow. No listener or automatic enrollment/upload has been enabled.

The PostgreSQL integration suite uses fresh synthetic wallets to sign actual messages, rejects changed origin/chain/nonce/statement and wrong-browser/wallet signatures, tests one-use concurrent verification, stable/different account mapping, expiry/rollback/logout, session origin/chain isolation and session/device credential separation, and approves a device pairing with the resulting verified identity. Browser wallet interaction and live acceptance remain open.

### Protected remote HTTP app factory (not started)

`createRemoteApp` in `modules/remote/http.ts` connects the repositories through strict JSON POST routes. It does not open a listener, run migrations, or activate the installed companion. The caller must supply explicit HTTPS origin, chain and session/device/metadata lifetimes. Direct TLS and the exact Host header are required; proxy headers are not trusted. A later deployment behind a proxy requires a reviewed, topology-specific configuration ([Express guidance](https://expressjs.com/en/guide/behind-proxies/)).

Browser routes under `/browser/` require exact Origin, `X-Bittrees-Request: 1`, compatible Fetch Metadata and no bearer header. Secure, HttpOnly, SameSite=Strict, host-only cookies carry login binding/session tokens; neither token is returned in browser JSON. Duplicate protected cookies are rejected. Login, session/logout, explicit pairing approval/cancel, status pages and device revocation derive owner identity from the session. Pairing approval requires `confirmed: true`; the trusted UI still needs to show the account/device and collect that confirmation. These defenses follow the [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) for Origin/custom-header validation and host-prefixed cookies.

Native routes under `/device/` reject browser Origin, cookies and Fetch Metadata. They support pairing initiation/redemption and bearer-authenticated status publication/credential rotation. No control dispatch, private content, source actions or authority-selection fields are accepted. All responses use no-store and fixed sanitized errors; there is no request logger or CORS allowance. Bodies are capped at 32KiB, compressed request bodies are disabled, and a bounded in-process per-peer minute budget rejects excess requests. This is not a distributed quota system: production ingress limits, connection timeouts, database growth quotas and scheduled expiry cleanup remain required.

The integration test creates a short-lived localhost TLS certificate and isolated HTTPS/plain-HTTP listeners, trusts that certificate only in its test client, and removes them afterward. It exercises actual signed login, pairing, publication, rotation, owner status reads, wrong-owner denial, revoke and logout, plus Host/Origin/method/body/cookie/credential separation and forwarded-header rate-limit bypass attempts. This verifies HTTP behavior, not browser wallet interaction, native Keychain storage or hosted release readiness.

### Explicit Mac remote connection client (not wired into the launcher)

`RemoteClient` in `modules/remote/client.ts` implements explicit pairing completion, allowlisted status publication, retry, rotation and local removal. Construction performs no requests. The transport is pinned to `https://ai.bittrees.org/device/`, refuses redirects, omits cookies, bounds response bytes/time, and validates exact response schemas/account/device/epoch/expiry/scope. `remoteKeychainEntry` uses a separate `org.bittrees.ai.remote` service with a validated profile name. Launcher/UI wiring and native Keychain acceptance remain open.

The caller must pass only tasks already read under the local user's authority and obtain explicit consent to share status. `publish` projects only the permitted routing/status fields; prompts, titles, source labels and results never enter the saved delivery journal. The journal and credentials are written and read back from the secret store before sending. One pending batch blocks new publication until an explicit retry delivers the same sequence/content. Reopening preserves that batch; an acknowledgement lost after acceptance can be deduplicated by the relay. Key-store write/verification failure stops that client instance from further sends.

Rotation saves a pending marker before the request; an interrupted or unpersisted rotation requires fresh pairing after reopening. The client never silently retries an old rotation secret. Operations serialize within one client instance; a profile must have a single owning companion process. `forgetLocal` removes local credentials/journal and explicitly reports that it does not confirm remote revocation. The owner must revoke the remote device through the browser. Pairing secrets are memory-only and expire after five minutes; reopening an unfinished pairing requires a new request.

Unit tests use an in-memory secret store to verify restart/retry, private-field exclusion, owner-bound credential storage, interrupted rotation, failed writes and invalid/oversized responses. The real HTTPS/PostgreSQL test now also runs this client through pairing, projection of an actual SQLite task, publication, rotation, reopen, owner revocation and local removal. This is protocol evidence, not proof of native Keychain dialogs, unattended sharing, launcher controls or hosted activation.

### Local companion remote controls (off by default)

The launcher only constructs the remote client when `BITTREES_REMOTE_STATUS=1`; this development setting is not enabled by packaging or installation. Without it, authenticated `GET /v1/remote` reports unavailable and no remote action routes are registered. Enabling the setting still performs no pairing or automatic upload. The existing local bearer/paired-browser boundary protects every route.

The local API exposes explicit confirmed begin/finish/publish/retry/rotate actions and separately confirmed local credential removal. Publication accepts only selected task IDs and expected revisions, loads each through the configured local owner, and rejects extra authority/content fields, duplicate IDs and stale revisions. A retry rechecks task existence under the same owner before sending the saved batch. Task-data deletion is rejected during delivery; otherwise it clears the unsent journal while holding the client's operation lock and then deletes local task data. If a pending acknowledgement was uncertain, clearing that journal requires fresh pairing rather than reusing its sequence with different content. This local deletion does not retract already delivered remote status; the owner can revoke the remote device.

Local HTTP tests verify authentication/Origin checks, explicit consent, cross-owner/stale-task rejection before network access, no private content in outgoing batches, exclusion of deletion during a held delivery, journal removal on task deletion and honest local-only credential removal. Native controls and the browser pairing UI remain to be implemented and accepted; the installed app and hosted service are unchanged.

### Companion remote-status panel

Connections now includes a remote-status panel following the existing local app's layout. It shows the disabled state honestly until the development gate is enabled. Pairing explains the five-minute request and requires a confirmed account code; task status sharing loads recent local tasks, requires selection/review and sends only IDs/revisions to the owner-checked local API. Pending-delivery retry and connection-key replacement are explicit actions. Local removal requires acknowledgement that remote revocation is separate. There is no background sharing.

The panel clears pairing details, account input, task descriptions, selections and review acknowledgement on focus loss. An epoch guard discards late preview responses. Pairing details also clear on expiry. Controller tests cover those races, review reset after selection changes, absence of private descriptions in requests, refresh without pairing/upload, sanitized errors and distinct local-removal semantics. Typecheck/build pass; browser visual/keyboard and native acceptance remain open. The hosted wallet/approval screen remains to be built, and remote hosting and the installed app are unchanged.

### Remote web approval and status screen (not deployed)

`apps/remote-web` contains the standalone web screen. Pass that absolute directory as the remote app factory's optional `assets` setting to serve only the four allowlisted files and public origin/chain settings. Static responses retain no-store, direct TLS/Host checks and a self-only script/style/connect policy; no external assets, analytics or browser storage are used. Without `assets`, the existing API-only behavior remains.

The screen uses an explicitly requested [EIP-1193 wallet interaction](https://eips.ethereum.org/EIPS/eip-1193), checks the connected account/chain around signing, displays the server-verified wallet, and keeps login separate from pairing consent. Users paste the Mac's pairing details, confirm their origin, approve and copy the account confirmation code back to the companion. Focus loss clears pairing inputs, handoff codes and task-status previews. Wallet changes clear the displayed account and request logout; late device/status responses cannot restore an old account's view. No private task content is requested.

The session projection now includes the verified wallet/chain/expiry. Owner device routes require `X-Bittrees-Account` to match the authenticated session, rejecting stale-tab account mismatches; the header never establishes authority. Device lists are owner-filtered and cursor-paginated in groups of 100, including expired/revoked records. The screen supports explicit status loading/pagination and device revocation. Existing relay clients must send the displayed-account header for owner device operations; no deployed client exists to migrate.

Controller tests cover explicit login/consent, network mismatch, hidden approval responses and late device responses after wallet changes. Real HTTPS/PostgreSQL tests serve the page/assets, assert the verified identity, reject wrong displayed accounts, isolate device owners and traverse 101 devices without gaps. These are not browser wallet-extension, visual, keyboard or native acceptance tests. The page is not deployed; retention policy, production operations and the remaining release gates are still open.

### Expiring remote pause/cancel queue (internal only)

Migration `004-controls.sql` and `RemoteCommandStore` add a durable pause/cancel queue. Existing devices receive `controls_enabled=false`; migration 005 and the explicit approval/enable flow below issue a separate control credential. The Mac executor is internal until local delivery and consent UI are wired. Status-publication credentials are not silently upgraded.

Submission requires the owner, a current device and fresh allowlisted task status at the expected revision. Strict requests carry a fixed deadline bounded to five minutes; the stored envelope is also capped by the device lease. Request hashes and device-row locks make concurrent exact retries idempotent without extending expiry, while changed payloads conflict. An expired original intent cannot be resubmitted after retention cleanup to acquire a new lease. Pending queues cap at 100 per device/epoch and polling returns at most 20; delivery alone does not consume or execute anything.

Polling and receipts recheck device ownership, consent, epoch, expiry and revocation. Rotation/revocation invalidates queued delivery. Receipts are typed, deduplicated reports; they do not update task status or prove local execution. Owner inspection distinguishes pending, expired, cancelled and acknowledged history. Receipt/command retention requires explicit 1/7/30-day configuration; no user policy is selected or activated. Revocation removes task statuses via the existing store; command/receipt history remains until its configured cleanup. Production retention/cleanup remains open.

Actual PostgreSQL tests cover disabled-by-default controls, wrong owner/epoch, forbidden fields/actions, stale revisions, concurrent retries, unchanged expiry, duplicate/conflicting receipts, queue cap, bounded polling, expiry, rotation/revocation, repository reopen, cleanup/replay and rollback when a device expires during insertion. The HTTPS factory now contains the control routes described below, but no hosted listener, automatic polling or installed Mac control flow is activated.

### Transactional Mac command execution (internal, inactive)

The local SQLite store now has a pause/cancel executor. It requires a persisted local consent binding to a remote owner, device, credential epoch and expiry. Pairing alone creates no such binding. The future polling client must supply identity from its authenticated delivery session, never accept identity from a command body, and invalidate local consent on connection removal or rotation. The gated local API can now call this executor through a bounded explicit delivery pass; visible consent UI and recurring polling remain open.

Execution checks local task ownership and revision and commits the task transition, worker-generation fence, event and encrypted receipt in one transaction. Exact retries return the original receipt across restart without another task transition; changed payloads conflict. Invalid leases and future-issued commands are rejected (a clock-ahead delivery can be retried after the local clock catches up). Expired commands, missing tasks and stale revisions produce durable typed outcomes without changing a task. Receipt-write failure or expiry during execution rolls everything back. The generation fence rejects late worker output; the Mac client now also signals the active worker to stop after a newly applied pause/cancel.

Schema version 8 preserves existing tasks and starts with no remote-control consent. Commands and receipts remain locally encrypted until deletion, are included in the authenticated local export, and are removed together with control consent by local task-data deletion. Local revocation immediately prevents further execution; it does not delete historical receipts. Encrypted backup restoration preserves receipt history but clears control consent, requiring a fresh local approval. Tests cover restart/replay, owner/device/epoch isolation, unsupported actions and fields, malformed leases, expired consent, late worker completion, transaction fault injection, export/deletion and migration. Local consent UI, credential persistence/polling, interruption signaling and end-to-end browser/native acceptance remain open. The installed Mac app and Acer news/model configuration are unchanged.


### Separate remote control permission

Migration `005-control-scope.sql` adds a separate, hashed control credential and opaque permission ID. Browser `POST /browser/controls/approve` requires a verified owner session, displayed-account match, device ID, expected credential epoch and explicit confirmation; approval expires within five minutes. Native `POST /device/controls/enable` requires the existing status credential and separate explicit confirmation. Redemption is one-use and returns `controls:pause-cancel`, retaining the original device expiry. A lost response requires disabling and approving again. Pairing and status keys never silently become control keys.

Browser `/browser/commands` submits a reviewed pause/cancel envelope, and `/browser/commands/receipt` reads owner-scoped history. Native `/device/commands/poll` and `/device/commands/receipt` require the separate control credential. Poll responses carry the authenticated identity including its permission ID; the Mac executor requires that ID to match its persisted local consent. Control keys cannot publish status, rotate status keys, log in or approve devices. Both browser and native disable routes clear control permission; the native disable route uses the status key. Status rotation also clears control permission and pending approval. Re-enabling creates a new permission ID, so old queued commands and previously authenticated identities stay invalid. Device listing exposes epoch and control-enabled state for an eventual reviewed UI.

Actual PostgreSQL and certificate-verified local HTTPS tests exercise concurrent one-use enablement, owner/epoch/confirmation denial, credential separation, expiry/rollback, hashed storage, repository reopen, disable/re-enable and rotation. A synthetic SQLite task is published, paused through the HTTPS queue and local executor, and acknowledged with an idempotent receipt. This is protocol acceptance, not native user acceptance: Mac control-key persistence and bounded explicit delivery are implemented below; visible consent and command controls, recurring polling, deployment and release gates remain open. No hosted migration/service, installed Mac app or Acer news/model change occurred.


### Mac control credential and delivery client

`RemoteClient` now persists the distinct control credential in the existing separate remote Keychain entry. Enabling writes and verifies an interruption marker before the one-use network exchange, saves the bound owner/device/epoch/permission ID, then records local SQLite consent and activates the credential. Lost responses or failed writes require disabling and confirming again; reopening never retries enablement or silently recreates consent missing after restore. Native Keychain interaction itself still requires user acceptance; fault tests use a secret-store test double.

Authenticated local `POST /v1/remote/controls/enable`, `/disable` and `/check` require `{confirmed:true}` and are registered only with the existing off-by-default remote client. The launcher binds the executor to the local owner. A check fetches at most 20 commands, validates the complete delivery identity and every envelope before execution, executes through the transactional store, signals the active worker to abort after a newly applied command, and acknowledges only typed receipts. Lost receipt responses can be retried through the original durable receipt without another task mutation or another worker interruption. This is one explicit delivery pass, not a background polling loop.

Disable, rotation, local connection removal and task-data deletion revoke local execution permission before further network work. A denied remote delivery also revokes it locally. A failed remote disable remains visibly incomplete; local removal still does not claim server revocation. Operations share the client's existing exclusion lock. Status refresh only reads local state and reports disabled/enabled/confirmation-required without disclosing secrets or starting delivery.

Validation includes secret-write and response-loss faults, client reopen, altered permission identity, remote denial, restore without consent, deletion/rotation/removal and an actual local worker aborted by remote pause with late output rejected. Real certificate-verified local HTTPS/PostgreSQL tests now exercise this client through browser approval, grant persistence, reopen, SQLite execution and receipt acknowledgement. Visible controls, recurring polling and native acceptance remain open; no installed-app update, hosted activation or Acer change.


### Visible pause/cancel review

The remote web device list now offers explicit five-minute pause/cancel approval and disabling. After enabling separately on the Mac and refreshing devices, shared task rows offer a review step for eligible pause/cancel actions. The review identifies the device, task, revision, action and deadline. Submission creates a pending command, not an applied result; explicit receipt refresh distinguishes applied, conflict, denied, expired and cancelled outcomes. Failed submissions retry the same intent ID and deadline. Focus loss/session refresh clears command review and receipt previews; late responses cannot restore them. Task content is never displayed or sent by this flow.

The Mac Connections panel explains the separate permission and requires an unchecked acknowledgement before enabling. It provides explicit check/disable actions, incomplete-permission recovery and clear notice that background receiving is not active yet. Enabling does not trigger a hidden delivery pass. Existing task-status sharing remains manual.

The browser transport now sends the displayed account header on owner actions; this fixes a missing connection between the page's account state and the server's stale-account guard. Controller tests cover explicit confirmation, stable retry intent, receipt outcomes, focus-loss races and account changes. The same browser request helper is tested against the certificate-verified HTTPS server for correct-account success and stale-account denial. Visual/keyboard/wallet-extension/native acceptance and recurring polling remain open. No hosted deployment, installed Mac update or Acer change occurred.


### Opt-in background command receiving

The companion now has one cancellable `RemoteReceiver`, behind the unchanged `BITTREES_REMOTE_STATUS` gate. The Connections panel requires a separate acknowledgement to save background receiving. Startup resumes only that saved choice with active, matching local control consent; ordinary pairing or control enablement does not start it. Status sharing remains manual and no task content is uploaded.

The receiver performs one bounded pass at a time, normally ten seconds apart. Network failures back off through 10/20/40/60 seconds; permission, malformed-response or storage failures stop for attention. An in-flight check is cancelled before stop, shutdown, key rotation, local removal, permission changes or task-data deletion. The client checks cancellation after delivery and before each execution, including when a transport ignores abort. Already applied changes retain their durable receipts for later reconciliation. Manual actions temporarily pause the receiver, then re-evaluate the saved preference and current consent.

Start/stop is exposed through the authenticated strictly confirmed `/v1/remote/controls/receiving` route only when a receiver is configured. The panel shows receiver state and last successful check. The preference survives restart; disabling controls, rotating keys or deleting local content clears it. A failed preference write revokes local consent so reopening cannot silently restore uncertain receiving. Quitting the companion stops receiving; no separate system service is installed.

Tests cover opt-in/start/restart, serialized checks, bounded backoff, busy clients, permission/storage failure, stop during delivery, shutdown during a status read, delayed responses after abort and persistence failure. The real receiver drives the actual Mac client/SQLite executor through verified local HTTPS/PostgreSQL and acknowledges a paused task. Native sleep/wake, visual/keyboard/Keychain acceptance and hosted operations remain open. The installed Mac app, feature gate, hosting and Acer news/model setup remain unchanged.

### Bounded remote expiry maintenance

After all remote migrations through `006-maintenance.sql`, an operator can run one cleanup batch with `REMOTE_DATABASE_URL` configured and `node dist/scripts/remote-cleanup.js --apply --batch-size 100`. The tool requires both explicit apply and a batch size from 1 through 1000; it has no default database, scheduler or retention policy. No cleanup is invoked by the companion or HTTP server.

Each transaction deletes at most the configured number per category: expired statuses, pairing requests, login challenges, sessions and command history past its stored `purge_at`. An expired command lease alone does not erase its retained receipt/history. Two additional bounded categories clear credential hashes/control consent for expired or revoked devices and clear expired pending control approvals. Account/device history, live sessions and active credentials remain. This does not decide the outstanding retention policy or implement account deletion, backups or their retention.

Workers use row locks with `SKIP LOCKED`, five-second statement and one-second lock timeouts. Overlapping workers skip occupied rows and may report zero while another transaction holds expired records; zero is not proof the database has no remaining expired data. The entire batch rolls back if any phase fails. Repeat bounded batches through a separately reviewed operator schedule; alert on failures and monitor counts/backlog before hosted release. Output contains cutoff, limits and counts only; errors do not echo credentials, identifiers, query text or row contents.

Real PostgreSQL tests verify cutoff boundaries, per-category limits, held-row skipping, concurrent cleanup, preservation of live authority and retained command history, revoked credential clearing, and rollback after an injected later-phase failure. CLI tests prove missing configuration/apply and invalid limits cannot initiate cleanup or print the supplied secret. These tests use a disposable synthetic schema; no hosted database cleanup or schedule has been activated.

### Remote stored-row limits

The remote app factory accepts `quotas: { pendingPairings, devicesPerOwner, statusesPerDevice }`. Development defaults are 1,000 stored pairing requests across the service, 100 stored device records per owner and 10,000 stored status rows per device; each configured value must be an integer from 1 through 100,000. These are configurable working defaults, not a selected hosting plan or a retention policy.

Pairing creation and device redemption use transaction-scoped database advisory locks around their count/insert boundary, so multiple service instances cannot overfill a limit through concurrent requests. Device publication already locks its device row; it now counts stored rows and rejects a batch that would add too many distinct task IDs. Any earlier updates in that batch and its sequence checkpoint roll back together. Existing task updates and exact retries remain valid at capacity.

Expired pairing/status rows count until cleanup removes them. Revoked device records also count because their history has not been deleted; repeatedly pairing and revoking cannot grow that history without a bound. Device-history retention/deletion remains a separate operator policy, and reaching its cap requires operator attention or an explicitly configured higher limit. No records are silently evicted to accept new ones.

Capacity returns fixed HTTP 429 `CAPACITY`, distinct from the existing temporary `RATE_LIMITED` response. The Mac retains its exact pending batch and explains the capacity condition; it does not silently alter a delivery or clear local tasks. Tests exercise concurrent pairing/redemption/publication, owner isolation, whole-batch rollback, expired rows before/after cleanup, history counting, exact retry and live HTTPS capacity responses. The client separately tests capacity versus temporary rate limiting. Distributed request/login budgets, account-wide storage budgets, hosting capacity and monitoring remain open; these row limits do not claim to bound all service storage or traffic.


### Local templates

The Mac dashboard's Templates screen saves a name, exact prompt, task type and existing immutable model profile. Saving, running and deleting require explicit local review. Edits advance the template revision; stale run/delete requests fail. There are at most 100 active templates per local owner. The definition is encrypted with owner/ID-bound authenticated data in SQLite schema 9. Deleted definitions leave only an opaque ID/revision tombstone to prevent reuse, until full local-data deletion. Templates and their plaintext prompts are included in the owner's local export and encrypted backups; deleting a template does not delete tasks already created from it or older backups.

The authenticated local API provides GET/PUT `/v1/templates`, DELETE `/v1/templates/:id`, and POST `/v1/templates/:id/run`. Save accepts an opaque ID, expectedRevision (zero for creation), strict definition and confirmed:true. Run accepts an exact expectedRevision, confirmed:true and invocationId UUID; retrying the same intent returns the same task while the template version remains current. A run snapshots the text/profile into an ordinary local task and produces an unreviewed draft through the existing worker. It cannot supply source grants, memory, arbitrary arguments, a new prompt or publication actions. Source-bound templates require a future adapter and fresh source authority.

Template previews and edit confirmation clear on focus loss; stale asynchronous responses cannot reopen them. A failed run can retry the same intent within the current Templates screen, including after focus loss. After leaving that screen or restarting, inspect Tasks before intentionally starting another run. The local template library does not authorize remote runs: remote runs require the separate permission and delivery flow described below. No template content is sent to the relay. Native visual/keyboard acceptance remains open.


### Remote template execution boundary (internal)

`Store.remoteTemplates` provides separate local approval, revocation and transactional execution, connected through the gated client and explicit review screens described below. The existing `controls:pause-cancel` credential cannot satisfy the strict `templates:run` identity. A trusted adapter must authenticate the remote account/device/epoch, bound permission expiry to the device lease and pass the separately approved permission ID; callers cannot choose an identity through HTTP. The client revokes local grants before connection lifecycle changes.

An explicit approval binds one immutable local template revision, a unique permission ID, at most 20 starts and at most 24 hours (development ceilings). Exact approval replay never refills the allowance; revoked IDs cannot be reused. Replacement, edit or deletion invalidates prior permission and cancels unfinished dependent tasks. Execution requires a command issued after local approval with a fixed lease of at most five minutes within that approval. No prompt/argument/source selectors are accepted. An owner may have at most 20 unfinished remote-template tasks. Capacity and exhausted-allowance receipts are durable outcomes, requiring a new reviewed intent to retry admission.

Task creation, budget consumption and encrypted receipt persistence share one SQLite transaction. Exact delivery retry returns the original receipt without another task or budget debit. A `queued` receipt includes only the opaque task ID and does not claim inference success. Receipt failure or expiry before commit rolls back all changes. The queued task carries the command deadline; claiming, heartbeat and completion enforce continuing permission, and late output cannot survive revocation. Revocation returns cancelled task IDs for the future delivery/consent adapter to interrupt inference promptly; the existing heartbeat also detects invalidated claims.

Schema 10 adds encrypted permission/receipt records and task provenance. Local export includes permission metadata and receipt history; full data deletion removes them. Restore preserves history and definitions while invalidating all permission, so queued restored remote runs cannot restart. Remote template publication, independently scoped credentials, browser review, actual delivery and native acceptance are still unfinished. No remote activation or Acer changes are included.


### Template relay repository (internal)

Migration `007-templates.sql` and `RemoteTemplateStore` add the metadata-only catalogue and durable template queue. Publication from an authenticated native device records permission/template IDs, version, approval/expiry times, run ceiling and a hash of a separately generated delivery credential. It accepts no label, prompt or result. The caller must first durably save its secret and explicit local approval; this repository does not create local permission. Exact publication retry cannot reset counters or extend expiry. Replacing a permission for the same device/template invalidates the old credential. Status and pause/cancel credentials cannot authenticate template delivery, and template credentials cannot authenticate those other scopes.

Authenticated owner submission consumes one of at most 20 approved submissions under a device transaction lock, using the exact reviewed template/version and an unchanged lease of at most five minutes. Publication must be within five minutes of local approval; clocks must agree, and future timestamps are rejected. Listing is paginated to 100 metadata items, polling to 20 commands. Development storage defaults are 1000 retained permission rows and 1000 retained commands per device, with at most 20 live pending commands; expired/history rows count until cleanup. These are configurable ceilings, not a selected hosting policy. A fixed command retry returns the original envelope without another budget debit. Expiry before commit rolls back insertion and the counter.

The native executor's receipt distinguishes queued from completion; relay inspection shows pending, expired, cancelled or the received outcome, with an opaque task ID only for queued. Stored receipts remain history after revocation. Every delivery operation rechecks owner, device epoch, lease and permission. Rotation/revocation rejects previously authenticated identities. Template cleanup uses each row's explicit retention deadline (caller-supplied 1/7/30-day option), deletes bounded commands first and only then child-free permission rows, and clears invalid credential hashes. It does not cascade an unbounded history purge or choose the unresolved hosted retention policy.

Real PostgreSQL integration connects the queue to the actual SQLite template executor, with synthetic data, and verifies scope/owner isolation, replay, concurrent budgets/capacity, publication replacement, rotation, pagination, atomic expiry rollback and bounded history-preserving cleanup. Protected HTTP routing and the gated client are described below; review screens are described below; hosted deployment remains open.


### Protected template HTTPS routes

The unstarted remote app factory now exposes POST browser routes `/browser/templates` (device catalogue with cursor), `/browser/templates/run` (confirmed fixed intent), `/browser/templates/receipt`, and `/browser/templates/revoke` (confirmed). They use the verified wallet session, exact Origin/request header and displayed-account binding already required by other owner routes. No caller-supplied owner can select authority.

Native POST routes `/device/templates/publish` and `/device/templates/revoke` use the paired device's status credential to publish explicitly confirmed metadata or withdraw only that device's permission. Publication is not local permission: the Mac must separately persist its reviewed template approval and scoped secret before this step. `/device/templates/poll` and `/device/templates/receipt` accept only the independent template credential. Native routes reject browser cookies/Origin metadata; template credentials cannot publish status, rotate status credentials or poll pause/cancel commands. A device cannot publish over or revoke another device's permission, including within the same account. Owner-browser revocation can manage its own devices.

All routes inherit direct TLS/exact Host, bounded JSON, no-store, fixed errors and request-rate enforcement. `templateQuotas` optionally sets the relay's three stored/pending limits; default ceilings remain unchanged. A certificate-verified local HTTPS integration with actual signed-wallet sessions and PostgreSQL exercises publication through SQLite execution and durable receipt inspection, mismatched scopes/accounts/devices, confirmation/content-field rejection, capacity, revocation and key rotation. Its larger fixture request/device limits accommodate the combined test set; the separate two-request rate-limit test remains in place. There is still no hosted listener or applied production migration; native client and review controls are described below.


### Mac template permission and delivery client

The existing off-by-default remote launcher now supplies a template executor alongside pause/cancel execution. Explicit sharing selects an owner-loaded template ID/version, run ceiling and expiry bounded by the paired device lease. The client creates independent random permission/credential values, records exact local consent and saves/read-back-verifies a publication journal before any upload. The remote secret record is capped at 64 KiB and 20 template permissions, leaving room for bounded status/command journals. It contains opaque metadata and scoped secrets, never the template name or prompt. Sharing does not start polling.

Publication failure retains the exact journal for an explicit retry; it cannot refill budget or extend expiry. A response must match every reviewed metadata field. Missing or revoked local consent—including after restore—cannot be silently recreated. Failed template-state writes revoke local template permission and cancel dependent work before restart could use an older saved state. A connection change revokes locally before changing credentials; full task deletion clears local permission and keeps withdrawal information for explicit remote cleanup.

A delivery pass handles one selected permission and at most 20 relay commands. Before executing each command it persists that exact opaque envelope. SQLite execution/receipt deduplication and acknowledgement replay then recover an interrupted pass even if the command's relay lease has since expired, provided the separate permission is still valid. Pending delivery is processed before new polling. Identity, template/version, duplicate IDs, receipt equality and cancellation are checked; delayed responses after cancellation cannot create a task. Remote denial revokes the local permission. Revocation stops unfinished tasks locally before attempting the remote request; a failed remote response is not reported as confirmed revocation.

Authenticated local routes under `/v1/remote/templates/` provide confirmed `share`, `retry`, `revoke` and `check` actions while pausing/draining the existing control receiver. They remain behind `BITTREES_REMOTE_STATUS=1`, which the installed native app does not enable. Unit/fault/local-HTTP tests plus actual client→verified HTTPS→PostgreSQL→SQLite integration cover restart, uncertain publication/receipt writes, expiry recovery, stale consent, cancellation, ownership and connection lifecycle. Test secret storage is in memory: actual Keychain and native acceptance remain open. Template receiving has its own per-permission opt-in, described below; the existing control switch covers pause/cancel only.


### Template review screens

The Mac Templates screen can explicitly check the remote connection, review a saved version and choose a request ceiling and permission duration. A separate unchecked confirmation binds the displayed prompt/model, device/account, version and fixed limits. The share request must include `expectedConnection` (reviewed owner ID, device ID and credential epoch); the client checks all three against the current saved pairing before creating local permission or uploading metadata. A re-pair or rotation requires a fresh review. These fields constrain the existing connection and cannot select another owner. Older development clients without this binding are rejected. Editing, changing selection or limits, refreshing and focus loss clear the review. The screen shows permission state, publication retry, local-first revocation and a confirmed manual delivery pass. Sharing does not enable background receiving. Connection checking is read-only; the feature remains unavailable when the remote launcher gate is off.

The remote page lists approved metadata by selected device with pagination. It cannot edit or view the prompt. A run review fixes the command ID, template version and deadline; retry after an uncertain response reuses that same intent. Revocation has a separate review. Receipt inspection distinguishes pending delivery from a queued local task and from actual completion. Focus loss and wallet changes clear template reviews/results, and delayed responses cannot reopen them. After a lost response, inspect existing task/receipt history before intentionally creating another request.

Controller tests cover separate confirmations, metadata-only requests, limits, edit/focus invalidation, fixed-intent retry, pagination, revocation and late responses. The actual browser controller/transport also runs through certificate-verified HTTPS, signed-wallet sessions, PostgreSQL and local SQLite execution/receipt inspection. These checks do not establish native visual/keyboard or Keychain acceptance. Installed application, hosting and Acer news inference are unchanged.


### Background template receiving

Each template permission has its own explicit background-receiving review and saved preference. Sharing permission leaves it off. While the companion process runs, the template receiver checks only enabled, currently valid permissions, one bounded delivery pass per tick in round-robin order. The ordinary interval is ten seconds; transient failures back off to sixty seconds and client contention retries without overlapping delivery. No OS wake, launch-at-login or sleep-time execution is promised. Requests can expire before delivery while the Mac is asleep, offline or busy.

The preference resumes on process restart only with the same live local permission. Expiry, restore-invalidated consent, template edits or revocation cannot silently reacquire authority. Preference write/read-back failure revokes local template permission before an older stored opt-in could resume. The authenticated confirmed local `/v1/remote/templates/receiving` route configures one permission. It drains both delivery receivers before mutation; connection rotation, deletion, revocation and manual delivery do the same. Shutdown drains both receivers.

Stopping background receiving stops new delivery for that permission and preserves existing tasks. Revoking permission cancels unfinished dependent tasks. The Templates screen shows the saved preference and receiver state/last/next check on explicit connection refresh. A receiver needing attention requires review; automatic retry is reserved for unavailable/busy responses. The existing off-by-default launcher gate remains unchanged; no hosted service or installed app has been activated by this implementation. Tests cover opt-in, restart preference, round-robin selection, revocation/expiry, abort-and-drain, backoff, failed saves, authenticated configuration and actual receiver/client HTTPS/PostgreSQL/SQLite delivery. Native sleep/wake/Keychain/visual acceptance remains open.

### Older Inbox conversations

The personal Inbox now offers **Load earlier conversations** and **Refresh conversations**. Each page contains at most 100 conversations ordered by latest local message insertion. Paging uses a fixed insertion snapshot, so new messages or replies do not move unseen conversations out of later pages. Refresh starts a new view that includes them. Message loading within a conversation is unchanged.

`GET /v1/inboxes/:id/conversations` returns `items` and an opaque `nextCursor` (null at the end); pass it as `?cursor=...` for the next page. Cursors are encrypted and authenticated to the local owner, tenant and inbox. They do not confer access. Invalid or cross-scope cursors are rejected. The client suppresses stale responses after inbox changes or unmount and allows explicit retry of a failed earlier page.

SQLite schema twelve adds a monotonic message-position table with cascading deletion. Migration assigns positions to existing messages in insertion order, including timestamp ties. Positions are not reused after deletion, so old cursors cannot include replacement data. Backups include positions and their sequence; a compatible pre-upgrade backup is needed for rollback to an older binary. Tests cover 205 conversations with intervening new messages, scope/tamper denial, deletion/replacement, migration/reopen and the actual controller over authenticated HTTP. Native visual/keyboard acceptance remains open.

Message polling and **Load later messages** now share one controller and cursor. Switching conversations or leaving Inbox invalidates outstanding responses and errors, so a late page cannot appear in another conversation. Polling and manual loading cannot overlap. Locally saved messages merge in sequence order without advancing past unloaded history; receipt merges preserve already recorded kinds. Reply check-ins continue refreshing while more message pages await manual loading. This does not add a general cross-client receipt-change feed; native interaction acceptance remains open.

Local JSON export checks both task and memory databases for changes across asynchronous access validation and payload assembly. If either changes, the endpoint returns HTTP 409 `CONFLICT` without an export payload; wait for the operation to finish and retry. This includes deletion, edits, newly queued work and writes from another SQLite connection. The check is deliberately conservative: unrelated writes or rolled-back local writes can also require a retry. It never keeps a database transaction open across asynchronous access checks. JSON export remains distinct from encrypted backup/restore.

The dashboard's shared local transport retains its 15-second deadline across both response headers and body parsing. It distinguishes a timeout, an unreachable local service and an unreadable response, with recovery messages that preserve uncertainty about submitted actions. It does not retry writes automatically or clear drafts on these connection failures. Existing pairing errors, application conflict codes, credentials and idempotency headers remain intact. Tests use a loopback server that stalls before headers or during its JSON body, then recovers for an explicit fresh request. Native interaction acceptance remains open.

### Memory backup and recovery boundary

`encryptedMemoryBackup` / `restoreMemoryBackup` in `modules/storage/backup.ts` handle the separate memory database using an authenticated version-two memory envelope. Task snapshots keep their existing version-one format. Restore checks the declared database kind before opening it, validates the memory storage key/schema privately, closes/syncs it, and publishes into a new path without overwriting a destination or its SQLite sidecars. Task backups cannot be passed to memory restore or vice versa.

Memory text, review state, pinning, source references and feedback survive; restoration does not grant source access. The application must still supply its current source validator when reopening memory. Prior deletions can remain in older backups; backup retention/deletion is separate from deleting current content. The backup contains no storage key or connector credential.

These module APIs underpin the coordinated backup download described below; restoration uses the offline recovered-copy command described below. A task snapshot alone does not include memory. The two individual snapshot calls are not a coordinated pair; use the coordinated content-bundle API below when capturing both stores, and verify key recovery separately. Do not treat JSON export as an importable backup. Older installed builds do not include the backup-download control. Full native backup/restore and installation/rollback acceptance remain open.

### Coordinated task-and-memory recovery bundle

`createContentBackup` in `modules/storage/content-backup.ts` captures both encrypted snapshots, comparing each connection's change token across capture. A write to either store rejects the attempt with `CONFLICT` and publishes no destination; retry is explicit. A successful attempt authenticates the pair together and atomically publishes one new file without overwriting an existing backup. This avoids silently mixing two independently selected snapshots. Later edits/deletions do not alter older backups. The existing per-store 32 MiB snapshot bound remains, with a 128 MiB encrypted bundle bound.

`restoreContentBackup` accepts the original storage key and a parent directory. It allocates a new private recovery directory, uses the validated task and memory restore paths, and returns its path only when both stores and `RECOVERY.json` are ready. Ordinary failures remove the incomplete directory. A process crash can leave a private partial recovery directory; do not use one without a completion manifest and verification. Existing application data is never replaced by this API. Task control/template consent is cleared; memory access still uses current source checks, including after source deletion. This does not guarantee directory-entry power-loss durability.

The bundle covers task/history/profile/Inbox/template data and memory. It excludes the storage key, connector credentials, model files and model-import jobs. Those remain separate recovery concerns. The Device backup-download action uses this backend; there is no native restore or automatic installation/rollback flow; full native and credential recovery acceptance remains open.

### Device backup download

The Device screen now offers an explicit confirmed encrypted-backup download. The local startup wires both stores and the storage vault to `POST /v1/backup`; the storage key is never returned. The paired same-origin session remains required, the request accepts only `{confirmed:true}`, and the response is an attachment with no-store headers. No destination path can be supplied through the endpoint. Temporary server files are removed before return; only one capture runs at a time. Concurrent-data conflicts require explicit retry.

The client enforces a two-minute request/body deadline and 128 MiB response bound, with no automatic retry. A session cleared during capture cannot start a late download. The blob URL remains available for the native save sheet and is released on another backup, session clear or unmount. UI copy explains that the original storage key is required, loss of that key is not recoverable through the file, connections/models are separate, and the Mac app menu provides restore controls. This is a paired personal-device backup, not a remotely exposed export.

Authenticated HTTP/client tests restore both stores from the actual downloaded bytes and verify denied origin/session/unconfirmed/path requests, concurrent capture denial, logout revocation, invalid/oversized/error responses and body-timeout handling. Native visual/keyboard/save-dialog acceptance is still open, and the previously installed app has not been replaced.

### Offline recovered-copy command

After building with Node 24, run `npm run recover -- --help` for usage. To restore a coordinated `.aib` backup into a new private folder under an existing parent, use `npm run recover -- --backup /path/to/content.aib --destination-parent /path/to/recovery-parent --confirm`. Quit Bittrees AI first: the command holds the companion's loopback port for the operation and refuses to proceed if that port is occupied. It never terminates an application.

Recovery reads the existing `personal` storage key from macOS Keychain with key creation disabled. Missing, locked or invalid entries stop recovery; a new key cannot decrypt the old backup. No key is accepted on the command line, logged, returned or written to the backup. Error output uses fixed descriptions instead of raw Keychain/provider errors.

The result is a **separate recovered copy**, with `activated:false` and a `RECOVERY.json` manifest. Current task and memory files are never replaced, including data newer than the backup. Task remote-control consent stays cleared, and current source authorization still gates restored memory. The command releases its port on success or failure. It is not a restore button, portable-key recovery or lost-Keychain recovery solution. Native interaction remains open. Separate source-build activation and rollback commands are described below.

Synthetic tests cover successful copy recovery without altering newer source data, absent/invalid/locked/wrong keys without key writes, strict confirmation/arguments, occupied-port rejection before key reads and port release after failure. The actual CLI help path is exercised without reading a personal Keychain entry.


### Offline backup activation (source build)

After building this revision, `npm run activate -- --backup /path/to/content.aib --confirm` restores and activates a coordinated backup for this source build. Quit the companion first and keep a current coordinated backup before switching. The command uses only the existing personal Keychain key and holds the same exclusive loopback port as startup and copy recovery. No process is stopped. **Older installed development apps ignore the new selection file.** Use `npm start` from this revision after activation; native app upgrade/acceptance is still outstanding.

Both databases are restored and validated into a new private `stores/bittrees-ai-recovered-*` folder. Only then does an atomic rename publish a small, synced `active-content.json` selection. Startup resolves it after acquiring the port; malformed, oversized, symlinked or missing-store selections fail closed. Task/memory paths follow the selection; pairing, device model imports and Keychain connections retain their stable locations. Every earlier content folder is retained, and the selection records the immediately previous folder (null means the original base folder). Restored remote-control/template consent is cleared and current source checks remain required.

A failed restore leaves the previous selection unchanged. Ordinary pre-publication failure removes the incomplete copy; a process crash can leave an unused private folder. Atomic file replacement does not establish power-loss durability of every directory entry. This is a source-build activation step, not lost-key recovery or native acceptance. Do not manually switch to an old folder: that can restore stale control consent. The rollback command below restores a fresh copy and clears that consent again. Activating another coordinated backup is supported; no prior data is deleted automatically.

Synthetic tests verify selection on subsequent resolution, preservation of newer original data and prior activated copies, cleared control consent, wrong/missing-key failure without selection changes, unchanged pairing/import files, strict confirmation and occupied-port rejection before key access. No personal application data or Keychain entry is used by those tests.


### Offline content rollback (source build)

`npm run activate -- --previous --confirm` restores a **fresh copy of the immediately previous content selection**, including its task and memory databases, then selects that copy. It requires the companion to be stopped and the original Keychain key. No-history, missing-store, wrong-key and failed-restore cases leave the current selection unchanged. It is a content rollback, not an application-version downgrade. Older installed builds still ignore the selection file.

The previous databases are opened read-only, captured through SQLite backup with concurrent-commit detection, encrypted together in a private temporary bundle, and restored through the same key/schema validation and consent clearing as imported backups. Original folders and the current folder remain intact. Current source authorization still controls restored memory. The operation neither revives old remote-control/template consent nor replaces connections, model files or import jobs. Temporary capture files are removed on ordinary completion/failure; crash-left private files remain a documented recovery/cleanup concern.

The immediately preceding selection becomes the next rollback target. Repeating the command therefore switches between fresh copies of the latest two selections; it does not traverse the entire retained history. Native restore/rollback interaction acceptance, real installation acceptance and portable key recovery remain open. Retained-copy controls are described below. No retained content is automatically deleted. Tests exercise original-folder rollback, subsequent selected-folder rollback, preservation of newer data, restored memory/source revocation, consent clearing, invalid inputs and failure isolation using synthetic stores and keys only.


### Mac recovery menus

The native source build now includes **Restore from backup…** and **Restore previous copy…** in the Bittrees AI app menu. A native file picker and confirmation explain the original-Keychain requirement, retained current copy, separate models/connections, cleared remote permissions and required re-pairing. Cancel leaves the engine running. Confirm disables repeated actions, discards the old web view/session, requests graceful shutdown of only this shell's engine, and waits for that process to exit before invoking the bundled activation command with literal arguments and a restricted environment. It never stops Ollama or any unrelated app.

The offline command holds the same loopback port and performs the validated activation/rollback described above. The shell restarts its engine after command completion, creates a fresh pairing session and displays a fixed success/failure message rather than command output. A competing companion can make recovery/startup refuse the port. Quit while waiting for engine shutdown skips recovery; Quit during recovery waits for completion without killing the recovery child or restarting. Recovery actions are available only while this shell's engine is ready. An invalid current selection that prevents startup still requires offline diagnosis; these menus do not bypass it.

`bash scripts/check-macos-recovery.sh` compiles and executes the shared lifecycle checks and typechecks the native shell. Mac CI runs it before building/signature-verifying the package. Tests cover shutdown-before-recovery ordering, duplicate/stale callbacks, argument preservation, and Quit before/during recovery. The TypeScript suites cover the actual synthetic database recovery operations. Native visual/keyboard/file-dialog/Keychain interaction and real app replacement remain unverified; source controls are not present in the older installed app until an upgrade is accepted. No test invokes personal recovery or changes Acer news processing.


### Retained recovery copies

Device → Retained recovery copies lists managed task/memory copies in pages of 50, with size, last-change time and active/previous protection. Nothing is removed automatically. Deleting an older copy requires an explicit confirmation and a matching review of its file identities, sizes and modification/change times. The active dataset and immediately previous rollback dataset cannot be deleted here. Individual current-data deletion remains in the existing task/memory controls.

Only the paired local session can use `GET /v1/recovery-copies` or `POST /v1/recovery-copies/delete`. The latter accepts a managed identifier, review digest and `confirmed:true`; it accepts no filesystem path. The service is wired only into the port-owning engine, serializes list/delete work, checks its active selection again before removal, and rejects unexpected files or symlinks. A stale review or changed selection requires refresh. Listing exposes no full paths, task/memory content or keys.

An older generated recovery folder is removed as a unit. When original base-folder content is neither active nor the rollback target, deletion removes only the two known databases and their SQLite sidecars; pairing, model-import files, credentials and independently saved backups stay in place. Files outside these managed copies, including crash-left temporary staging folders and backups downloaded elsewhere, are separate. Interrupted filesystem deletion can be partial; refresh and review the remaining copy before retrying. These are ordinary filesystem deletions, not content operations on the active databases.

Tests cover retained original/generated removal, active/rollback denial, stale-review and changed-selection rejection, 106-copy pagination, symlink/path/unknown-file denial, preservation of pairing/imports/external backup and actual paired HTTP protection including logout. Native visual/keyboard acceptance of these controls remains open; the previously installed app and prepared PR98 archive do not yet contain them.

### User-held recovery-kit foundation

The [local key-recovery design and evidence](docs/user-held-recovery-kit.md) now documents a bounded, versioned encrypted kit plus a separately generated recovery code. Internal preparation requires an existing storage key; internal recovery can restore a coordinated backup into a separate copy without Keychain access or modification. Kit creation and recovery are available only through the default-off native previews described below. Tests cover integrity, wrong/mismatched keys, both-direction WebCrypto interoperability and actual synthetic task+memory recovery. Native setup/recovery acceptance, rotation and independent crypto review remain open. Ordinary app/CLI restore workflows require the original Keychain key; the gated kit-recovery preview supplies the separate lost-key path.

Internal recovered-key installation now validates the backup and current store key ownership before an atomic add-only macOS Keychain operation, followed by read-back verification. Existing/conflicting credentials are never replaced. Uncertain writes retain the recovered copy and require explicit reconciliation. Real disposable-credential tests verify native duplicate preservation and compatibility with the current keyring addon. The default-off native preview connects this foundation to recovery; native access-prompt acceptance, signed delivery and independent review remain open. See the recovery-kit design for exact scope and outcomes.


### Mac recovery-kit setup preview

Source-built Mac shells launched with `BITTREES_RECOVERY_PREVIEW=1` offer **Set up recovery kit (preview)…**; the default menu keeps it hidden. After explicit confirmation, the native shell reads the existing key through a private bundled worker, displays a separate recovery code, requires re-entry of the saved code, and saves only the encrypted kit to a new file. The code can be copied explicitly to the system clipboard. Setup expires after ten minutes; three incorrect entries cancel it. Existing keys, data and destination files are not replaced.

The private response is bounded and strictly checked, and neither code nor storage key enters the dashboard or logs. Clipboard and runtime copies are not guaranteed to be erased. Keep the code separately, along with the kit and a current encrypted content backup. Kit creation does not revoke older kits. See the [design and test limits](docs/user-held-recovery-kit.md#native-setup-preview-default-off). This is a development preview pending independent review and native acceptance, not an installed-app update. The Acer-server model and news briefings remain unchanged; the companion and model comparisons run separately on the Mac.


### Mac recovery with a saved kit

The same default-off recovery preview now offers **Recover with kit (preview)…** before startup and from the app menu. Choose your encrypted content backup and kit, enter the separately saved code, then confirm. Recover before starting a fresh device so ordinary startup does not create an unrelated key. The shell stops only its own engine, verifies the backup/current data, installs only a missing matching key and selects a recovered copy only after successful key read-back. Earlier data is retained; remote permissions must be approved again.

Successful recovery offers **Open companion**. Conflicts, unconfirmed writes and selection failures show specific outcomes and require review or explicit retry; the engine does not restart automatically. Quit during recovery waits for the operation to finish. The code uses private native pipes and never enters the dashboard, arguments or logs. Details, retained-copy behavior and remaining limits are in the [recovery design](docs/user-held-recovery-kit.md#native-kit-recovery-preview-default-off). Native personal-device acceptance and independent review remain open. Installed builds, model defaults and Acer news processing are unchanged.


Mac packaging CI now runs the bundled recovery path against a disposable Keychain profile. This caught a native byte-array/type mismatch that rejected a matching recovery key; the storage adapter now normalizes the actual native return value before verification. The check includes synthetic task/memory recovery, retained-copy protection and cleanup. It does not replace personal-device dialog or Keychain access-prompt acceptance.


### Updated Mac model comparison

A [32-draft comparison of original and Huihui 9B](docs/mail-model-comparison-2026-09-22.md) found valid structure in every case but different semantic reliability. The original followed reply intent in all eight unique cases; Huihui did so in six. A candidate summary prompt improved several cases while introducing an omission, so it remains experimental. Raw synthetic outputs, criteria, exact model digests, timings and reported memory residency are retained. Original 9B remains the preferred candidate for further reviewed use; saved defaults, production prompts and model weights are unchanged. This is not broad or independent quality acceptance.

Mail draft review now offers [current-permission original source passages](docs/mail-source-review.md) beside cited claims, including original attachment parts. A [second summary-preservation experiment](docs/mail-summary-preservation-2026-09-22.md) is retained as negative evidence: the candidate still repeated payload markers and invented chronology, so it was not promoted. Native interaction and independent quality acceptance remain open.

An internal [private remote-envelope foundation](docs/private-remote-envelopes.md) uses a pinned HPKE library with authenticated routing/epochs and bounded payloads. It has no live endpoints, relay storage or task dispatch. Durable replay handling, endpoint enrollment/recovery, browser/native acceptance and independent review remain prerequisites for R2; remote status mode still excludes private content.

The [local private-peer enrollment backend](docs/private-peer-enrollment.md) adds explicit full-fingerprint review, encrypted public-key pins, replacement/revocation history and current-binding lookup. Task schema13 locks restored/deleted trust until fresh device pairing; local export includes peer metadata. Actual invitation exchange/UI and endpoint private keys/recovery remain open. Older engines require their original compatible backup for rollback; the installed app is unchanged.

The [private task-admission backend](docs/private-task-admission.md) connects authenticated envelopes to the existing local queue under separate per-peer consent. Schema14 atomically stores a task and encrypted receipt; identical retries return the same receipt, conflicting message/operation/sequence reuse fails, and supported restore locks admission. Authenticated local export/deletion includes receipts. No network route, startup integration or installed-app change is enabled; durable sending, real consent/UI and independent review remain open.
