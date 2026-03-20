CREATE TABLE IF NOT EXISTS user_daily_match_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  usage_date TEXT NOT NULL,
  matches_started INTEGER NOT NULL DEFAULT 0,
  last_match_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_match_usage_date ON user_daily_match_usage(usage_date);
