-- Metadata index only. Names, prompts, input, model credentials and output stay local.
CREATE TABLE IF NOT EXISTS workflow_catalogue_snapshots (
 authority_id uuid PRIMARY KEY REFERENCES workflow_authorities(id) ON DELETE CASCADE,
 observed_at bigint NOT NULL CHECK(observed_at>0)
);
CREATE TABLE IF NOT EXISTS workflow_local_catalogue (
 authority_id uuid NOT NULL REFERENCES workflow_authorities(id) ON DELETE CASCADE,
 template_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
 kind text NOT NULL,
 removed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(authority_id,template_id)
);
