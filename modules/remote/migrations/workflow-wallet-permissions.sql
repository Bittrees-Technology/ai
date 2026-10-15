-- Wallet approval is separate from login and from source-app permissions.
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS wallet_address text;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT 'Unregistered device';
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS model_label text NOT NULL DEFAULT 'Rule-based supplier validation (no model)';
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS require_wallet boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS signed_scopes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS approval_message text;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS approval_signature text;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS pair_hash text UNIQUE;
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS pair_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS workflow_authorities_wallet ON workflow_authorities(wallet_address);
CREATE TABLE IF NOT EXISTS workflow_wallet_challenges (
 id uuid PRIMARY KEY, browser_hash text NOT NULL, wallet text NOT NULL,
 message text NOT NULL, payload jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_wallet_sessions (
 token_hash text PRIMARY KEY, wallet text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_portal_limits (
 key text PRIMARY KEY, window_at timestamptz NOT NULL DEFAULT now(), hits int NOT NULL DEFAULT 1);

ALTER TABLE marketplace_status ADD COLUMN IF NOT EXISTS outcomes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workflow_authorities ADD COLUMN IF NOT EXISTS approval_payload jsonb;
