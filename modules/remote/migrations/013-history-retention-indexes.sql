-- Index the explicit 90-day history sweep; no rows or recorded deadlines are rewritten.
CREATE INDEX remote_devices_history_expiry ON remote_devices
  (GREATEST(expires_at,COALESCE(revoked_at,expires_at)),id);
CREATE INDEX remote_browser_history_expiry ON remote_browser_devices
  (GREATEST(expires_at,COALESCE(revoked_at,expires_at)),id);
CREATE INDEX remote_relay_grant_history_expiry ON remote_private_relay_grants
  (GREATEST(expires_at,COALESCE(revoked_at,expires_at)),id);
CREATE INDEX remote_mcp_history_expiry ON remote_mcp_delegations
  (GREATEST(COALESCE(expires_at,request_expires_at),COALESCE(revoked_at,request_expires_at)),id);
CREATE INDEX remote_mcp_delegation_permission ON remote_mcp_delegations(permission_id);
CREATE INDEX remote_relay_grant_endpoint_history ON remote_private_relay_grants(endpoint_kind,endpoint_id);
