const path = require('path');
const fs = require('fs');

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

function warnUnavailable(message) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(message);
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

function normalizeReportRow(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
  };
}

async function createAnonymousUser(id) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return { id, is_anonymous: true };

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
  if (displayName && (typeof displayName !== 'string' || displayName.length > 32)) displayName = typeof displayName === 'string' ? displayName.slice(0, 32) : undefined;
  if (agentId && (typeof agentId !== 'string' || agentId.length > 64)) agentId = typeof agentId === 'string' ? agentId.slice(0, 64) : undefined;

  if (!adapter || adapter.kind === 'none') {
    return normalizeUserRow({
      id: userId,
      email: email || null,
      display_name: displayName || null,
      agent_id: agentId || null,
      is_anonymous: false,
      updated_at: new Date().toISOString(),
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
  if (!adapter || adapter.kind === 'none' || !userId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    return normalizeUserRow(result.rows[0] || null);
  }

  return normalizeUserRow(adapter.database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

async function setUserAgentId(userId, agentId) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    return normalizeUserRow({
      id: userId,
      agent_id: agentId || null,
      updated_at: new Date().toISOString(),
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
  if (!adapter || adapter.kind === 'none') return fallback;

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
}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return { id, roomId, mode };

  const matchPlayers = Array.isArray(players) ? players : [];

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
        mode,
        winner || null,
        rounds || 0,
        durationMs || null,
        startedAt || null,
        finishedAt || null,
        partyChainId || null,
        partyStreak || 0,
      ]);

      if (inserted.rowCount > 0) {
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
      }

      await client.query('COMMIT');
      return { id, roomId, mode };
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

  const transaction = adapter.database.transaction(() => {
    const result = insertMatch.run(
      id,
      roomId,
      mode,
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
  });

  transaction();
  return { id, roomId, mode };
}

async function getMatchesByUser(userId, limit = 20) {
  return getPlayerMatches(userId, limit);
}

async function getPlayerMatches(userId, limit = 10) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none' || !userId) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);

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
      LIMIT $2
    `, [userId, cappedLimit]);
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
    LIMIT ?
  `).all(userId, cappedLimit).map(normalizeMatchRow);
}

async function getLeaderboardEntries({ mode = 'mafia', windowHours = null, limit = 25 } = {}) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  if (adapter.kind === 'postgres') {
    const params = [mode];
    let whereWindow = '';

    if (windowHours && Number(windowHours) > 0) {
      params.push(Number(windowHours));
      whereWindow = `AND mr.finished_at >= NOW() - ($${params.length} * INTERVAL '1 hour')`;
    }

    params.push(cappedLimit);
    const result = await adapter.pool.query(`
      SELECT
        COALESCE(NULLIF(mp.user_id, ''), mp.player_name) AS id,
        MAX(mp.player_name) AS name,
        COUNT(*)::int AS games_played,
        SUM(CASE WHEN LOWER(COALESCE(mp.role, '')) = LOWER(COALESCE(mr.winner, '')) THEN 1 ELSE 0 END)::int AS wins,
        SUM(CASE WHEN mp.survived THEN 1 ELSE 0 END)::int AS survivals,
        ROUND(AVG(mr.duration_ms))::int AS avg_duration_ms,
        MAX(mr.finished_at) AS last_played_at
      FROM match_players mp
      JOIN match_results mr ON mr.id = mp.match_id
      WHERE mp.is_bot = FALSE
        AND mr.mode = $1
        ${whereWindow}
      GROUP BY COALESCE(NULLIF(mp.user_id, ''), mp.player_name)
      ORDER BY wins DESC, games_played DESC, survivals DESC, last_played_at DESC
      LIMIT $${params.length}
    `, params);
    return result.rows.map((row) => ({
      ...row,
      avg_duration_ms: row.avg_duration_ms == null ? null : toNumber(row.avg_duration_ms),
      last_played_at: normalizeIso(row.last_played_at),
    }));
  }

  const params = [mode];
  let windowFilter = '';

  if (windowHours && Number(windowHours) > 0) {
    windowFilter = "AND mr.finished_at >= datetime('now', ?)";
    params.push(`-${Number(windowHours)} hours`);
  }

  params.push(cappedLimit);

  return adapter.database.prepare(`
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
  `).all(...params).map((row) => ({
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
      WHERE mp.user_id = $1
    `, [agentId]);
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
      WHERE mp.user_id = ?
    `).get(agentId);
  }

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
  setUserAgentId,
  createSession,
  getSessionByToken,
  recordMatch,
  getMatchesByUser,
  getPlayerMatches,
  getLeaderboardEntries,
  getMatchBaselineSummary,
  getMatch,
  getGlobalStats,
  getAgentStats,
  createReport,
  getReports,
  updateReportStatus,
  getDatabaseHealth,
  currentAdapter,
};
