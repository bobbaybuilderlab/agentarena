const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;
let schemaReady = false;

function getDb(dbPath) {
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
  const database = getDb(dbPath);
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
  const stmt = database.prepare(
    'INSERT OR IGNORE INTO users (id, is_anonymous) VALUES (?, 1)'
  );
  stmt.run(id);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function upgradeUser(userId, { email, displayName, agentId }) {
  const database = getDb();
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
  return database.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
}

// ── Session operations ──

function createSession(id, userId, token, expiresAt) {
  const database = getDb();
  database.prepare(
    'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, token, expiresAt);
  return { id, userId, token, expiresAt };
}

function getSessionByToken(token) {
  const database = getDb();
  return database.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
}

// ── Match operations ──

function recordMatch({ id, roomId, mode, winner, rounds, durationMs, startedAt, players }) {
  if (!schemaReady) initDb();
  const database = getDb();
  const insertMatch = database.prepare(`
    INSERT INTO match_results (id, room_id, mode, winner, rounds, duration_ms, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlayer = database.prepare(`
    INSERT INTO match_players (match_id, user_id, player_name, role, is_bot, survived, placement)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = database.transaction(() => {
    insertMatch.run(id, roomId, mode, winner, rounds, durationMs || null, startedAt || null);
    for (const p of players) {
      insertPlayer.run(id, p.userId || null, p.name, p.role || null, p.isBot ? 1 : 0, p.survived ? 1 : 0, p.placement || null);
    }
  });

  transaction();
  return { id, roomId, mode };
}

function getMatchesByUser(userId, limit = 20) {
  const database = getDb();
  return database.prepare(`
    SELECT mr.*, mp.player_name, mp.role, mp.survived, mp.placement
    FROM match_results mr
    JOIN match_players mp ON mp.match_id = mr.id
    WHERE mp.user_id = ?
    ORDER BY mr.finished_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function getPlayerMatches(userId, limit = 10) {
  const database = getDb();
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
  `).all(userId, limit);
}

function getMatch(matchId) {
  const database = getDb();
  const match = database.prepare('SELECT * FROM match_results WHERE id = ?').get(matchId);
  if (!match) return null;
  match.players = database.prepare('SELECT * FROM match_players WHERE match_id = ?').all(matchId);
  return match;
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
  getMatch,
};
