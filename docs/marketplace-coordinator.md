# Mercado and CRM coordinator pilot

> Automatic execution is now available as a separate opt-in capability. See [Mercado supplier workflow](marketplace-qualified-workflow.md). Proposal-only grants described below retain their original limits.

AI owns durable runs and retries. MCP Connect owns account-bound source routing. Mercado owns product proposals and catalog review. CRM owns research assignments, organizations, contacts, follow-up tasks and import approval.

## Implemented

Authenticated same-origin browser endpoints: `POST /browser/marketplace/create`, `/status`, `/advance`. Existing AI sessions, account binding and CSRF checks apply. Create accepts `{id, crm:{candidates}, mercado:[{product}]}`; status and advance accept `{id}`. Supply a new run UUID once and retain it on retries. Maximum 20 CRM candidates and 20 product proposals; total input 55KB. Data must be permitted public research, never private customer or deal exports.

The coordinator persists immutable input and independent operation IDs before sending through MCP. Each advance handles one source, in rotation. It reconciles status before preview, retaining IDs after uncertain responses. A 90-second lease excludes overlapping advances. CRM and Mercado remain independent: review outcomes are recorded separately. `decided` means the source review concluded, not that a Mercado listing was published. `changes_requested` is a review outcome; revised evidence requires a new run. No automatic payment, outreach, vendor approval or catalog publication is included.

## Activation order

1. Deploy CRM task-scope/status changes and Mercado proposal-only endpoints.
2. Apply `modules/remote/migrations/marketplace-coordinator.sql` to AI's remote database explicitly.
3. In CRM, a workspace owner creates a fresh research assignment, opts into follow-up tasks and issues its scoped token. Each assignment permits one immutable batch and expires after seven days. Each subsequent batch needs a fresh assignment/token.
4. In Mercado, an operator installs an expiring proposal-only grant in `MERCADO_COORDINATOR_GRANTS_JSON`: `{tokenHash, identity, expiresAt, collections}`. Use a dedicated `coordinator:<id>` identity, SHA-256 of a random 32-byte hex token, millisecond expiry, and exact permitted collection IDs. Removing a grant revokes it. This is a separate service authority, not inherited governance membership.
5. MCP's `MCP_SOURCE_CONNECTIONS_JSON` contains `{tenant,subject,actorTokenHash,source,token,expiresAt}` per source (`crm`, `mercado`). It must match the MCP service credential's actor and token hash. That credential requires `catalog:read`, `sources:propose` and both project IDs. Keep source tokens only in server secret configuration.
6. AI's `AI_MARKETPLACE_CONNECTIONS_JSON` contains `{ownerId,token,expiresAt}` where token is the MCP service bearer. Use the actual authenticated AI owner ID, not an email/ENS alias. Tokens must not be placed in workflow input.
7. Submit one synthetic reviewed batch before enabling a scheduler. Run `node dist/scripts/marketplace-worker.js` from AI's service scheduler; it processes at most 20 runs per pass. No schedule is installed by this change. The existing Codex weekly checks remain active.

Credentials are operator-provisioned for this pilot; a self-service connection screen, workflow dashboard, automated research ingestion and recurring assignment renewal remain future work. Neither deployment nor live access is implied by passing local tests. Remove AI/MCP connection configuration to pause dispatch; revoke source grants to deny writes. Existing proposals remain available for source-app review.

## Validation

From the AI checkout, run `COORDINATOR_TEST_DATABASE_URL=postgres://<local-user>@127.0.0.1:<port>/coordinator_e2e node --import tsx scripts/marketplace-e2e.ts` against a disposable local database. Sibling checkouts are currently expected as `workflow-crm`, `workflow-mcp`, `workflow-marcada`.

The test uses real PostgreSQL schemas, the real MCP HTTP handler and source business handlers behind a local HTTP fixture. It creates an organization, contact and linked task through CRM approval, stages a Mercado product, tests a lost response, coordinator restart, duplicate operations and denied authority. Mercado's staff review status transition is simulated in SQL; the browser UI and production deployment are not covered. This is a backend integration test, not a production end-to-end certification.

## Local Mac execution and Neon status sync

The selected deployment keeps execution on the Mac. `scripts/marketplace-local.ts` stores encrypted run inputs, receipts and pending sync revisions in a separate SQLite database under `~/Library/Application Support/Bittrees AI/marketplace`. It uses the existing Vault encryption and a dedicated Keychain storage key. This does not migrate the installed companion's database or change its local model/runtime.

The hosted Vercel function `/api/workflow-status` accepts only run UUID, monotonic revision and counts by source/state. It stores these in a dedicated Neon database using `marketplace-status.sql`. It accepts an expiring owner-bound service credential configured in `AI_STATUS_SYNC_GRANTS_JSON`. It rejects browser cookies, arbitrary fields, stale replacement and conflicting same-revision updates. No local prompts, contacts, product details, model files, source credentials or SQLite files are uploaded to Neon. MCP receives the explicitly submitted source proposals, as before.

Run `marketplace-local create <batch.json>`, `advance`, or `sync` through the repository TypeScript runner (or compiled scripts). Configuration is an encrypted `connection.enc` beside the SQLite file. A source outage preserves stable operation IDs; a sync outage preserves an unacknowledged local revision. Acknowledgement is recorded only after the hosted receipt matches. Mac sleep/offline periods pause execution; the next pass resumes. Cloud status is a projection, not a second writer of local decisions. There is no full database replication or hosted model fallback.

This adds an independent local coordinator runner. Automatically generating research with the installed local model and an integrated companion/dashboard UI are not provided by this change. The production sync migration replaces the need to activate the unrelated remote account/relay service for this workflow.
