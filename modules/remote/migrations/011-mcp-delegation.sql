-- Separate consent; no device or browser credential becomes an MCP credential.
-- Only opaque actor identifiers and approved-template metadata belong here.
CREATE TABLE remote_mcp_delegations (
 id uuid PRIMARY KEY,
 client_id text NOT NULL CHECK(client_id='bittrees-mcp'),
 actor jsonb NOT NULL,
 request_hash char(64) NOT NULL,
 challenge char(43) NOT NULL,
 approval_hash char(64) NOT NULL,
 request_expires_at bigint NOT NULL,
 owner_id uuid,
 permission_id uuid REFERENCES remote_templates(permission_id) ON DELETE CASCADE,
 template_revision bigint,
 max_runs integer CHECK(max_runs BETWEEN 1 AND 20),
 submitted_runs integer NOT NULL DEFAULT 0 CHECK(submitted_runs>=0),
 expires_at bigint,
 credential_hash char(64) UNIQUE,
 redeemed_at bigint,
 revoked_at bigint,
 CHECK((owner_id IS NULL)=(permission_id IS NULL)),
 CHECK((owner_id IS NULL)=(expires_at IS NULL)),
 CHECK((owner_id IS NULL)=(max_runs IS NULL)),
 CHECK((owner_id IS NULL)=(template_revision IS NULL)),
 CHECK(template_revision IS NULL OR template_revision>0),
 CHECK(max_runs IS NULL OR submitted_runs<=max_runs),
 CHECK(credential_hash IS NULL OR (owner_id IS NOT NULL AND redeemed_at IS NOT NULL))
);
CREATE INDEX remote_mcp_delegations_owner ON remote_mcp_delegations(owner_id,id);
CREATE INDEX remote_mcp_delegations_pending ON remote_mcp_delegations(request_expires_at) WHERE owner_id IS NULL;

-- Durable binding prevents both changed-command and changed-run retries from
-- adopting another grant's/browser submission or consuming another run.
CREATE TABLE remote_mcp_dispatches (
 command_id uuid PRIMARY KEY REFERENCES remote_template_commands(id) ON DELETE CASCADE,
 delegation_id uuid NOT NULL REFERENCES remote_mcp_delegations(id),
 run_id varchar(128) NOT NULL,
 automation_id varchar(128) NOT NULL,
 request_hash char(64) NOT NULL,
 accepted_at bigint NOT NULL,
 UNIQUE(delegation_id,run_id)
);
