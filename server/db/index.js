const path = require('path');
const fs = require('fs');
const {
  MAFIA_ELO_MODE,
  DEFAULT_MMR,
  PROVISIONAL_MATCH_COUNT,
  buildDefaultRatingSnapshot,
  normalizeRatingSnapshot,
  calculateMatchRatingChanges,
  resolveParticipantId,
} = require('../services/mafia-elo');

let SQLiteDatabase = null;
try {
  SQLiteDatabase = require('better-sqlite3');
} catch (_err) {
  SQLiteDatabase = null;
}

let PgPool = null;
try {
  ({ Pool: PgPool } = require('pg'));
} catch (_err) {
  PgPool = null;
}

const POSTGRES_SCHEMA_PATH = path.join(__dirname, 'schema-postgres.sql');
const DEFAULT_SQLITE_PATH = path.join(__dirname, '..', '..', 'data', 'arena.db');

let dbState = null;
let initPromise = null;
let warnedUnavailable = false;
const memoryUsers = new Map();
const memorySessions = new Map();
const memoryMagicLinks = new Map();
const memoryOwnerTokens = new Map();

function warnUnavailable(message) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(message);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmailValue(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function duplicateEmailError() {
  return new Error('duplicate key value violates unique constraint "users_email_key"');
}

function normalizeIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readSchema(schemaPath) {
  return fs.readFileSync(schemaPath, 'utf8');
}

function openSqliteDatabase(dbPath) {
  const resolvedPath = dbPath || DEFAULT_SQLITE_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const database = new SQLiteDatabase(resolvedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

function currentAdapter() {
  return dbState;
}

async function initDb(dbPath) {
  if (initPromise) return initPromise;
  if (dbState?.kind === 'sqlite') return dbState.database;
  if (dbState?.kind === 'postgres') return dbState.pool;
  if (dbState?.kind === 'none') return null;

  initPromise = (async () => {
    const databaseUrl = String(process.env.DATABASE_URL || '').trim();

    if (databaseUrl) {
      if (!PgPool) {
        warnUnavailable('[db] DATABASE_URL is set, but the `pg` package is unavailable. Falling back to in-memory persistence.');
        dbState = { kind: 'none', driver: 'none' };
        return null;
      }

      const pool = new PgPool({ connectionString: databaseUrl });
      try {
        await pool.query(readSchema(POSTGRES_SCHEMA_PATH));
        dbState = { kind: 'postgres', driver: 'postgres', pool };
        return pool;
      } catch (error) {
        warnUnavailable(`[db] Postgres initialization failed: ${error.message}. Falling back to in-memory persistence.`);
        try {
          await pool.end();
        } catch (_err) {
          // ignore close errors during degraded startup
        }
        dbState = { kind: 'none', driver: 'none', error };
        return null;
      }
    }

    if (SQLiteDatabase) {
      const database = openSqliteDatabase(dbPath);
      const { runMigrations } = require('./migrate');
      runMigrations(database);
      dbState = { kind: 'sqlite', driver: 'sqlite', database };
      return database;
    }

    warnUnavailable('[db] No DATABASE_URL and better-sqlite3 unavailable — running without persistence. Match records will not be saved.');
    dbState = { kind: 'none', driver: 'none' };
    return null;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

async function ensureDb(dbPath) {
  if (!dbState) await initDb(dbPath);
  return dbState;
}

function getDb() {
  if (dbState?.kind === 'sqlite') return dbState.database;
  if (dbState?.kind === 'postgres') return dbState.pool;
  return null;
}

async function closeDb() {
  const current = dbState;
  dbState = null;
  initPromise = null;

  if (!current) return;

  if (current.kind === 'sqlite' && current.database) {
    current.database.close();
    return;
  }

  if (current.kind === 'postgres' && current.pool) {
    await current.pool.end();
  }
}

function normalizeUserRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_anonymous: toBoolean(row.is_anonymous),
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    updated_at: normalizeIso(row.updated_at) || row.updated_at || null,
  };
}

function normalizeSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    expires_at: normalizeIso(row.expires_at) || row.expires_at || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
  };
}

function normalizeMatchRow(row) {
  if (!row) return null;
  const roomId = row.room_id || row.roomId || null;
  const startedAt = normalizeIso(row.started_at || row.startedAt);
  const finishedAt = normalizeIso(row.finished_at || row.finishedAt);
  const partyChainId = row.party_chain_id || row.partyChainId || null;
  const partyStreak = row.party_streak == null ? 0 : toNumber(row.party_streak);
  const nightKillCredits = row.night_kill_credits == null ? 0 : toNumber(row.night_kill_credits);
  const survived = toBoolean(row.survived);
  const isBot = toBoolean(row.is_bot);

  return {
    ...row,
    room_id: roomId,
    roomId,
    rounds: toNumber(row.rounds),
    duration_ms: row.duration_ms == null ? null : toNumber(row.duration_ms),
    durationMs: row.duration_ms == null ? null : toNumber(row.duration_ms),
    started_at: startedAt,
    startedAt,
    finished_at: finishedAt,
    finishedAt,
    party_chain_id: partyChainId,
    partyChainId,
    party_streak: partyStreak,
    partyStreak,
    player_name: row.player_name || row.playerName || null,
    playerName: row.player_name || row.playerName || null,
    survived,
    placement: row.placement == null ? null : toNumber(row.placement),
    is_bot: isBot,
    night_kill_credits: nightKillCredits,
    nightKillCredits,
  };
}

function normalizeRatingRow(row) {
  const snapshot = buildDefaultRatingSnapshot({
    mmr: row?.mmr,
    peakMmr: row?.peak_mmr ?? row?.peakMmr,
    ratedMatches: row?.rated_matches ?? row?.ratedMatches,
    lastRatingDelta: row?.last_delta ?? row?.lastDelta,
  });

  return {
    agent_id: row?.agent_id || row?.agentId || null,
    agentId: row?.agent_id || row?.agentId || null,
    mode: row?.mode || MAFIA_ELO_MODE,
    mmr: snapshot.mmr,
    peak_mmr: snapshot.peakMmr,
    peakMmr: snapshot.peakMmr,
    rated_matches: snapshot.ratedMatches,
    ratedMatches: snapshot.ratedMatches,
    last_delta: snapshot.lastRatingDelta,
    lastDelta: snapshot.lastRatingDelta,
    updated_at: normalizeIso(row?.updated_at || row?.updatedAt),
    updatedAt: normalizeIso(row?.updated_at || row?.updatedAt),
    isProvisional: snapshot.isProvisional,
  };
}

function normalizeReportRow(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
  };
}

function listRatedParticipantIds(players = []) {
  return [...new Set(
    players
      .filter((player) => player && !player.isBot)
      .map((player) => resolveParticipantId(player))
      .filter(Boolean),
  )];
}

function buildRatingSnapshotMap(agentIds = [], currentRatings = {}) {
  const snapshots = Object.create(null);
  for (const agentId of agentIds) {
    snapshots[agentId] = normalizeRatingSnapshot(currentRatings?.[agentId] || {});
  }
  return snapshots;
}

function getAgentRatingsMapSync(database, agentIds = [], mode = MAFIA_ELO_MODE) {
  const ids = [...new Set(agentIds.map((agentId) => String(agentId || '').trim()).filter(Boolean))];
  const snapshots = buildRatingSnapshotMap(ids);
  if (!ids.length || !database) return snapshots;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT *
    FROM agent_ratings
    WHERE mode = ?
      AND agent_id IN (${placeholders})
  `).all(mode, ...ids);

  for (const row of rows) {
    if (!row?.agent_id) continue;
    snapshots[row.agent_id] = normalizeRatingRow(row);
  }

  return snapshots;
}

async function getAgentRatingsMap(client, agentIds = [], mode = MAFIA_ELO_MODE) {
  const ids = [...new Set(agentIds.map((agentId) => String(agentId || '').trim()).filter(Boolean))];
  const snapshots = buildRatingSnapshotMap(ids);
  if (!ids.length || !client) return snapshots;

  const result = await client.query(
    'SELECT * FROM agent_ratings WHERE mode = $1 AND agent_id = ANY($2::text[])',
    [mode, ids],
  );
  for (const row of result.rows || []) {
    if (!row?.agent_id) continue;
    snapshots[row.agent_id] = normalizeRatingRow(row);
  }
  return snapshots;
}

async function getAgentRating(agentId, { mode = MAFIA_ELO_MODE } = {}) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return normalizeRatingSnapshot();

  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return normalizeRatingSnapshot();

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM agent_ratings WHERE agent_id = $1 AND mode = $2 LIMIT 1',
      [cleanAgentId, mode],
    );
    return normalizeRatingRow(result.rows[0] || { agent_id: cleanAgentId, mode });
  }

  const row = adapter.database.prepare(`
    SELECT *
    FROM agent_ratings
    WHERE agent_id = ?
      AND mode = ?
    LIMIT 1
  `).get(cleanAgentId, mode);
  return normalizeRatingRow(row || { agent_id: cleanAgentId, mode });
}

function normalizeMagicLinkRow(row) {
  if (!row) return null;
  return {
    ...row,
    email: normalizeEmailValue(row.email),
    expires_at: normalizeIso(row.expires_at) || row.expires_at || null,
    consumed_at: normalizeIso(row.consumed_at) || row.consumed_at || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
  };
}

function normalizeOwnerTokenRow(row) {
  if (!row) return null;
  return {
    ...row,
    revoked_at: normalizeIso(row.revoked_at) || row.revoked_at || null,
    last_used_at: normalizeIso(row.last_used_at) || row.last_used_at || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
  };
}

function findMemoryUserByEmail(email) {
  const normalizedEmail = normalizeEmailValue(email);
  if (!normalizedEmail) return null;
  for (const user of memoryUsers.values()) {
    if (normalizeEmailValue(user.email) === normalizedEmail) return normalizeUserRow(user);
  }
  return null;
}

function getMemoryUserById(userId) {
  return normalizeUserRow(memoryUsers.get(String(userId || '').trim()) || null);
}

function upsertMemoryUser(user) {
  const normalizedId = String(user?.id || '').trim();
  if (!normalizedId) return null;
  const existing = memoryUsers.get(normalizedId) || null;
  const next = {
    id: normalizedId,
    email: normalizeEmailValue(user.email),
    display_name: user.display_name || null,
    agent_id: user.agent_id || null,
    is_anonymous: user.is_anonymous !== false,
    created_at: existing?.created_at || normalizeIso(user.created_at) || nowIso(),
    updated_at: normalizeIso(user.updated_at) || nowIso(),
  };
  memoryUsers.set(normalizedId, next);
  return normalizeUserRow(next);
}

function upsertMemorySession(session) {
  const normalizedToken = String(session?.token || '').trim();
  if (!normalizedToken) return null;
  const next = {
    id: String(session.id || '').trim() || normalizedToken,
    user_id: String(session.user_id || '').trim() || null,
    token: normalizedToken,
    expires_at: normalizeIso(session.expires_at) || session.expires_at || null,
    created_at: normalizeIso(session.created_at) || nowIso(),
  };
  memorySessions.set(normalizedToken, next);
  return normalizeSessionRow(next);
}

function getMemorySessionByToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;
  const session = memorySessions.get(normalizedToken) || null;
  if (!session) return null;
  const expiresAt = new Date(session.expires_at || '').getTime();
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    memorySessions.delete(normalizedToken);
    return null;
  }
  return normalizeSessionRow(session);
}

function deleteMemorySessionByToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return false;
  return memorySessions.delete(normalizedToken);
}

function upsertMemoryMagicLink(link) {
  const normalizedId = String(link?.id || '').trim();
  if (!normalizedId) return null;
  const existing = memoryMagicLinks.get(normalizedId) || null;
  const next = {
    id: normalizedId,
    email: normalizeEmailValue(link.email),
    mode: String(link.mode || '').trim() || 'login',
    token_hash: String(link.token_hash || '').trim(),
    requester_user_id: String(link.requester_user_id || '').trim() || null,
    pending_agent_id: String(link.pending_agent_id || '').trim() || null,
    redirect_to: link.redirect_to || null,
    expires_at: normalizeIso(link.expires_at) || link.expires_at || null,
    consumed_at: normalizeIso(link.consumed_at) || link.consumed_at || null,
    created_at: existing?.created_at || normalizeIso(link.created_at) || nowIso(),
  };
  memoryMagicLinks.set(normalizedId, next);
  return normalizeMagicLinkRow(next);
}

function findMemoryMagicLinkByTokenHash(tokenHash) {
  const normalizedHash = String(tokenHash || '').trim();
  if (!normalizedHash) return null;
  for (const link of memoryMagicLinks.values()) {
    if (String(link.token_hash || '').trim() === normalizedHash) return normalizeMagicLinkRow(link);
  }
  return null;
}

function upsertMemoryOwnerToken(token) {
  const normalizedId = String(token?.id || '').trim();
  if (!normalizedId) return null;
  const existing = memoryOwnerTokens.get(normalizedId) || null;
  const next = {
    id: normalizedId,
    user_id: String(token.user_id || '').trim() || null,
    token_hash: String(token.token_hash || '').trim(),
    revoked_at: normalizeIso(token.revoked_at) || token.revoked_at || null,
    last_used_at: normalizeIso(token.last_used_at) || token.last_used_at || null,
    created_at: existing?.created_at || normalizeIso(token.created_at) || nowIso(),
  };
  memoryOwnerTokens.set(normalizedId, next);
  return normalizeOwnerTokenRow(next);
}

function findMemoryOwnerTokenByHash(tokenHash) {
  const normalizedHash = String(tokenHash || '').trim();
  if (!normalizedHash) return null;
  for (const token of memoryOwnerTokens.values()) {
    if (String(token.token_hash || '').trim() === normalizedHash) return normalizeOwnerTokenRow(token);
  }
  return null;
}

async function createAnonymousUser(id) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    return upsertMemoryUser({
      id,
      email: null,
      display_name: null,
      agent_id: null,
      is_anonymous: true,
    });
  }

  if (adapter.kind === 'postgres') {
    await adapter.pool.query(
      'INSERT INTO users (id, is_anonymous) VALUES ($1, TRUE) ON CONFLICT (id) DO NOTHING',
      [id],
    );
    const result = await adapter.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return normalizeUserRow(result.rows[0]);
  }

  const stmt = adapter.database.prepare(
    'INSERT OR IGNORE INTO users (id, is_anonymous) VALUES (?, 1)',
  );
  stmt.run(id);
  return normalizeUserRow(adapter.database.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

async function upgradeUser(userId, { email, displayName, agentId } = {}) {
  const adapter = await ensureDb();

  if (email && (typeof email !== 'string' || email.length > 254)) email = typeof email === 'string' ? email.slice(0, 254) : undefined;
  email = normalizeEmailValue(email);
  if (displayName && (typeof displayName !== 'string' || displayName.length > 32)) displayName = typeof displayName === 'string' ? displayName.slice(0, 32) : undefined;
  if (agentId && (typeof agentId !== 'string' || agentId.length > 64)) agentId = typeof agentId === 'string' ? agentId.slice(0, 64) : undefined;

  if (!adapter || adapter.kind === 'none') {
    const existing = getMemoryUserById(userId) || null;
    const duplicate = email ? findMemoryUserByEmail(email) : null;
    if (duplicate?.id && duplicate.id !== String(userId || '').trim()) throw duplicateEmailError();
    return upsertMemoryUser({
      id: userId,
      email: email || existing?.email || null,
      display_name: displayName || existing?.display_name || null,
      agent_id: agentId || existing?.agent_id || null,
      is_anonymous: false,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
    });
  }

  if (adapter.kind === 'postgres') {
    const updates = [];
    const params = [];
    let index = 1;

    if (email) {
      updates.push(`email = $${index++}`);
      params.push(email);
    }
    if (displayName) {
      updates.push(`display_name = $${index++}`);
      params.push(displayName);
    }
    if (agentId) {
      updates.push(`agent_id = $${index++}`);
      params.push(agentId);
    }

    updates.push('is_anonymous = FALSE');
    updates.push('updated_at = NOW()');
    params.push(userId);

    const result = await adapter.pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${index} RETURNING *`,
      params,
    );
    return normalizeUserRow(result.rows[0] || null);
  }

  const updates = [];
  const params = [];
  if (email) {
    updates.push('email = ?');
    params.push(email);
  }
  if (displayName) {
    updates.push('display_name = ?');
    params.push(displayName);
  }
  if (agentId) {
    updates.push('agent_id = ?');
    params.push(agentId);
  }
  updates.push('is_anonymous = 0');
  updates.push("updated_at = datetime('now')");
  params.push(userId);
  adapter.database.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return normalizeUserRow(adapter.database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

async function getUserByToken(token) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && token) {
    const session = getMemorySessionByToken(token);
    if (!session?.user_id) return null;
    return getMemoryUserById(session.user_id);
  }
  if (!adapter || adapter.kind === 'none' || !token) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT u.* FROM users u
      JOIN sessions s ON s.user_id = u.id
      WHERE s.token = $1 AND s.expires_at > NOW()
      LIMIT 1
    `, [token]);
    return normalizeUserRow(result.rows[0] || null);
  }

  return normalizeUserRow(adapter.database.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token));
}

async function getUserById(userId) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && userId) {
    return getMemoryUserById(userId);
  }
  if (!adapter || adapter.kind === 'none' || !userId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    return normalizeUserRow(result.rows[0] || null);
  }

  return normalizeUserRow(adapter.database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmailValue(email);
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedEmail) {
    return findMemoryUserByEmail(normalizedEmail);
  }
  if (!adapter || adapter.kind === 'none' || !normalizedEmail) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1', [normalizedEmail]);
    return normalizeUserRow(result.rows[0] || null);
  }

  return normalizeUserRow(
    adapter.database.prepare('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1').get(normalizedEmail),
  );
}

async function setUserAgentId(userId, agentId) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    const existing = getMemoryUserById(userId) || null;
    return upsertMemoryUser({
      id: userId,
      email: existing?.email || null,
      display_name: existing?.display_name || null,
      agent_id: agentId || null,
      is_anonymous: existing?.is_anonymous !== false,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
    });
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE users
      SET agent_id = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [agentId || null, userId]);
    return normalizeUserRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE users
    SET agent_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(agentId || null, userId);
  return normalizeUserRow(adapter.database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

async function createSession(id, userId, token, expiresAt) {
  const adapter = await ensureDb();
  const fallback = normalizeSessionRow({ id, user_id: userId, token, expires_at: expiresAt });
  if (!adapter || adapter.kind === 'none') {
    upsertMemorySession(fallback);
    return fallback;
  }

  if (adapter.kind === 'postgres') {
    await adapter.pool.query(
      'INSERT INTO sessions (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
      [id, userId, token, expiresAt],
    );
    return fallback;
  }

  adapter.database.prepare(
    'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
  ).run(id, userId, token, expiresAt);
  return fallback;
}

async function getSessionByToken(token) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && token) {
    return getMemorySessionByToken(token);
  }
  if (!adapter || adapter.kind === 'none' || !token) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1',
      [token],
    );
    return normalizeSessionRow(result.rows[0] || null);
  }

  return normalizeSessionRow(adapter.database.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')",
  ).get(token));
}

async function deleteSessionByToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return false;

  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedToken) {
    return deleteMemorySessionByToken(normalizedToken);
  }
  if (!adapter || adapter.kind === 'none') return false;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'DELETE FROM sessions WHERE token = $1',
      [normalizedToken],
    );
    return result.rowCount > 0;
  }

  const result = adapter.database.prepare(
    'DELETE FROM sessions WHERE token = ?',
  ).run(normalizedToken);
  return Number(result.changes || 0) > 0;
}

async function createMagicLink({
  id,
  email,
  mode,
  tokenHash,
  requesterUserId,
  pendingAgentId,
  redirectTo,
  expiresAt,
}) {
  const adapter = await ensureDb();
  const normalizedEmail = normalizeEmailValue(email);
  const row = normalizeMagicLinkRow({
    id,
    email: normalizedEmail,
    mode: String(mode || 'login').trim() || 'login',
    token_hash: String(tokenHash || '').trim(),
    requester_user_id: String(requesterUserId || '').trim() || null,
    pending_agent_id: String(pendingAgentId || '').trim() || null,
    redirect_to: redirectTo || null,
    expires_at: expiresAt,
    consumed_at: null,
    created_at: nowIso(),
  });

  if (!adapter || adapter.kind === 'none') {
    return upsertMemoryMagicLink(row);
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO magic_links (
        id, email, mode, token_hash, requester_user_id, pending_agent_id, redirect_to, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      row.id,
      row.email,
      row.mode,
      row.token_hash,
      row.requester_user_id,
      row.pending_agent_id,
      row.redirect_to,
      row.expires_at,
    ]);
    return normalizeMagicLinkRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO magic_links (
      id, email, mode, token_hash, requester_user_id, pending_agent_id, redirect_to, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.email,
    row.mode,
    row.token_hash,
    row.requester_user_id,
    row.pending_agent_id,
    row.redirect_to,
    row.expires_at,
  );
  return normalizeMagicLinkRow(adapter.database.prepare('SELECT * FROM magic_links WHERE id = ?').get(row.id));
}

async function getMagicLinkByTokenHash(tokenHash) {
  const normalizedHash = String(tokenHash || '').trim();
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedHash) {
    return findMemoryMagicLinkByTokenHash(normalizedHash);
  }
  if (!adapter || adapter.kind === 'none' || !normalizedHash) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM magic_links WHERE token_hash = $1 LIMIT 1',
      [normalizedHash],
    );
    return normalizeMagicLinkRow(result.rows[0] || null);
  }

  return normalizeMagicLinkRow(
    adapter.database.prepare('SELECT * FROM magic_links WHERE token_hash = ? LIMIT 1').get(normalizedHash),
  );
}

async function consumeMagicLink(id) {
  const normalizedId = String(id || '').trim();
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedId) {
    const existing = memoryMagicLinks.get(normalizedId);
    if (!existing) return null;
    return upsertMemoryMagicLink({
      ...existing,
      consumed_at: nowIso(),
    });
  }
  if (!adapter || adapter.kind === 'none' || !normalizedId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE magic_links
      SET consumed_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [normalizedId]);
    return normalizeMagicLinkRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE magic_links
    SET consumed_at = datetime('now')
    WHERE id = ?
  `).run(normalizedId);
  return normalizeMagicLinkRow(adapter.database.prepare('SELECT * FROM magic_links WHERE id = ?').get(normalizedId));
}

