CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  agent_id TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_results (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  winner TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  party_chain_id TEXT,
  party_streak INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS party_chain_id TEXT;

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS party_streak INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS match_players (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES match_results(id) ON DELETE CASCADE,
  user_id TEXT,
  player_name TEXT NOT NULL,
  role TEXT,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  survived BOOLEAN NOT NULL DEFAULT FALSE,
  placement INTEGER,
  night_kill_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS night_kill_credits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id TEXT,
  room_id TEXT NOT NULL,
  target_player TEXT NOT NULL,
  message_text TEXT,
  reason TEXT NOT NULL DEFAULT 'inappropriate',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_match_results_room ON match_results(room_id);
CREATE INDEX IF NOT EXISTS idx_match_results_mode ON match_results(mode);
CREATE INDEX IF NOT EXISTS idx_match_results_party_chain ON match_results(party_chain_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
