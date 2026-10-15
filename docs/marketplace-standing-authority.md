# Local marketplace automation authority

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

Watch mode processes at most 20 unfinished runs per pass, one step each, then waits 60 seconds. Completed runs do not block later work. It reconciles stable operation IDs before submitting, stops on HTTP authorization denial, and stops a step after five unconfirmed attempts. Network or sync failures may stop the process; there is no automatic restart service. Review failures before restarting. Publication and CRM approval remain in the source applications.

## Managed cloud grants and scheduled discovery

Managed connections now use a shared Neon authority record. Each service token has a separate audience and action scope. AI, MCP Connect, CRM and Mercado check that authority without caching permission decisions. A group control credential can inspect or permanently revoke the whole workflow; it cannot create credentials, expand scope, or restore a revoked group. Provisioning remains an operator operation. Existing finite unmanaged credentials remain supported for migration.

`marketplace-local cloud-status` reports the active group. `marketplace-local revoke-cloud` revokes every managed connection in that group immediately for subsequent checks. This command requires the Keychain-encrypted control credential; it never prints credentials. A request already accepted may finish. The local `revoke <id>` command only stops the specified local grant.

CRM standing assignments still check the assigning owner's current workspace role and the researcher's current access on every request. They permit at most five batches per day and ten awaiting review. Each batch is immutable and independently reviewed. MCP rechecks CRM membership before either source dispatch. Unknown scope, revoked access, missing database, and authority-service outages deny execution.

Discovery initially supports the approved Vilros public catalog feed for local AI hardware. It validates currency, title scope, stock and price against the individual product feed, produces at most three proposals per pass, and records source URLs and retrieval dates. It never executes vendor page instructions, infers email addresses, or sends outreach. New supplier adapters require operator review. This is deterministic catalog research; it does not call a cloud model or change the installed local model.

`marketplace-local cycle` performs discovery when seven days have elapsed, advances pending proposals, and syncs minimal status. A Mac LaunchAgent may run this command every five minutes; sleep/offline delays execution. Unconfirmed source actions retain operation IDs and stop after five attempts. Review queues remain the approval boundary. Cloud status sync contains counts, not research or CRM records.
