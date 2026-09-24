-- Explicit transport permission only; no endpoint key, task, ciphertext or inference authority.
CREATE TABLE remote_private_relay_grants (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES remote_accounts(id) ON DELETE CASCADE,
 endpoint_kind text NOT NULL CHECK(endpoint_kind IN ('browser','mac')),
 endpoint_id uuid NOT NULL,
 credential_epoch bigint NOT NULL CHECK(credential_epoch > 0 AND credential_epoch <= 9007199254740991),
 operation_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
 state text NOT NULL CHECK(state IN ('pending','active','revoked')),
 credential_hash char(64) UNIQUE,
 created_at bigint NOT NULL CHECK(created_at > 0),
 expires_at bigint NOT NULL CHECK(expires_at > created_at),
 approval_expires_at bigint,
 revoked_at bigint,
 UNIQUE(owner_id,operation_id),
 CHECK((state='revoked')=(revoked_at IS NOT NULL)),
 CHECK((state='pending')=(approval_expires_at IS NOT NULL)),
 CHECK((endpoint_kind='mac' AND state='active')=(credential_hash IS NOT NULL)),
 CHECK(endpoint_kind='mac' OR state<>'pending'),
 CHECK(approval_expires_at IS NULL OR (approval_expires_at>created_at AND approval_expires_at<=expires_at)),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE UNIQUE INDEX remote_private_relay_current ON remote_private_relay_grants(owner_id,endpoint_kind,endpoint_id) WHERE state<>'revoked';
CREATE INDEX remote_private_relay_owner ON remote_private_relay_grants(owner_id,id);
