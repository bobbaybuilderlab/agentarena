ALTER TABLE agents
  ADD COLUMN name_normalized TEXT;

ALTER TABLE agents
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';

ALTER TABLE agents
  ADD COLUMN archived_at TEXT;

UPDATE agents
SET name_normalized = LOWER(TRIM(name))
WHERE name_normalized IS NULL OR TRIM(name_normalized) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_normalized_unique ON agents(name_normalized);
