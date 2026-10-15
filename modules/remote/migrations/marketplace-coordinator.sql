-- Optional coordinator pilot. Apply explicitly before configuring connections.
CREATE TABLE IF NOT EXISTS marketplace_runs (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 input jsonb NOT NULL,
 steps jsonb NOT NULL,
 lease uuid,
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_runs_owner ON marketplace_runs(owner_id,updated_at);
