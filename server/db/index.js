let Database = null;
try {
  Database = require('better-sqlite3');
} catch (_e) {
  console.warn('[db] better-sqlite3 unavailable — running without persistence. Match records will not be saved.');
}

const path = require('path');
const fs = require('fs');

let db = null;
let schemaReady = false;

function getDb(dbPath) {
  if (!Database) return null;
  if (db) return db;

  const resolvedPath = dbPath || path.join(__dirname, '..', '..', 'data', 'arena.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

function initDb(dbPath) {
  if (!Database) return null;
  const database = getDb(dbPath);
  if (!database) return null;
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  database.exec(schema);
  schemaReady = true;
  return database;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    schemaReady = false;
  }
}

// ── User operations ──

function createAnonymousUser(id) {
  const database = getDb();
  if (!database) return { id, is_anonymous: 1 };
  const stmt = database.prepare(
    'INSERT OR IGNORE INTO users (id, is_anonymous) VALUES (?, 1)'
  );
  stmt.run(id);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function upgradeUser(userId, { email, displayName, agentId }) {
  const database = getDb();
  // Validate and truncate inputs
  if (email && (typeof email !== 'string' || email.length > 254)) email = typeof email === 'string' ? email.slice(0, 254) : undefined;
  if (displayName && (typeof displayName !== 'string' || displayName.length > 32)) displayName = typeof displayName === 'string' ? displayName.slice(0, 32) : undefined;
  if (agentId && (typeof agentId !== 'string' || agentId.length > 64)) agentId = typeof agentId === 'string' ? agentId.slice(0, 64) : undefined;
  if (!database) return { id: userId, email, displayName, agentId };
  const updates = [];
  const params = [];
  if (email) { updates.push('email = ?'); params.push(email); }
  if (displayName) { updates.push('display_name = ?'); params.push(displayName); }
  if (agentId) { updates.push('agent_id = ?'); params.push(agentId); }
  updates.push('is_anonymous = 0');
  updates.push("updated_at = datetime('now')");
  params.push(userId);
  database.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getUserByToken(token) {
  const database = getDb();
  if (!database) return null;
  return database.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
}

// ── Session operations ──

function createSession(id, userId, token, expiresAt) {
  const database = getDb();
  if (!database) return { id, userId, token, expiresAt };
  database.prepare(
    'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, token, expiresAt);
  return { id, userId, token, expiresAt };
}

function getSessionByToken(token) {
  const database = getDb();
  if (!database) return null;
  return database.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
}

// ── Match operations ──

function recordMatch({ id, roomId, mode, winner, rounds, durationMs, startedAt, finishedAt, players }) {
  const database = getDb();
  if (!database) return { id, roomId, mode };
  if (!schemaReady) initDb();
  const insertMatch = database.prepare(`
    INSERT INTO match_results (id, room_id, mode, winner, rounds, duration_ms, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlayer = database.prepare(`
    INSERT INTO match_players (match_id, user_id, player_name, role, is_bot, survived, placement)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = database.transaction(() => {
    insertMatch.run(id, roomId, mode, winner, rounds, durationMs || null, startedAt || null, finishedAt || null);
    for (const p of players) {
      insertPlayer.run(id, p.userId || null, p.name, p.role || null, p.isBot ? 1 : 0, p.survived ? 1 : 0, p.placement || null);
    }
  });

  transaction();
  return { id, roomId, mode };
}

function getMatchesByUser(userId, limit = 20) {
  const database = getDb();
  if (!database) return [];
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
  return database.prepare(`
    SELECT mr.*, mp.player_name, mp.role, mp.survived, mp.placement
    FROM match_results mr
    JOIN match_players mp ON mp.match_id = mr.id
    WHERE mp.user_id = ?
    ORDER BY mr.finished_at DESC
    LIMIT ?
  `).all(userId, cappedLimit);
}

function getPlayerMatches(userId, limit = 10) {
  const database = getDb();
  if (!database) return [];
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 10), 100);
  return database.prepare(`
    SELECT
      mr.id,
      mr.mode,
      mr.winner,
      mr.rounds,
      mr.duration_ms,
      mr.finished_at,
      mp.player_name,
      mp.role,
      mp.survived,
      mp.placement
    FROM match_results mr
    JOIN match_players mp ON mp.match_id = mr.id
    WHERE mp.user_id = ?
    ORDER BY mr.finished_at DESC
    LIMIT ?
  `).all(userId, cappedLimit);
}

function getLeaderboardEntries({ mode = 'mafia', windowHours = null, limit = 25 } = {}) {
  const database = getDb();
  if (!database) return [];
  if (!schemaReady) initDb();
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 25), 100);
  const params = [mode];
  let windowFilter = '';

  if (windowHours && Number(windowHours) > 0) {
    windowFilter = "AND mr.finished_at >= datetime('now', ?)";
    params.push(`-${Number(windowHours)} hours`);
  }

  params.push(cappedLimit);

  return database.prepare(`
    SELECT
      COALESCE(NULLIF(mp.user_id, ''), mp.player_name) AS id,
      MAX(mp.player_name) AS name,
      COUNT(*) AS games_played,
      SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN mp.survived = 1 THEN 1 ELSE 0 END) AS survivals,
      ROUND(AVG(mr.duration_ms)) AS avg_duration_ms,
      MAX(mr.finished_at) AS last_played_at
    FROM match_players mp
    JOIN match_results mr ON mr.id = mp.match_id
    WHERE mp.is_bot = 0
      AND mr.mode = ?
      ${windowFilter}
    GROUP BY COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
    ORDER BY wins DESC, games_played DESC, survivals DESC, last_played_at DESC
    LIMIT ?
  `).all(...params);
}

function getMatchBaselineSummary({ mode = 'mafia' } = {}) {
  const database = getDb();
  if (!database) return null;
  if (!schemaReady) initDb();

  const aggregate = database.prepare(`
    SELECT
      COUNT(*) AS sample_size,
      ROUND(AVG(duration_ms)) AS avg_duration_ms,
      MIN(duration_ms) AS fastest_duration_ms,
      MAX(duration_ms) AS slowest_duration_ms,
      MAX(finished_at) AS latest_completed_at
    FROM match_results
    WHERE mode = ?
      AND duration_ms IS NOT NULL
      AND duration_ms > 0
  `).get(mode);

  if (!aggregate || !Number(aggregate.sample_size || 0)) return null;

  const latest = database.prepare(`
    SELECT room_id, finished_at
    FROM match_results
    WHERE mode = ?
      AND duration_ms IS NOT NULL
      AND duration_ms > 0
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(mode);

  return {
    sampleSize: Number(aggregate.sample_size || 0),
    avgDurationMs: Number(aggregate.avg_duration_ms || 0) || null,
    fastestDurationMs: Number(aggregate.fastest_duration_ms || 0) || null,
    slowestDurationMs: Number(aggregate.slowest_duration_ms || 0) || null,
    latestCompletedRoomId: latest?.room_id || null,
    latestCompletedAt: latest?.finished_at || aggregate.latest_completed_at || null,
  };
}

function getMatch(matchId) {
  const database = getDb();
  if (!database) return null;
  const match = database.prepare('SELECT * FROM match_results WHERE id = ?').get(matchId);
  if (!match) return null;
  match.players = database.prepare('SELECT * FROM match_players WHERE match_id = ?').all(matchId);
  return match;
}

// ── Report operations ──

function createReport({ reporterId, roomId, targetPlayer, messageText, reason }) {
  const database = getDb();
  if (!database) return;
  database.prepare(`
    INSERT INTO reports (reporter_id, room_id, target_player, message_text, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(reporterId || null, roomId, targetPlayer, messageText || null, reason || 'inappropriate');
}

function getReports({ status, limit } = {}) {
  const database = getDb();
  if (!database) return [];
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status, limit || 50] : [limit || 50];
  return database.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
}

const VALID_REPORT_STATUSES = ['pending', 'reviewed', 'dismissed'];

function updateReportStatus(id, status) {
  if (!VALID_REPORT_STATUSES.includes(status)) return;
  const database = getDb();
  if (!database) return;
  database.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
}

module.exports = {
  getDb,
  initDb,
  closeDb,
  createAnonymousUser,
  upgradeUser,
  getUserByToken,
  createSession,
  getSessionByToken,
  recordMatch,
  getMatchesByUser,
  getPlayerMatches,
  getLeaderboardEntries,
  getMatchBaselineSummary,
  getMatch,
  createReport,
  getReports,
  updateReportStatus,
};
