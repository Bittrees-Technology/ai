-- Additive device-key registration only. This table grants no task permissions.
CREATE TABLE IF NOT EXISTS workflow_runtime_keys (
 principal text PRIMARY KEY,
 authority_id uuid NOT NULL REFERENCES workflow_authorities(id),
 device_id uuid NOT NULL,
 public_key text NOT NULL,
 credential_id text NOT NULL,
 source_workspace uuid NOT NULL,
 owner_wallet text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