async function rotateOwnerToken({ id, userId, tokenHash }) {
  const normalizedId = String(id || '').trim();
  const normalizedUserId = String(userId || '').trim();
  const normalizedHash = String(tokenHash || '').trim();
  const adapter = await ensureDb();
  const row = normalizeOwnerTokenRow({
    id: normalizedId,
    user_id: normalizedUserId,
    token_hash: normalizedHash,
    revoked_at: null,
    last_used_at: null,
    created_at: nowIso(),
  });

  if (!adapter || adapter.kind === 'none') {
    for (const [tokenId, token] of memoryOwnerTokens.entries()) {
      if (token.user_id === normalizedUserId && !token.revoked_at) {
        memoryOwnerTokens.set(tokenId, {
          ...token,
          revoked_at: nowIso(),
        });
      }
    }
    return upsertMemoryOwnerToken(row);
  }

  if (adapter.kind === 'postgres') {
    const client = await adapter.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE owner_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [normalizedUserId],
      );
      const inserted = await client.query(`
        INSERT INTO owner_tokens (id, user_id, token_hash)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [normalizedId, normalizedUserId, normalizedHash]);
      await client.query('COMMIT');
      return normalizeOwnerTokenRow(inserted.rows[0] || null);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  adapter.database.prepare(`
    UPDATE owner_tokens
    SET revoked_at = datetime('now')
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(normalizedUserId);
  adapter.database.prepare(`
    INSERT INTO owner_tokens (id, user_id, token_hash)
    VALUES (?, ?, ?)
  `).run(normalizedId, normalizedUserId, normalizedHash);
  return normalizeOwnerTokenRow(adapter.database.prepare('SELECT * FROM owner_tokens WHERE id = ?').get(normalizedId));
}

async function getOwnerTokenByHash(tokenHash) {
  const normalizedHash = String(tokenHash || '').trim();
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedHash) {
    return findMemoryOwnerTokenByHash(normalizedHash);
  }
  if (!adapter || adapter.kind === 'none' || !normalizedHash) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM owner_tokens WHERE token_hash = $1 LIMIT 1',
      [normalizedHash],
    );
    return normalizeOwnerTokenRow(result.rows[0] || null);
  }

  return normalizeOwnerTokenRow(
    adapter.database.prepare('SELECT * FROM owner_tokens WHERE token_hash = ? LIMIT 1').get(normalizedHash),
  );
}

