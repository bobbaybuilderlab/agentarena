ALTER TABLE match_players
  ADD COLUMN agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_match_players_agent ON match_players(agent_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  owner_email TEXT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'openclaw',
  deployed INTEGER NOT NULL DEFAULT 1,
  karma INTEGER NOT NULL DEFAULT 0,
  persona_json TEXT,
  openclaw_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_owner_user ON agents(owner_user_id);

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
