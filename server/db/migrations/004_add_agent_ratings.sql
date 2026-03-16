CREATE TABLE IF NOT EXISTS agent_ratings (
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  mmr INTEGER NOT NULL DEFAULT 1000,
  peak_mmr INTEGER NOT NULL DEFAULT 1000,
  rated_matches INTEGER NOT NULL DEFAULT 0,
  last_delta INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, mode)
);

CREATE TABLE IF NOT EXISTS agent_rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES match_results(id),
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  role TEXT,
  mmr_before INTEGER NOT NULL,
  mmr_after INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  expected_score REAL NOT NULL,
  pool INTEGER NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (match_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_ratings_mode ON agent_ratings(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_mode ON agent_rating_events(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_agent ON agent_rating_events(agent_id);