async function touchOwnerToken(id) {
  const normalizedId = String(id || '').trim();
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && normalizedId) {
    const existing = memoryOwnerTokens.get(normalizedId);
    if (!existing) return null;
    return upsertMemoryOwnerToken({
      ...existing,
      last_used_at: nowIso(),
    });
  }
  if (!adapter || adapter.kind === 'none' || !normalizedId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE owner_tokens
      SET last_used_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [normalizedId]);
    return normalizeOwnerTokenRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE owner_tokens
    SET last_used_at = datetime('now')
    WHERE id = ?
  `).run(normalizedId);
  return normalizeOwnerTokenRow(adapter.database.prepare('SELECT * FROM owner_tokens WHERE id = ?').get(normalizedId));
}

async function recordMatch({
  id,
  roomId,
  mode,
  winner,
  rounds,
  durationMs,
  startedAt,
  finishedAt,
  partyChainId,
  partyStreak,
  players,
  currentRatings = {},
}) {
  const adapter = await ensureDb();
  const normalizedMode = String(mode || MAFIA_ELO_MODE).trim().toLowerCase() || MAFIA_ELO_MODE;
  const matchPlayers = Array.isArray(players) ? players : [];
  const participantIds = listRatedParticipantIds(matchPlayers);
  const ratingMatch = {
    id,
    mode: normalizedMode,
    winner,
    players: matchPlayers,
  };

  if (!adapter || adapter.kind === 'none') {
    return {
      id,
      roomId,
      mode: normalizedMode,
      ratingUpdates: calculateMatchRatingChanges(ratingMatch, buildRatingSnapshotMap(participantIds, currentRatings)),
    };
  }

  if (adapter.kind === 'postgres') {
    const client = await adapter.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`
        INSERT INTO match_results (
          id, room_id, mode, winner, rounds, duration_ms, started_at, finished_at, party_chain_id, party_streak
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [
        id,
        roomId,
        normalizedMode,
        winner || null,
        rounds || 0,
        durationMs || null,
        startedAt || null,
        finishedAt || null,
        partyChainId || null,
        partyStreak || 0,
      ]);

      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return { id, roomId, mode: normalizedMode, duplicate: true, ratingUpdates: [] };
      }

      for (const player of matchPlayers) {
        await client.query(`
          INSERT INTO match_players (
            match_id, user_id, player_name, role, is_bot, survived, placement, night_kill_credits
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          id,
          player.userId || null,
          player.name,
          player.role || null,
          Boolean(player.isBot),
          Boolean(player.survived),
          player.placement || null,
          toNumber(player.nightKillCredits, 0),
        ]);
      }

      const ratingSnapshots = await getAgentRatingsMap(client, participantIds, normalizedMode);
      const ratingUpdates = calculateMatchRatingChanges(ratingMatch, ratingSnapshots);

      for (const update of ratingUpdates) {
        await client.query(`
          INSERT INTO agent_ratings (
            agent_id, mode, mmr, peak_mmr, rated_matches, last_delta, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (agent_id, mode) DO UPDATE
          SET mmr = EXCLUDED.mmr,
              peak_mmr = EXCLUDED.peak_mmr,
              rated_matches = EXCLUDED.rated_matches,
              last_delta = EXCLUDED.last_delta,
              updated_at = NOW()
        `, [
          update.id,
          normalizedMode,
          update.mmrAfter,
          update.peakMmrAfter,
          update.ratedMatchesAfter,
          update.delta,
        ]);

        await client.query(`
          INSERT INTO agent_rating_events (
            match_id, agent_id, mode, role, mmr_before, mmr_after, delta, expected_score, pool, provisional
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (match_id, agent_id) DO NOTHING
        `, [
          id,
          update.id,
          normalizedMode,
          update.role || null,
          update.mmrBefore,
          update.mmrAfter,
          update.delta,
          update.expectedScore,
          update.pool,
          update.isProvisional,
        ]);
      }

      await client.query('COMMIT');
      return { id, roomId, mode: normalizedMode, ratingUpdates };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const insertMatch = adapter.database.prepare(`
    INSERT OR IGNORE INTO match_results (
      id, room_id, mode, winner, rounds, duration_ms, started_at, finished_at, party_chain_id, party_streak
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlayer = adapter.database.prepare(`
    INSERT INTO match_players (
      match_id, user_id, player_name, role, is_bot, survived, placement, night_kill_credits
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertRating = adapter.database.prepare(`
    INSERT INTO agent_ratings (
      agent_id, mode, mmr, peak_mmr, rated_matches, last_delta, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(agent_id, mode) DO UPDATE SET
      mmr = excluded.mmr,
      peak_mmr = excluded.peak_mmr,
      rated_matches = excluded.rated_matches,
      last_delta = excluded.last_delta,
      updated_at = datetime('now')
  `);
  const insertRatingEvent = adapter.database.prepare(`
    INSERT OR IGNORE INTO agent_rating_events (
      match_id, agent_id, mode, role, mmr_before, mmr_after, delta, expected_score, pool, provisional
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let ratingUpdates = [];

  const transaction = adapter.database.transaction(() => {
    const result = insertMatch.run(
      id,
      roomId,
      normalizedMode,
      winner || null,
      rounds || 0,
      durationMs || null,
      startedAt || null,
      finishedAt || null,
      partyChainId || null,
      partyStreak || 0,
    );

    if (result.changes === 0) return;

    for (const player of matchPlayers) {
      insertPlayer.run(
        id,
        player.userId || null,
        player.name,
        player.role || null,
        player.isBot ? 1 : 0,
        player.survived ? 1 : 0,
        player.placement || null,
        toNumber(player.nightKillCredits, 0),
      );
    }

    const ratingSnapshots = getAgentRatingsMapSync(adapter.database, participantIds, normalizedMode);
    ratingUpdates = calculateMatchRatingChanges(ratingMatch, ratingSnapshots);

    for (const update of ratingUpdates) {
      upsertRating.run(
        update.id,
        normalizedMode,
        update.mmrAfter,
        update.peakMmrAfter,
        update.ratedMatchesAfter,
        update.delta,
      );
      insertRatingEvent.run(
        id,
        update.id,
        normalizedMode,
        update.role || null,
        update.mmrBefore,
        update.mmrAfter,
        update.delta,
        update.expectedScore,
        update.pool,
        update.isProvisional ? 1 : 0,
      );
    }
  });

  transaction();
  return { id, roomId, mode: normalizedMode, ratingUpdates };
}

async function getMatchesByUser(userId, limit = 20, offset = 0) {
  return getPlayerMatches(userId, limit, offset);
}

async function getPlayerMatches(userId, limit = 10, offset = 0) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none' || !userId) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const cappedOffset = Math.max(Number(offset) || 0, 0);

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT
        mr.id,
        mr.room_id,
        mr.mode,
        mr.winner,
        mr.rounds,
        mr.duration_ms,
        mr.started_at,
        mr.finished_at,
        mr.party_chain_id,
        mr.party_streak,
        mp.player_name,
        mp.role,
        mp.survived,
        mp.placement,
        mp.night_kill_credits
      FROM match_results mr
      JOIN match_players mp ON mp.match_id = mr.id
      WHERE mp.user_id = $1
      ORDER BY mr.finished_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, cappedLimit, cappedOffset]);
    return result.rows.map(normalizeMatchRow);
  }

  return adapter.database.prepare(`
    SELECT
      mr.id,
      mr.room_id,
      mr.mode,
      mr.winner,
      mr.rounds,
      mr.duration_ms,
      mr.started_at,
      mr.finished_at,
      mr.party_chain_id,
      mr.party_streak,
      mp.player_name,
      mp.role,
      mp.survived,
      mp.placement,
      mp.night_kill_credits
    FROM match_results mr
    JOIN match_players mp ON mp.match_id = mr.id
    WHERE mp.user_id = ?
    ORDER BY mr.finished_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, cappedLimit, cappedOffset).map(normalizeMatchRow);
}

async function getLeaderboardEntries({ mode = 'mafia', windowHours = null, limit = 25 } = {}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const normalizedMode = String(mode || MAFIA_ELO_MODE).trim().toLowerCase() || MAFIA_ELO_MODE;

  if (adapter.kind === 'postgres') {
    const params = [normalizedMode];
    let whereWindow = '';

    if (windowHours && Number(windowHours) > 0) {
      params.push(Number(windowHours));
      whereWindow = `AND mr.finished_at >= NOW() - ($${params.length} * INTERVAL '1 hour')`;
    }

    const result = await adapter.pool.query(`
      SELECT
        COALESCE(NULLIF(mp.user_id, ''), mp.player_name) AS id,
        MAX(mp.player_name) AS name,
        COUNT(*)::int AS games_played,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END)::int AS wins,
        SUM(CASE WHEN mp.survived THEN 1 ELSE 0 END)::int AS survivals,
        ROUND(AVG(mr.duration_ms))::int AS avg_duration_ms,
        MAX(mr.finished_at) AS last_played_at,
        COALESCE(MAX(ar.mmr), $${params.length + 1})::int AS mmr,
        COALESCE(MAX(ar.peak_mmr), COALESCE(MAX(ar.mmr), $${params.length + 1}))::int AS peak_mmr,
        COALESCE(MAX(ar.rated_matches), 0)::int AS rated_matches,
        COALESCE(MAX(ar.last_delta), 0)::int AS last_delta
      FROM match_players mp
      JOIN match_results mr ON mr.id = mp.match_id
      LEFT JOIN agent_ratings ar
        ON ar.agent_id = COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
       AND ar.mode = mr.mode
      WHERE mp.is_bot = FALSE
        AND mr.mode = $1
        ${whereWindow}
      GROUP BY COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
      ORDER BY mmr DESC, wins DESC, games_played DESC, last_played_at DESC
      LIMIT $${params.length + 2}
    `, [...params, DEFAULT_MMR, cappedLimit]);
    return result.rows.map((row) => ({
      ...row,
      avg_duration_ms: row.avg_duration_ms == null ? null : toNumber(row.avg_duration_ms),
      last_played_at: normalizeIso(row.last_played_at),
    }));
  }

  const params = [normalizedMode];
  let windowFilter = '';

  if (windowHours && Number(windowHours) > 0) {
    windowFilter = "AND mr.finished_at >= datetime('now', ?)";
    params.push(`-${Number(windowHours)} hours`);
  }

  return adapter.database.prepare(`
    SELECT
      COALESCE(NULLIF(mp.user_id, ''), mp.player_name) AS id,
      MAX(mp.player_name) AS name,
      COUNT(*) AS games_played,
      SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN mp.survived = 1 THEN 1 ELSE 0 END) AS survivals,
      ROUND(AVG(mr.duration_ms)) AS avg_duration_ms,
      MAX(mr.finished_at) AS last_played_at,
      COALESCE(MAX(ar.mmr), ?) AS mmr,
      COALESCE(MAX(ar.peak_mmr), COALESCE(MAX(ar.mmr), ?)) AS peak_mmr,
      COALESCE(MAX(ar.rated_matches), 0) AS rated_matches,
      COALESCE(MAX(ar.last_delta), 0) AS last_delta
    FROM match_players mp
    JOIN match_results mr ON mr.id = mp.match_id
    LEFT JOIN agent_ratings ar
      ON ar.agent_id = COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
     AND ar.mode = mr.mode
    WHERE mp.is_bot = 0
      AND mr.mode = ?
      ${windowFilter}
    GROUP BY COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
    ORDER BY mmr DESC, wins DESC, games_played DESC, last_played_at DESC
    LIMIT ?
  `).all(DEFAULT_MMR, DEFAULT_MMR, ...params, cappedLimit).map((row) => ({
    ...row,
    last_played_at: normalizeIso(row.last_played_at),
  }));
}

async function getMatchBaselineSummary({ mode = 'mafia' } = {}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return null;

  if (adapter.kind === 'postgres') {
    const aggregate = await adapter.pool.query(`
      SELECT
        COUNT(*)::int AS sample_size,
        ROUND(AVG(duration_ms))::int AS avg_duration_ms,
        MIN(duration_ms)::int AS fastest_duration_ms,
        MAX(duration_ms)::int AS slowest_duration_ms,
        MAX(finished_at) AS latest_completed_at
      FROM match_results
      WHERE mode = $1
        AND duration_ms IS NOT NULL
        AND duration_ms > 0
    `, [mode]);

    const row = aggregate.rows[0];
    if (!row || !toNumber(row.sample_size, 0)) return null;

    const latest = await adapter.pool.query(`
      SELECT room_id, finished_at
      FROM match_results
      WHERE mode = $1
        AND duration_ms IS NOT NULL
        AND duration_ms > 0
      ORDER BY finished_at DESC
      LIMIT 1
    `, [mode]);

    return {
      sampleSize: toNumber(row.sample_size, 0),
      avgDurationMs: row.avg_duration_ms == null ? null : toNumber(row.avg_duration_ms),
      fastestDurationMs: row.fastest_duration_ms == null ? null : toNumber(row.fastest_duration_ms),
      slowestDurationMs: row.slowest_duration_ms == null ? null : toNumber(row.slowest_duration_ms),
      latestCompletedRoomId: latest.rows[0]?.room_id || null,
      latestCompletedAt: normalizeIso(latest.rows[0]?.finished_at || row.latest_completed_at),
    };
  }

  const aggregate = adapter.database.prepare(`
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

  if (!aggregate || !toNumber(aggregate.sample_size, 0)) return null;

  const latest = adapter.database.prepare(`
    SELECT room_id, finished_at
    FROM match_results
    WHERE mode = ?
      AND duration_ms IS NOT NULL
      AND duration_ms > 0
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(mode);

  return {
    sampleSize: toNumber(aggregate.sample_size, 0),
    avgDurationMs: aggregate.avg_duration_ms == null ? null : toNumber(aggregate.avg_duration_ms),
    fastestDurationMs: aggregate.fastest_duration_ms == null ? null : toNumber(aggregate.fastest_duration_ms),
    slowestDurationMs: aggregate.slowest_duration_ms == null ? null : toNumber(aggregate.slowest_duration_ms),
    latestCompletedRoomId: latest?.room_id || null,
    latestCompletedAt: normalizeIso(latest?.finished_at || aggregate.latest_completed_at),
  };
}

async function getMatch(matchId) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none' || !matchId) return null;

  if (adapter.kind === 'postgres') {
    const matchResult = await adapter.pool.query('SELECT * FROM match_results WHERE id = $1 LIMIT 1', [matchId]);
    const match = matchResult.rows[0];
    if (!match) return null;
    const playersResult = await adapter.pool.query('SELECT * FROM match_players WHERE match_id = $1 ORDER BY placement ASC, id ASC', [matchId]);
    return {
      ...match,
      started_at: normalizeIso(match.started_at),
      finished_at: normalizeIso(match.finished_at),
      players: playersResult.rows.map((row) => normalizeMatchRow(row)),
    };
  }

  const match = adapter.database.prepare('SELECT * FROM match_results WHERE id = ?').get(matchId);
  if (!match) return null;
  return {
    ...match,
    started_at: normalizeIso(match.started_at),
    finished_at: normalizeIso(match.finished_at),
    players: adapter.database.prepare('SELECT * FROM match_players WHERE match_id = ? ORDER BY placement ASC, id ASC').all(matchId).map(normalizeMatchRow),
  };
}

async function getGlobalStats(mode) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT
        COUNT(DISTINCT mr.id)::int AS total_games,
        COUNT(DISTINCT CASE WHEN LOWER(COALESCE(mr.winner, '')) = 'town' THEN mr.id END)::int AS town_wins,
        COUNT(DISTINCT CASE WHEN mp.is_bot = FALSE THEN COALESCE(NULLIF(mp.user_id, ''), mp.player_name) END)::int AS unique_agents,
        COUNT(CASE WHEN mp.survived = FALSE THEN 1 END)::int AS total_eliminations,
        COUNT(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' AND mp.survived = FALSE THEN 1 END)::int AS mafias_caught
      FROM match_results mr
      LEFT JOIN match_players mp ON mr.id = mp.match_id
      WHERE mr.mode = $1
    `, [mode]);

    const row = result.rows[0] || {};
    return {
      totalGames: toNumber(row.total_games, 0),
      townWins: toNumber(row.town_wins, 0),
      uniqueAgents: toNumber(row.unique_agents, 0),
      totalEliminations: toNumber(row.total_eliminations, 0),
      mafiasCaught: toNumber(row.mafias_caught, 0),
    };
  }

  const row = adapter.database.prepare(`
    SELECT
      COUNT(DISTINCT mr.id) AS total_games,
      COUNT(DISTINCT CASE WHEN LOWER(COALESCE(mr.winner, '')) = 'town' THEN mr.id END) AS town_wins,
      COUNT(DISTINCT CASE WHEN mp.is_bot = 0 THEN COALESCE(NULLIF(mp.user_id,''), mp.player_name) END) AS unique_agents,
      COUNT(CASE WHEN mp.survived = 0 THEN 1 END) AS total_eliminations,
      COUNT(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' AND mp.survived = 0 THEN 1 END) AS mafias_caught
    FROM match_results mr
    LEFT JOIN match_players mp ON mr.id = mp.match_id
    WHERE mr.mode = ?
  `).get(mode);

  return {
    totalGames: toNumber(row?.total_games, 0),
    townWins: toNumber(row?.town_wins, 0),
    uniqueAgents: toNumber(row?.unique_agents, 0),
    totalEliminations: toNumber(row?.total_eliminations, 0),
    mafiasCaught: toNumber(row?.mafias_caught, 0),
  };
}

async function getAgentStats(agentId) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none' || !agentId) return null;
  const cleanAgentId = String(agentId || '').trim();

  let row = null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT
        COUNT(*)::int AS games_played,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END)::int AS wins,
        SUM(CASE WHEN mp.survived THEN 1 ELSE 0 END)::int AS survivals,
        SUM(CASE WHEN mp.survived = FALSE THEN 1 ELSE 0 END)::int AS eliminations_suffered,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' THEN 1 ELSE 0 END)::int AS mafia_games,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' AND LOWER(COALESCE(mr.winner, '')) = 'mafia' THEN 1 ELSE 0 END)::int AS mafia_wins,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'town' THEN 1 ELSE 0 END)::int AS town_games,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'town' AND LOWER(COALESCE(mr.winner, '')) = 'town' THEN 1 ELSE 0 END)::int AS town_wins,
        COALESCE(SUM(mp.night_kill_credits), 0)::int AS night_kill_credits,
        MAX(mr.finished_at) AS last_played_at
      FROM match_players mp
      JOIN match_results mr ON mr.id = mp.match_id
      WHERE COALESCE(NULLIF(mp.user_id, ''), mp.player_name) = $1
    `, [cleanAgentId]);
    row = result.rows[0] || null;
  } else {
    row = adapter.database.prepare(`
      SELECT
        COUNT(*) AS games_played,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN mp.survived = 1 THEN 1 ELSE 0 END) AS survivals,
        SUM(CASE WHEN mp.survived = 0 THEN 1 ELSE 0 END) AS eliminations_suffered,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' THEN 1 ELSE 0 END) AS mafia_games,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'mafia' AND LOWER(COALESCE(mr.winner, '')) = 'mafia' THEN 1 ELSE 0 END) AS mafia_wins,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'town' THEN 1 ELSE 0 END) AS town_games,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = 'town' AND LOWER(COALESCE(mr.winner, '')) = 'town' THEN 1 ELSE 0 END) AS town_wins,
        COALESCE(SUM(mp.night_kill_credits), 0) AS night_kill_credits,
        MAX(mr.finished_at) AS last_played_at
      FROM match_players mp
      JOIN match_results mr ON mr.id = mp.match_id
      WHERE COALESCE(NULLIF(mp.user_id, ''), mp.player_name) = ?
    `).get(cleanAgentId);
  }

  const rating = await getAgentRating(cleanAgentId, { mode: MAFIA_ELO_MODE });

  const gamesPlayed = toNumber(row?.games_played, 0);
  const wins = toNumber(row?.wins, 0);
  const survivals = toNumber(row?.survivals, 0);
  const mafiaGames = toNumber(row?.mafia_games, 0);
  const mafiaWins = toNumber(row?.mafia_wins, 0);
  const townGames = toNumber(row?.town_games, 0);
  const townWins = toNumber(row?.town_wins, 0);

  return {
    gamesPlayed,
    wins,
    losses: Math.max(0, gamesPlayed - wins),
    winRate: gamesPlayed ? Math.round((wins / gamesPlayed) * 100) : 0,
    survivals,
    survivalRate: gamesPlayed ? Math.round((survivals / gamesPlayed) * 100) : 0,
    eliminationsSuffered: toNumber(row?.eliminations_suffered, 0),
    mafiaGames,
    mafiaWins,
    townGames,
    townWins,
    nightKillCredits: toNumber(row?.night_kill_credits, 0),
    lastPlayedAt: normalizeIso(row?.last_played_at),
    mmr: rating.mmr,
    peakMmr: rating.peakMmr,
    ratedMatches: rating.ratedMatches,
    lastRatingDelta: rating.lastDelta,
    isProvisional: rating.isProvisional,
    byRole: {
      mafia: {
        gamesPlayed: mafiaGames,
        wins: mafiaWins,
      },
      town: {
        gamesPlayed: townGames,
        wins: townWins,
      },
    },
  };
}

async function getRatingHealth({ mode = MAFIA_ELO_MODE } = {}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return null;
  const normalizedMode = String(mode || MAFIA_ELO_MODE).trim().toLowerCase() || MAFIA_ELO_MODE;

  if (adapter.kind === 'postgres') {
    const [matchResult, ratingResult, deltaResult] = await Promise.all([
      adapter.pool.query(`
        SELECT
          COUNT(*)::int AS total_games,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(winner, '')) = 'town')::int AS town_wins,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(winner, '')) = 'mafia')::int AS mafia_wins
        FROM match_results
        WHERE mode = $1
      `, [normalizedMode]),
      adapter.pool.query(`
        SELECT
          ROUND(AVG(mmr))::int AS average_mmr,
          COUNT(*)::int AS rated_agents,
          COUNT(*) FILTER (WHERE rated_matches < $2)::int AS provisional_agents
        FROM agent_ratings
        WHERE mode = $1
      `, [normalizedMode, PROVISIONAL_MATCH_COUNT]),
      adapter.pool.query(`
        SELECT
          ROUND(AVG(CASE WHEN LOWER(COALESCE(role, '')) = 'town' THEN delta END)::numeric, 2) AS town_delta,
          ROUND(AVG(CASE WHEN LOWER(COALESCE(role, '')) = 'mafia' THEN delta END)::numeric, 2) AS mafia_delta,
          COUNT(DISTINCT match_id)::int AS rated_match_count
        FROM agent_rating_events
        WHERE mode = $1
      `, [normalizedMode]),
    ]);

    const matchRow = matchResult.rows[0] || {};
    const ratingRow = ratingResult.rows[0] || {};
    const deltaRow = deltaResult.rows[0] || {};
    const totalGames = toNumber(matchRow.total_games, 0);
    const ratedAgents = toNumber(ratingRow.rated_agents, 0);
    const provisionalAgents = toNumber(ratingRow.provisional_agents, 0);

    return {
      mode: normalizedMode,
      sampleSize: totalGames,
      ratedMatchCount: toNumber(deltaRow.rated_match_count, 0),
      townWinRate: totalGames ? Number(((toNumber(matchRow.town_wins, 0) / totalGames) * 100).toFixed(1)) : 0,
      mafiaWinRate: totalGames ? Number(((toNumber(matchRow.mafia_wins, 0) / totalGames) * 100).toFixed(1)) : 0,
      averageMmr: ratedAgents ? toNumber(ratingRow.average_mmr, DEFAULT_MMR) : DEFAULT_MMR,
      avgDeltaByRole: {
        town: deltaRow.town_delta == null ? null : Number(deltaRow.town_delta),
        mafia: deltaRow.mafia_delta == null ? null : Number(deltaRow.mafia_delta),
      },
      ratedAgents,
      provisionalAgents,
      provisionalShare: ratedAgents ? Number(((provisionalAgents / ratedAgents) * 100).toFixed(1)) : 0,
    };
  }

  const matchRow = adapter.database.prepare(`
    SELECT
      COUNT(*) AS total_games,
      COUNT(CASE WHEN LOWER(COALESCE(winner, '')) = 'town' THEN 1 END) AS town_wins,
      COUNT(CASE WHEN LOWER(COALESCE(winner, '')) = 'mafia' THEN 1 END) AS mafia_wins
    FROM match_results
    WHERE mode = ?
  `).get(normalizedMode) || {};
  const ratingRow = adapter.database.prepare(`
    SELECT
      ROUND(AVG(mmr)) AS average_mmr,
      COUNT(*) AS rated_agents,
      COUNT(CASE WHEN rated_matches < ? THEN 1 END) AS provisional_agents
    FROM agent_ratings
    WHERE mode = ?
  `).get(PROVISIONAL_MATCH_COUNT, normalizedMode) || {};
  const deltaRow = adapter.database.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN LOWER(COALESCE(role, '')) = 'town' THEN delta END), 2) AS town_delta,
      ROUND(AVG(CASE WHEN LOWER(COALESCE(role, '')) = 'mafia' THEN delta END), 2) AS mafia_delta,
      COUNT(DISTINCT match_id) AS rated_match_count
    FROM agent_rating_events
    WHERE mode = ?
  `).get(normalizedMode) || {};

  const totalGames = toNumber(matchRow.total_games, 0);
  const ratedAgents = toNumber(ratingRow.rated_agents, 0);
  const provisionalAgents = toNumber(ratingRow.provisional_agents, 0);

  return {
    mode: normalizedMode,
    sampleSize: totalGames,
    ratedMatchCount: toNumber(deltaRow.rated_match_count, 0),
    townWinRate: totalGames ? Number(((toNumber(matchRow.town_wins, 0) / totalGames) * 100).toFixed(1)) : 0,
    mafiaWinRate: totalGames ? Number(((toNumber(matchRow.mafia_wins, 0) / totalGames) * 100).toFixed(1)) : 0,
    averageMmr: ratedAgents ? toNumber(ratingRow.average_mmr, DEFAULT_MMR) : DEFAULT_MMR,
    avgDeltaByRole: {
      town: deltaRow.town_delta == null ? null : Number(deltaRow.town_delta),
      mafia: deltaRow.mafia_delta == null ? null : Number(deltaRow.mafia_delta),
    },
    ratedAgents,
    provisionalAgents,
    provisionalShare: ratedAgents ? Number(((provisionalAgents / ratedAgents) * 100).toFixed(1)) : 0,
  };
}

