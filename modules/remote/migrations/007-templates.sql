-- Local template text and names never enter these tables. No existing control scope is upgraded.
CREATE TABLE remote_templates (
 permission_id uuid PRIMARY KEY,
 device_id uuid NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
 device_epoch integer NOT NULL CHECK(device_epoch>0),
 template_id uuid NOT NULL,
 template_revision bigint NOT NULL CHECK(template_revision>0 AND template_revision<=9007199254740991),
 approved_at bigint NOT NULL,
 expires_at bigint NOT NULL,
 max_runs integer NOT NULL CHECK(max_runs BETWEEN 1 AND 20),
 submitted_runs integer NOT NULL DEFAULT 0 CHECK(submitted_runs>=0 AND submitted_runs<=max_runs),
 credential_hash char(64) UNIQUE,
 publication_hash char(64) NOT NULL,
 revoked_at bigint,
 purge_at bigint NOT NULL,
 CHECK(expires_at>approved_at AND expires_at<=approved_at+86400000)
);
CREATE INDEX remote_templates_device ON remote_templates(device_id,permission_id);
CREATE INDEX remote_templates_purge ON remote_templates(purge_at,permission_id);
CREATE TABLE remote_template_commands (
 id uuid PRIMARY KEY,
 permission_id uuid NOT NULL REFERENCES remote_templates(permission_id) ON DELETE CASCADE,
 request_hash char(64) NOT NULL,
 issued_at bigint NOT NULL,
 expires_at bigint NOT NULL,
 purge_at bigint NOT NULL,
 outcome text CHECK(outcome IN ('queued','expired','denied','capacity')),
 task_id uuid,
 completed_at bigint,
 CHECK((outcome IS NULL)=(completed_at IS NULL)),
 CHECK((outcome='queued' AND task_id IS NOT NULL) OR (outcome IS DISTINCT FROM 'queued' AND task_id IS NULL)),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+300000)
);
CREATE INDEX remote_template_commands_pending ON remote_template_commands(permission_id,issued_at,id) WHERE outcome IS NULL;
CREATE INDEX remote_template_commands_purge ON remote_template_commands(purge_at,id);
