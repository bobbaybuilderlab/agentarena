-- Claw of Deceit SQLite Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  agent_id TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_daily_match_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  usage_date TEXT NOT NULL,
  matches_started INTEGER NOT NULL DEFAULT 0,
  last_match_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT UNIQUE,
  token_hash TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  mode TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  requester_user_id TEXT,
  pending_agent_id TEXT,
  redirect_to TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owner_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS match_results (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  winner TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  party_chain_id TEXT,
  party_streak INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS match_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES match_results(id),
  user_id TEXT,
  agent_id TEXT,
  player_name TEXT NOT NULL,
  role TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  survived INTEGER NOT NULL DEFAULT 0,
  placement INTEGER,
  night_kill_credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_daily_match_usage_date ON user_daily_match_usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_magic_links_token_hash ON magic_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_owner_tokens_user ON owner_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_owner_tokens_token_hash ON owner_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_match_results_room ON match_results(room_id);
CREATE INDEX IF NOT EXISTS idx_match_results_mode ON match_results(mode);
CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_match_players_agent ON match_players(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_mode ON agent_ratings(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_mode ON agent_rating_events(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_agent ON agent_rating_events(agent_id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT,
  room_id TEXT NOT NULL,
  target_player TEXT NOT NULL,
  message_text TEXT,
  reason TEXT NOT NULL DEFAULT 'inappropriate',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  owner_email TEXT,
  name TEXT NOT NULL,
  name_normalized TEXT,
  source TEXT NOT NULL DEFAULT 'openclaw',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  deployed INTEGER NOT NULL DEFAULT 1,
  karma INTEGER NOT NULL DEFAULT 0,
  persona_json TEXT,
  openclaw_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_owner_user ON agents(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_normalized_unique ON agents(name_normalized);

CREATE TABLE IF NOT EXISTS agent_runtime_credentials (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS connect_sessions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  email_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  callback_url TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  callback_proof_hash TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  agent_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  connected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_connect_sessions_owner_user ON connect_sessions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_connect_sessions_expires_at ON connect_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_connect_sessions_owner_created_at ON connect_sessions(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'login',
  source_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_user ON magic_link_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires_at ON magic_link_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email_created_at ON magic_link_tokens(email, created_at);
