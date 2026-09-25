-- Permit the selected 90-day policy for new rows without rewriting historical deadlines.
ALTER TABLE remote_private_messages
  DROP CONSTRAINT remote_private_messages_metadata_retention_ms_check,
  ADD CONSTRAINT remote_private_messages_metadata_retention_ms_check
    CHECK (metadata_retention_ms IN (604800000,2592000000,7776000000));
