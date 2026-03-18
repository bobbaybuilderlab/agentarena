CREATE TABLE IF NOT EXISTS sessions_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT UNIQUE,
  token_hash TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_next (id, user_id, token, token_hash, expires_at, created_at)
SELECT
  id,
  user_id,
  token,
  NULL,
  expires_at,
  created_at
FROM sessions;

DROP INDEX IF EXISTS idx_sessions_token;
DROP INDEX IF EXISTS idx_sessions_user;
DROP TABLE sessions;

ALTER TABLE sessions_next RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
