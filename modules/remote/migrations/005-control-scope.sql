ALTER TABLE remote_devices ADD COLUMN controls_approved_epoch integer;
ALTER TABLE remote_devices ADD COLUMN controls_approval_expires_at bigint;
ALTER TABLE remote_devices ADD COLUMN control_id uuid;
ALTER TABLE remote_devices ADD COLUMN control_credential_hash char(64) UNIQUE;
ALTER TABLE remote_commands ADD COLUMN control_id uuid;
-- Old internal fixture flags are not a scoped credential or user approval.
UPDATE remote_devices SET controls_enabled=false;
