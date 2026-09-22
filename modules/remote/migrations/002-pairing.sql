-- Internal relay foundation only; apply after 001-status.sql.
ALTER TABLE remote_devices ADD COLUMN credential_hash char(64) UNIQUE;
CREATE TABLE remote_pairings (
 id uuid PRIMARY KEY,
 approval_hash char(64) NOT NULL,
 challenge varchar(43) NOT NULL,
 owner_id uuid,
 expires_at bigint NOT NULL
);
CREATE INDEX remote_pairings_expiry ON remote_pairings(expires_at);
