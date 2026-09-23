-- Registration identity only: no private key, ciphertext, source or task authority.
CREATE TABLE remote_browser_devices (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES remote_accounts(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 credential_hash char(64) NOT NULL UNIQUE,
 credential_epoch bigint NOT NULL CHECK (credential_epoch > 0 AND credential_epoch <= 9007199254740991),
 created_at bigint NOT NULL CHECK (created_at > 0),
 expires_at bigint NOT NULL CHECK (expires_at > created_at),
 revoked_at bigint,
 UNIQUE(owner_id, operation_id)
);
CREATE INDEX remote_browser_devices_owner ON remote_browser_devices(owner_id, id);
