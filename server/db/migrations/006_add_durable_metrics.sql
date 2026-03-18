CREATE TABLE IF NOT EXISTS metric_counters (
  metric_key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_counters_updated_at ON metric_counters(updated_at);

CREATE TABLE IF NOT EXISTS ops_snapshots (
  name TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kpi_room_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mode, room_id, type)
);

CREATE INDEX IF NOT EXISTS idx_kpi_room_events_mode_type ON kpi_room_events(mode, type);
CREATE INDEX IF NOT EXISTS idx_kpi_room_events_created_at ON kpi_room_events(created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
