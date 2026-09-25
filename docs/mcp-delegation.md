# MCP template delegation, version 1

The generated [versioned contract](../contracts/mcp-delegation-v1.json) describes
validated requests shared with the MCP service. It is separate from the local
companion API. Enablement requires migration011 and an explicitly configured
`mcpClientCredentialHash` in the remote HTTP factory. Default configuration does
not mount these routes or show the connection interface.

A confidential service credential registers a pending request containing a PKCE
challenge, hashed approval code and actor identity derived by MCP from its current
authenticated credential. It grants no template authority. The verified AI owner
reviews that identity, selects an existing approved template, confirms its exact
revision and bounds the run allowance and expiry. Neither server infers identity
from matching wallet/email strings. Redemption confirms the expected AI owner and
returns a user-scoped credential once; only its hash is retained at AI.

Dispatch and receipt inspection require both the client header and the scoped
bearer, with no browser cookies or Origin. The original run ID, grant and complete
command bind idempotency. Exact replay returns the existing acceptance. Changing
the command or reusing another submission conflicts. New acceptance atomically
consumes both the parent template and delegation allowance. An accepted receipt
means AI queued the command; it does not attest inference completion or source
publication. Inspect uncertain delivery before explicitly retrying the original
request. Never invent a fresh command to recover a lost response.

Owners list grants through `/browser/mcp/grants`, revoke through
`/browser/mcp/revoke`, and remove revoked records through `/browser/mcp/forget`.
Revocation/removal requests carry `{id, confirmed:true}`. Source disconnect uses
`/mcp/delegations/disconnect` with `{id, actor}` and both credentials. Disconnect
is idempotent, including after the first reply is lost. Deleting a revoked grant
leaves already accepted template commands under their existing lifecycle.

The MCP implementation encrypts pending and active secrets separately from its
state database, binds them to tenant/subject/actor/connection/phase, and creates
new automations paused. Current authority is checked before dispatch. No new
scheduler, model-selected target, prompt replacement or write approval is
introduced. Public-only MCP remains compatible with its previous storage format
until the explicit AI migration and configuration are applied.
