-- Existing paired devices do not gain command delivery. Future explicit consent must enable it.
ALTER TABLE remote_devices ADD COLUMN controls_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE remote_commands (
 id uuid PRIMARY KEY,
 device_id uuid NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
 device_epoch integer NOT NULL CHECK(device_epoch > 0),
 task_id uuid NOT NULL,
 request_hash char(64) NOT NULL,
 command text NOT NULL CHECK(command IN ('pause','cancel')),
 expected_revision bigint NOT NULL CHECK(expected_revision > 0 AND expected_revision <= 9007199254740991),
 issued_at bigint NOT NULL,
 expires_at bigint NOT NULL,
 purge_at bigint NOT NULL,
 outcome text CHECK(outcome IN ('applied','conflict','expired','denied','cancelled')),
 completed_at bigint,
 CHECK ((outcome IS NULL) = (completed_at IS NULL)),
 CHECK(expires_at > issued_at AND expires_at <= issued_at + 300000)
);
CREATE INDEX remote_commands_pending ON remote_commands(device_id,device_epoch,issued_at,id) WHERE outcome IS NULL;
CREATE INDEX remote_commands_purge ON remote_commands(purge_at);
