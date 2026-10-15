# Local marketplace automation authority

> Automatic execution is now available as a separate opt-in capability. See [Mercado supplier workflow](marketplace-qualified-workflow.md). Proposal-only grants described below retain their original limits.

The Mac runner can process prepared batches repeatedly with a durable, owner-bound local grant. This is not a permanent browser login and does not grant publication, CRM approval, arbitrary tool execution, or outreach rights.

From the AI checkout, use the existing Keychain-protected connection:

```sh
npx tsx scripts/marketplace-local.ts grant until-revoked
npx tsx scripts/marketplace-local.ts grants
MARKETPLACE_GRANT_ID=<returned-id> npx tsx scripts/marketplace-local.ts watch
npx tsx scripts/marketplace-local.ts revoke <returned-id>
```

`create <batch.json>`, `advance`, and `sync` also require `MARKETPLACE_GRANT_ID`. Grant IDs are identifiers, not credentials. Grant management is a local operator function protected by the Mac account, private database permissions, and Keychain. It is not a remotely exposed API.

The runner re-reads authority immediately before each source request and each status-sync request. Revoking a grant prevents subsequent dispatches, including a proposal following a status request already in flight. It cannot recall a request already accepted by a server. Revocation is permanent for that grant; resuming requires an explicit new grant. Grants and revocations are recorded locally.

Watch mode processes at most five unfinished runs per pass, one step each, then waits 60 seconds. Completed runs do not block later work. It reconciles stable operation IDs before submitting, stops on HTTP authorization denial, and stops a step after five unconfirmed attempts. Network or sync failures may stop the process; there is no automatic restart service. Review failures before restarting. Publication and CRM approval remain in the source applications.

## Managed cloud grants and scheduled discovery

Managed connections now use a shared Neon authority record. Each service token has a separate audience and action scope. AI, MCP Connect, CRM and Mercado check that authority without caching permission decisions. A group control credential can inspect or permanently revoke the whole workflow; it cannot create credentials, expand scope, or restore a revoked group. Provisioning remains an operator operation. Existing finite unmanaged credentials remain supported for migration.

`marketplace-local cloud-status` reports the active group. `marketplace-local revoke-cloud` revokes every managed connection in that group immediately for subsequent checks. This command requires the Keychain-encrypted control credential; it never prints credentials. A request already accepted may finish. The local `revoke <id>` command only stops the specified local grant.

CRM standing assignments still check the assigning owner's current workspace role and the researcher's current access on every request. They permit at most five batches per day and ten awaiting review. Each batch is immutable and independently reviewed. MCP rechecks CRM membership before either source dispatch. Unknown scope, revoked access, missing database, and authority-service outages deny execution.

Discovery supports approved Shopify feeds from Server Depot US, Bitcoin Merch and Vilros (US), Mercado Minero and NOXAR (Mexico), plus The Pi Hut and Pimoroni (UK), Miners.de (Germany), and WooCommerce Store API feeds from DTV Electronics (UK) and bitshopper (Germany). Scope includes Bitcoin miners, local AI devices and NVIDIA GPUs, and complete server systems. It validates currency, title scope, stock and price against the individual product feed, produces up to twenty product proposals in two CRM batches per discovery pass, and records source URLs and retrieval dates. It never executes vendor page instructions, infers email addresses, or sends outreach. New supplier adapters require operator review. This is deterministic catalog research; it does not call a cloud model or change the installed local model.

`marketplace-local cycle` performs discovery when six hours have elapsed, advances pending proposals, and syncs minimal status. A Mac LaunchAgent may run this command every five minutes; sleep/offline delays execution. Unconfirmed source actions retain operation IDs and stop after five attempts. Review queues remain the approval boundary. Cloud status sync contains counts, not research or CRM records.

Each cycle advances at most five runs in oldest-update order, keeping reconciliation within source rate limits while rotating through larger queues. CRM actions perform their own membership check; Mercado dispatches additionally revalidate the CRM authority anchor.

## Regional discovery and review

A persistent vendor cursor rotates the next pass, selecting at most three qualifying offerings per vendor. Each vendor scan is bounded to four public catalog pages; this does not promise exhaustive coverage of larger catalogs. Supplier outages are skipped and logged; authority failures stop the pass. Existing Mercado source URLs and previously researched URLs are skipped. Separate vendors selling the same model remain eligible.

Shopify candidates are rechecked through the individual product JSON endpoint; WooCommerce candidates must be simple, purchasable, in-stock products with matching currency and price. Variable WooCommerce products are skipped pending a variation adapter. Accessories and altcoin miners are excluded from these discovery batches. Vendor location does not establish stock location, origin or delivery eligibility.

Each chosen product has a linked follow-up task in the same CRM review batch. Organizations are shared within a batch so several products from a vendor do not create duplicate organization candidates. Each batch contains at most ten products and twenty CRM candidates. Tasks call for confirmation of dealer terms, stock, shipping, taxes, warranty and delivery to Nevada/Portugal. Mercado receives each product in its own review proposal. These are proposals, not automatically published listings or imported CRM records. Source approvals, outreach and purchases remain outside the grant.

The capacity per discovery pass is 20 products, split into at most two batches of ten. Product and vendor caps are exported constants in the research module. Discovery defers when more than eight local runs remain unresolved, reserving capacity within CRM's ten-pending-preview limit. CRM's server-side daily and pending limits remain authoritative. The five-minute runner advances five runs per cycle rather than sending all product proposals in a burst.

Vendor contact pages are fetched anew during discovery. A configured public business email is included only if present in that retrieved page; otherwise the organization has no email and contact verification remains a follow-up task. Contact evidence is bounded and sourced separately from product evidence. Generic sales/support addresses do not create invented people.

The existing Wednesday 09:00 Europe/Lisbon vendor-discovery automation researches two to five additional suppliers where qualified sources are available. It maintains the approved manifest and scoped domains, tests relevant adapters, and verifies MCP proposal receipts. It does not run a second product scheduler or grant itself publication/import authority. This discovery task requires the Codex app; the product runner requires the Mac to be awake and logged in.
