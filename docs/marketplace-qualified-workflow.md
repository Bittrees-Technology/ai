# Mercado supplier workflow

AI coordinates this workflow on the Mac through MCP Connect. Discovery runs every six hours, with up to 20 product offers per run and at most three per approved supplier. This permits up to 80 offers per day when enough new qualifying offers are available; it is a ceiling, not a publication target. The five-minute runner resumes durable work after sleep, offline periods or restarts. ai.bittrees.org holds revocable authority and minimal progress; it does not host the local model or publish through a browser session.

1. Research approved US, Mexican and western European suppliers within Bitcoin mining, local AI/GPU and server scope.
2. Prepare immutable Mercado proposals and CRM vendor/task batches with stable operation IDs and source evidence.
3. Mercado independently re-fetches the individual supplier product and currency. `mercado-qualified-v1` requires matching title, price, scope, one in-stock variant, an approved official image and an unambiguous mining hash rate. It adds source pricing, verification date and quote-dependent delivery disclosures.
4. Mercado publishes qualifying products and marks their proposals reviewed in one database statement. Preorders, shipping restrictions, blade compatibility, refurbished condition, absent warranty, ambiguous variants, missing evidence and existing catalog matches remain held. Unknown adapters, including WooCommerce variation handling, remain manual. This conservative first policy is narrower than a human review.
5. CRM independently rechecks its assignment owner, membership, primary evidence and public vendor email. It imports organizations and linked follow-up tasks in the assigned workspace. A single active vendor with the exact domain is reused without changing its data or audience. Ambiguous/restricted matches stay held; existing tasks are not duplicated. Missing emails are left blank. This workflow does not create inferred people, send outreach, buy stock or change private deals.
6. AI retains each source receipt, including hold reason and product ID. It reconciles before retrying, uses the same operation ID after lost responses, and never turns a manual review outcome into another automatic publication attempt. Held CRM batches require source-app review. The existing backlog limit pauses discovery when too many reviews remain unresolved.

## Activation and revocation

All of the following must be explicitly provisioned. Existing proposal-only grants remain insufficient:

- MCP actor: `sources:execute`, plus cloud credential scope of the same name.
- Mercado source credential: `publish:qualified`; configured grant `automaticPolicy: mercado-qualified-v1`.
- CRM source credential: `import:qualified`; exact assignment UUID in `CRM_MARKETPLACE_EXECUTION_ASSIGNMENTS`.
- Encrypted Mac connection: `automatic: true`; a new local grant created with `marketplace-local grant automatic-until-revoked`. Point the existing runner at that grant; no second scheduler is needed.

Revoke the local grant to stop this Mac, or use the existing `revoke-cloud` control to stop all managed connections. Sources recheck cloud authority immediately before writes. An already accepted request may finish; revoked credentials cannot start later actions. Source execution grants do not permit arbitrary writes, updates to existing products, credential management, outreach or purchases.

No new database schema is required. Existing proposal, catalog, CRM audit and authority tables store outcomes. Deploy the three source/connection services before enabling automatic mode locally. Review the source-held queues in Mercado and CRM; do not claim a reviewed proposal was published without its publication receipt.

## Verification

`scripts/marketplace-e2e.ts` exercises the actual AI → MCP HTTP → source handlers with disposable local PostgreSQL and deterministic supplier fixtures. It checks publishing, holds, linked CRM import, repeated vendor/task deduplication, lost responses, restart, proposal-only denial and revocation. Production activation needs a separate real-source run and receipt verification; synthetic products must never be published live.

## Wallet approval and controls

The website and Mac app now expose **Workflows & permissions**. See [wallet approvals, device pairing and revocation](workflows-permissions.md). The Raging workflow waits for the owner’s actual signature before wallet-authorized execution resumes. Other users pair their own device and connect their own source permissions.