async function createReport({ reporterId, roomId, targetPlayer, messageText, reason }) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return;

  if (adapter.kind === 'postgres') {
    await adapter.pool.query(`
      INSERT INTO reports (reporter_id, room_id, target_player, message_text, reason)
      VALUES ($1, $2, $3, $4, $5)
    `, [reporterId || null, roomId, targetPlayer, messageText || null, reason || 'inappropriate']);
    return;
  }

  adapter.database.prepare(`
    INSERT INTO reports (reporter_id, room_id, target_player, message_text, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(reporterId || null, roomId, targetPlayer, messageText || null, reason || 'inappropriate');
}

async function getReports({ status, limit } = {}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  if (adapter.kind === 'postgres') {
    if (status) {
      const result = await adapter.pool.query(
        'SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
        [status, cappedLimit],
      );
      return result.rows.map(normalizeReportRow);
    }
    const result = await adapter.pool.query(
      'SELECT * FROM reports ORDER BY created_at DESC LIMIT $1',
      [cappedLimit],
    );
    return result.rows.map(normalizeReportRow);
  }

  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status, cappedLimit] : [cappedLimit];
  return adapter.database.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ?`).all(...params).map(normalizeReportRow);
}

const VALID_REPORT_STATUSES = ['pending', 'reviewed', 'actioned', 'dismissed'];

