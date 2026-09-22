-- Device history is retained separately; index only rows still holding invalidatable authority.
CREATE INDEX remote_devices_cleanup_expiry ON remote_devices(expires_at,id)
 WHERE credential_hash IS NOT NULL OR control_credential_hash IS NOT NULL OR control_id IS NOT NULL OR controls_enabled OR controls_approved_epoch IS NOT NULL OR controls_approval_expires_at IS NOT NULL;
CREATE INDEX remote_devices_cleanup_revoked ON remote_devices(revoked_at,id)
 WHERE revoked_at IS NOT NULL AND (credential_hash IS NOT NULL OR control_credential_hash IS NOT NULL OR control_id IS NOT NULL OR controls_enabled OR controls_approved_epoch IS NOT NULL OR controls_approval_expires_at IS NOT NULL);
CREATE INDEX remote_control_approval_cleanup ON remote_devices(controls_approval_expires_at,id)
 WHERE controls_approval_expires_at IS NOT NULL;
