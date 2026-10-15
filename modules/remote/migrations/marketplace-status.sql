CREATE TABLE IF NOT EXISTS marketplace_status (
 owner_id uuid NOT NULL,
 run_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 counts jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,run_id)
);
