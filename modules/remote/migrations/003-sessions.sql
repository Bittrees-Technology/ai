-- Independent companion accounts; no source application roles or permissions.
CREATE TABLE remote_accounts (
 id uuid PRIMARY KEY,
 address varchar(42) NOT NULL,
 chain_id bigint NOT NULL,
 UNIQUE(address,chain_id)
);
CREATE TABLE remote_login_challenges (
 id uuid PRIMARY KEY,
 browser_hash char(64) NOT NULL,
 message_hash char(64) NOT NULL,
 address varchar(42) NOT NULL,
 chain_id bigint NOT NULL,
 expires_at bigint NOT NULL
);
CREATE INDEX remote_login_challenges_expiry ON remote_login_challenges(expires_at);
CREATE TABLE remote_sessions (
 token_hash char(64) PRIMARY KEY,
 origin text NOT NULL,
 chain_id bigint NOT NULL,
 owner_id uuid NOT NULL REFERENCES remote_accounts(id) ON DELETE CASCADE,
 expires_at bigint NOT NULL
);
CREATE INDEX remote_sessions_owner ON remote_sessions(owner_id);
CREATE INDEX remote_sessions_expiry ON remote_sessions(expires_at);
