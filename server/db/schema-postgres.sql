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

CREATE TABLE IF NOT EXISTS metric_counters (
  metric_key TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops_snapshots (
  name TEXT PRIMARY KEY,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kpi_room_events (
  id BIGSERIAL PRIMARY KEY,
  mode TEXT NOT NULL,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mode, room_id, type)
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
  agent_id TEXT,
  player_name TEXT NOT NULL,
  role TEXT,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  survived BOOLEAN NOT NULL DEFAULT FALSE,
  placement INTEGER,
  night_kill_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS agent_id TEXT;

ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS night_kill_credits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_email TEXT,
  name TEXT NOT NULL,
  name_normalized TEXT,
  source TEXT NOT NULL DEFAULT 'openclaw',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  deployed BOOLEAN NOT NULL DEFAULT TRUE,
  karma INTEGER NOT NULL DEFAULT 0,
  persona_json TEXT,
  openclaw_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_connected_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS name_normalized TEXT;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE agents
SET name_normalized = LOWER(BTRIM(name))
WHERE name_normalized IS NULL OR BTRIM(name_normalized) = '';

CREATE TABLE IF NOT EXISTS agent_runtime_credentials (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS connect_sessions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  callback_url TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  callback_proof_hash TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  agent_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  connected_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'login',
  source_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_ratings (
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  mmr INTEGER NOT NULL DEFAULT 1000,
  peak_mmr INTEGER NOT NULL DEFAULT 1000,
  rated_matches INTEGER NOT NULL DEFAULT 0,
  last_delta INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, mode)
);

CREATE TABLE IF NOT EXISTS agent_rating_events (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES match_results(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  role TEXT,
  mmr_before INTEGER NOT NULL,
  mmr_after INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  expected_score DOUBLE PRECISION NOT NULL,
  pool INTEGER NOT NULL,
  provisional BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, agent_id)
);

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
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_match_results_room ON match_results(room_id);
CREATE INDEX IF NOT EXISTS idx_match_results_mode ON match_results(mode);
CREATE INDEX IF NOT EXISTS idx_match_results_party_chain ON match_results(party_chain_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_match_players_agent ON match_players(agent_id);
CREATE INDEX IF NOT EXISTS idx_metric_counters_updated_at ON metric_counters(updated_at);
CREATE INDEX IF NOT EXISTS idx_kpi_room_events_mode_type ON kpi_room_events(mode, type);
CREATE INDEX IF NOT EXISTS idx_kpi_room_events_created_at ON kpi_room_events(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_mode ON agent_ratings(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_mode ON agent_rating_events(mode);
CREATE INDEX IF NOT EXISTS idx_agent_rating_events_agent ON agent_rating_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_owner_user ON agents(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_normalized_unique ON agents(name_normalized);
CREATE INDEX IF NOT EXISTS idx_connect_sessions_owner_user ON connect_sessions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_connect_sessions_expires_at ON connect_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_user ON magic_link_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires_at ON magic_link_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
