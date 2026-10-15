CREATE TABLE IF NOT EXISTS workflow_authorities (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, control_hash text UNIQUE NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workflow_credentials (
 token_hash text PRIMARY KEY, authority_id uuid NOT NULL REFERENCES workflow_authorities(id),
 audience text NOT NULL, scopes jsonb NOT NULL, expires_at timestamptz,
 last_used_at timestamptz);
CREATE TABLE IF NOT EXISTS workflow_authority_audit (
 id bigserial PRIMARY KEY, authority_id uuid NOT NULL REFERENCES workflow_authorities(id),
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