async function updateReportStatus(id, status) {
  if (!VALID_REPORT_STATUSES.includes(status)) return;
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return;

  if (adapter.kind === 'postgres') {
    await adapter.pool.query('UPDATE reports SET status = $1 WHERE id = $2', [status, id]);
    return;
  }

  adapter.database.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
}

async function getDatabaseHealth() {
  const adapter = await ensureDb();

  if (!adapter) {
    return {
      driver: 'none',
      status: 'unavailable',
    };
  }

  if (adapter.kind === 'none') {
    return {
      driver: adapter.driver || 'none',
      status: adapter.error ? 'error' : 'unavailable',
      error: adapter.error?.message,
    };
  }

  if (adapter.kind === 'postgres') {
    try {
      await adapter.pool.query('SELECT 1');
      return {
        driver: 'postgres',
        status: 'ok',
      };
    } catch (error) {
      return {
        driver: 'postgres',
        status: 'error',
        error: error.message,
      };
    }
  }

  try {
    const integrityCheck = adapter.database.pragma('integrity_check');
    return {
      driver: 'sqlite',
      status: integrityCheck[0]?.integrity_check === 'ok' ? 'ok' : 'degraded',
    };
  } catch (error) {
    return {
      driver: 'sqlite',
      status: 'error',
      error: error.message,
    };
  }
}

module.exports = {
  getDb,
  initDb,
  closeDb,
  createAnonymousUser,
  upgradeUser,
  getUserByToken,
  getUserById,
  getUserByEmail,
  setUserAgentId,
  createSession,
  getSessionByToken,
  deleteSessionByToken,
  createMagicLink,
  getMagicLinkByTokenHash,
  consumeMagicLink,
  rotateOwnerToken,
  getOwnerTokenByHash,
  touchOwnerToken,
  recordMatch,
  getMatchesByUser,
  getPlayerMatches,
  getLeaderboardEntries,
  getMatchBaselineSummary,
  getMatch,
  getGlobalStats,
  getAgentStats,
  getRatingHealth,
  createReport,
  getReports,
  updateReportStatus,
  getDatabaseHealth,
  currentAdapter,
};
