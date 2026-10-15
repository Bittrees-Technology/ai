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

## Deployment boundary and remaining work

This change is a local control layer. Existing MCP, Mercado, and sync service credentials retain their finite expiration. An until-revoked local grant cannot renew or bypass them. It also does not invalidate a copied remote credential; revoke that credential at its source.

Before enabling indefinite **cloud** delegation, implement database-backed grants in each service with per-request revocation and current owner/workspace-role checks. Provide an authenticated control page showing scopes, expiry, last use, audit history, and revoke. Replace the CRM single-batch assignment with a standing parent authorization that issues bounded child batches. Do not simply remove static environment credential expiry.

Local-model research, recurring batch generation, cloud revocation controls, and a startup scheduler are not enabled by this change. The watch command processes prepared batches only. No existing live grant is silently converted, and no worker is started during installation.
