CREATE TABLE IF NOT EXISTS user_agents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_user_agents_agent ON user_agents(agent_id);

-- Migrate existing single-agent ownership data
INSERT OR IGNORE INTO user_agents (user_id, agent_id, created_at)
  SELECT id, agent_id, COALESCE(updated_at, datetime('now'))
  FROM users
  WHERE agent_id IS NOT NULL AND agent_id != '';
