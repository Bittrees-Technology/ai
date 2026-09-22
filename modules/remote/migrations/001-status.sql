-- Apply only to the dedicated relay database. Device rows are created by future verified pairing.
CREATE TABLE remote_devices (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 epoch integer NOT NULL CHECK (epoch > 0),
 expires_at bigint NOT NULL,
 revoked_at bigint,
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence >= 0 AND last_sequence <= 9007199254740991),
 last_batch_hash char(64),
 UNIQUE(owner_id,id)
);
CREATE TABLE remote_status (
 device_id uuid NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','awaiting_input','awaiting_approval','paused','completed','failed','cancelled','expired')),
 revision bigint NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
 updated_at bigint NOT NULL,
 error_code text CHECK(error_code IN ('MODEL_UNAVAILABLE','AUTHORITY_EXPIRED','CONFLICT','CAPACITY','INTERNAL')),
 projection_hash char(64) NOT NULL,
 expires_at bigint NOT NULL,
 PRIMARY KEY(device_id,id)
);
CREATE INDEX remote_status_expiry ON remote_status(expires_at);
