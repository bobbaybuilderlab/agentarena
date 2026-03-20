const path = require('path');
const fs = require('fs');
const { hashSecret } = require('../services/secret-tokens');
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
const DEFAULT_RETENTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

let dbState = null;
let initPromise = null;
let warnedUnavailable = false;
const fallbackUsers = new Map();
const fallbackSessions = new Map();
const fallbackAgents = new Map();
const fallbackRuntimeCredentials = new Map();
const fallbackConnectSessions = new Map();
const fallbackMagicLinkTokens = new Map();
const fallbackMetricCounters = new Map();
const fallbackUserDailyMatchUsage = new Map();
const fallbackOpsSnapshots = new Map();
const fallbackKpiRoomEvents = new Map();

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
  return { database, resolvedPath };
}

async function backfillSessionTokenHashes(adapter) {
  if (!adapter || adapter.kind === 'none') return;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT id, token
      FROM sessions
      WHERE token IS NOT NULL
        AND BTRIM(token) <> ''
        AND COALESCE(BTRIM(token_hash), '') = ''
    `);
    for (const row of result.rows) {
      await adapter.pool.query(
        'UPDATE sessions SET token_hash = $1, token = NULL WHERE id = $2',
        [hashSecret(row.token), row.id],
      );
    }
    return;
  }

  const rows = adapter.database.prepare(`
    SELECT id, token
    FROM sessions
    WHERE token IS NOT NULL
      AND TRIM(token) <> ''
      AND COALESCE(TRIM(token_hash), '') = ''
  `).all();
  if (!rows.length) return;

  const update = adapter.database.prepare('UPDATE sessions SET token_hash = ?, token = NULL WHERE id = ?');
  const transaction = adapter.database.transaction((pending) => {
    for (const row of pending) {
      update.run(hashSecret(row.token), row.id);
    }
  });
  transaction(rows);
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
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && !databaseUrl) {
      throw new Error('[db] DATABASE_URL is required when NODE_ENV=production');
    }

    if (databaseUrl) {
      if (!PgPool) {
        if (isProduction) {
          throw new Error('[db] DATABASE_URL is set, but the `pg` package is unavailable.');
        }
        warnUnavailable('[db] DATABASE_URL is set, but the `pg` package is unavailable. Falling back to in-memory persistence.');
        dbState = { kind: 'none', driver: 'none' };
        return null;
      }

      const pool = new PgPool({ connectionString: databaseUrl });
      try {
        await pool.query(readSchema(POSTGRES_SCHEMA_PATH));
        dbState = { kind: 'postgres', driver: 'postgres', pool };
        await backfillSessionTokenHashes(dbState);
        return pool;
      } catch (error) {
        if (isProduction) {
          throw new Error(`[db] Postgres initialization failed: ${error.message}`);
        }
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
      const { database, resolvedPath } = openSqliteDatabase(dbPath);
      const { runMigrations } = require('./migrate');
      runMigrations(database);
      dbState = { kind: 'sqlite', driver: 'sqlite', database, databasePath: resolvedPath };
      await backfillSessionTokenHashes(dbState);
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

function normalizeUsageDate(value, fallback = new Date().toISOString().slice(0, 10)) {
  const normalized = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10);
}

function normalizeUserDailyMatchUsageRow(row) {
  if (!row) return null;
  return {
    ...row,
    user_id: String(row.user_id || row.userId || '').trim() || null,
    userId: String(row.user_id || row.userId || '').trim() || null,
    usage_date: normalizeUsageDate(row.usage_date || row.usageDate),
    usageDate: normalizeUsageDate(row.usage_date || row.usageDate),
    matches_started: toNumber(row.matches_started, 0),
    matchesStarted: toNumber(row.matches_started, 0),
    last_match_started_at: normalizeIso(row.last_match_started_at) || row.last_match_started_at || null,
    lastMatchStartedAt: normalizeIso(row.last_match_started_at) || row.last_match_started_at || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    updated_at: normalizeIso(row.updated_at) || row.updated_at || null,
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
    agent_id: row.agent_id || row.agentId || null,
    agentId: row.agent_id || row.agentId || null,
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

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function stringifyJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return null;
  }
}

function normalizeAgentNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAgentRow(row) {
  if (!row) return null;
  const persona = parseJsonObject(row.persona_json || row.personaJson);
  return {
    ...row,
    owner_user_id: row.owner_user_id || row.ownerUserId || null,
    ownerUserId: row.owner_user_id || row.ownerUserId || null,
    owner_email: row.owner_email || row.ownerEmail || null,
    ownerEmail: row.owner_email || row.ownerEmail || null,
    name_normalized: row.name_normalized || row.nameNormalized || null,
    nameNormalized: row.name_normalized || row.nameNormalized || null,
    source: row.source || 'openclaw',
    lifecycle_state: row.lifecycle_state || row.lifecycleState || 'active',
    lifecycleState: row.lifecycle_state || row.lifecycleState || 'active',
    deployed: toBoolean(row.deployed),
    karma: toNumber(row.karma, 0),
    persona_json: row.persona_json || row.personaJson || null,
    personaJson: row.persona_json || row.personaJson || null,
    persona,
    openclaw_note: row.openclaw_note || row.openclawNote || null,
    openclawNote: row.openclaw_note || row.openclawNote || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    updated_at: normalizeIso(row.updated_at) || row.updated_at || null,
    last_connected_at: normalizeIso(row.last_connected_at) || row.last_connected_at || null,
    lastConnectedAt: normalizeIso(row.last_connected_at) || row.last_connected_at || null,
    archived_at: normalizeIso(row.archived_at) || row.archivedAt || null,
    archivedAt: normalizeIso(row.archived_at) || row.archivedAt || null,
  };
}

function normalizeRuntimeCredentialRow(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    last_used_at: normalizeIso(row.last_used_at) || row.last_used_at || null,
    revoked_at: normalizeIso(row.revoked_at) || row.revoked_at || null,
  };
}

function normalizeConnectSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    owner_user_id: row.owner_user_id || row.ownerUserId || null,
    ownerUserId: row.owner_user_id || row.ownerUserId || null,
    email_snapshot: row.email_snapshot || row.emailSnapshot || null,
    emailSnapshot: row.email_snapshot || row.emailSnapshot || null,
    callback_url: row.callback_url || row.callbackUrl || null,
    callbackUrl: row.callback_url || row.callbackUrl || null,
    access_token_hash: row.access_token_hash || row.accessTokenHash || null,
    accessTokenHash: row.access_token_hash || row.accessTokenHash || null,
    callback_proof_hash: row.callback_proof_hash || row.callbackProofHash || null,
    callbackProofHash: row.callback_proof_hash || row.callbackProofHash || null,
    agent_id: row.agent_id || row.agentId || null,
    agentId: row.agent_id || row.agentId || null,
    agent_name: row.agent_name || row.agentName || null,
    agentName: row.agent_name || row.agentName || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    expires_at: normalizeIso(row.expires_at) || row.expires_at || null,
    connected_at: normalizeIso(row.connected_at) || row.connected_at || null,
  };
}

function normalizeMagicLinkTokenRow(row) {
  if (!row) return null;
  return {
    ...row,
    source_user_id: row.source_user_id || row.sourceUserId || null,
    sourceUserId: row.source_user_id || row.sourceUserId || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    expires_at: normalizeIso(row.expires_at) || row.expires_at || null,
    consumed_at: normalizeIso(row.consumed_at) || row.consumed_at || null,
  };
}

function normalizeMetricCounterRow(row) {
  if (!row) return null;
  return {
    metric_key: row.metric_key || row.metricKey || null,
    metricKey: row.metric_key || row.metricKey || null,
    value: toNumber(row.value, 0),
    updated_at: normalizeIso(row.updated_at) || row.updated_at || null,
    updatedAt: normalizeIso(row.updated_at) || row.updatedAt || null,
  };
}

function normalizeOpsSnapshotRow(row) {
  if (!row) return null;
  return {
    name: row.name || null,
    payload_json: stringifyJson(parseJsonObject(row.payload_json || row.payloadJson) || {}),
    payload: parseJsonObject(row.payload_json || row.payloadJson) || {},
    updated_at: normalizeIso(row.updated_at) || row.updated_at || null,
    updatedAt: normalizeIso(row.updated_at) || row.updatedAt || null,
  };
}

function normalizeKpiRoomEventRow(row) {
  if (!row) return null;
  return {
    id: row.id == null ? null : toNumber(row.id, null),
    mode: String(row.mode || '').toLowerCase() || null,
    room_id: String(row.room_id || row.roomId || '').toUpperCase() || null,
    roomId: String(row.room_id || row.roomId || '').toUpperCase() || null,
    type: String(row.type || '').trim() || null,
    created_at: normalizeIso(row.created_at) || row.created_at || null,
    createdAt: normalizeIso(row.created_at) || row.createdAt || null,
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

function normalizeMetricCounterKey(metricKey) {
  return String(metricKey || '').trim();
}

async function incrementMetricCounter(metricKey, amount = 1) {
  const adapter = await ensureDb();
  const cleanKey = normalizeMetricCounterKey(metricKey);
  const delta = Math.trunc(Number(amount) || 0);
  if (!cleanKey || !delta) return normalizeMetricCounterRow({ metric_key: cleanKey, value: 0 });

  if (!adapter || adapter.kind === 'none') {
    const existing = normalizeMetricCounterRow(fallbackMetricCounters.get(cleanKey) || { metric_key: cleanKey, value: 0 });
    const row = normalizeMetricCounterRow({
      metric_key: cleanKey,
      value: Math.max(0, existing.value + delta),
      updated_at: new Date().toISOString(),
    });
    fallbackMetricCounters.set(cleanKey, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO metric_counters (metric_key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (metric_key) DO UPDATE
      SET value = GREATEST(0, metric_counters.value + EXCLUDED.value),
          updated_at = NOW()
      RETURNING *
    `, [cleanKey, delta]);
    return normalizeMetricCounterRow(result.rows[0] || { metric_key: cleanKey, value: 0 });
  }

  adapter.database.prepare(`
    INSERT INTO metric_counters (metric_key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(metric_key) DO UPDATE SET
      value = MAX(0, metric_counters.value + excluded.value),
      updated_at = datetime('now')
  `).run(cleanKey, delta);
  return normalizeMetricCounterRow(
    adapter.database.prepare('SELECT * FROM metric_counters WHERE metric_key = ? LIMIT 1').get(cleanKey) || { metric_key: cleanKey, value: 0 },
  );
}

async function getMetricCounters(metricKeys = []) {
  const adapter = await ensureDb();
  const keys = [...new Set((Array.isArray(metricKeys) ? metricKeys : [metricKeys]).map(normalizeMetricCounterKey).filter(Boolean))];
  const counters = Object.create(null);
  for (const key of keys) counters[key] = 0;

  if (!adapter || adapter.kind === 'none') {
    if (!keys.length) {
      for (const [key, row] of fallbackMetricCounters.entries()) {
        counters[key] = normalizeMetricCounterRow(row).value;
      }
      return counters;
    }
    for (const key of keys) {
      counters[key] = normalizeMetricCounterRow(fallbackMetricCounters.get(key) || { metric_key: key, value: 0 }).value;
    }
    return counters;
  }

  if (adapter.kind === 'postgres') {
    const result = keys.length
      ? await adapter.pool.query(
        'SELECT * FROM metric_counters WHERE metric_key = ANY($1::text[])',
        [keys],
      )
      : await adapter.pool.query('SELECT * FROM metric_counters');

    for (const row of result.rows || []) {
      const normalized = normalizeMetricCounterRow(row);
      if (!normalized?.metricKey) continue;
      counters[normalized.metricKey] = normalized.value;
    }
    return counters;
  }

  const rows = keys.length
    ? adapter.database.prepare(`
      SELECT *
      FROM metric_counters
      WHERE metric_key IN (${keys.map(() => '?').join(', ')})
    `).all(...keys)
    : adapter.database.prepare('SELECT * FROM metric_counters').all();

  for (const row of rows) {
    const normalized = normalizeMetricCounterRow(row);
    if (!normalized?.metricKey) continue;
    counters[normalized.metricKey] = normalized.value;
  }
  return counters;
}

async function saveOpsSnapshot(name, payload) {
  const adapter = await ensureDb();
  const cleanName = String(name || '').trim();
  const payloadJson = stringifyJson(payload || {});
  if (!cleanName || !payloadJson) return null;

  if (!adapter || adapter.kind === 'none') {
    const row = normalizeOpsSnapshotRow({
      name: cleanName,
      payload_json: payloadJson,
      updated_at: new Date().toISOString(),
    });
    fallbackOpsSnapshots.set(cleanName, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO ops_snapshots (name, payload_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (name) DO UPDATE
      SET payload_json = EXCLUDED.payload_json,
          updated_at = NOW()
      RETURNING name, payload_json::text AS payload_json, updated_at
    `, [cleanName, payloadJson]);
    return normalizeOpsSnapshotRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO ops_snapshots (name, payload_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = datetime('now')
  `).run(cleanName, payloadJson);
  return normalizeOpsSnapshotRow(
    adapter.database.prepare('SELECT * FROM ops_snapshots WHERE name = ? LIMIT 1').get(cleanName),
  );
}

async function getOpsSnapshot(name) {
  const adapter = await ensureDb();
  const cleanName = String(name || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanName) {
    return normalizeOpsSnapshotRow(fallbackOpsSnapshots.get(cleanName) || null);
  }
  if (!adapter || adapter.kind === 'none' || !cleanName) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT name, payload_json::text AS payload_json, updated_at FROM ops_snapshots WHERE name = $1 LIMIT 1',
      [cleanName],
    );
    return normalizeOpsSnapshotRow(result.rows[0] || null);
  }

  return normalizeOpsSnapshotRow(
    adapter.database.prepare('SELECT * FROM ops_snapshots WHERE name = ? LIMIT 1').get(cleanName),
  );
}

function kpiRoomEventKey(mode, roomId, type) {
  const cleanMode = String(mode || '').toLowerCase().trim();
  const cleanRoomId = String(roomId || '').toUpperCase().trim();
  const cleanType = String(type || '').trim();
  if (!cleanMode || !cleanRoomId || !cleanType) return '';
  return `${cleanMode}:${cleanRoomId}:${cleanType}`;
}

async function recordKpiRoomEvent({ mode, roomId, type, createdAt } = {}) {
  const adapter = await ensureDb();
  const cleanMode = String(mode || '').toLowerCase().trim();
  const cleanRoomId = String(roomId || '').toUpperCase().trim();
  const cleanType = String(type || '').trim();
  const normalizedCreatedAt = normalizeIso(createdAt) || new Date().toISOString();
  const key = kpiRoomEventKey(cleanMode, cleanRoomId, cleanType);
  if (!key) return null;

  if (!adapter || adapter.kind === 'none') {
    if (!fallbackKpiRoomEvents.has(key)) {
      fallbackKpiRoomEvents.set(key, normalizeKpiRoomEventRow({
        id: fallbackKpiRoomEvents.size + 1,
        mode: cleanMode,
        room_id: cleanRoomId,
        type: cleanType,
        created_at: normalizedCreatedAt,
      }));
    }
    return normalizeKpiRoomEventRow(fallbackKpiRoomEvents.get(key));
  }

  if (adapter.kind === 'postgres') {
    await adapter.pool.query(`
      INSERT INTO kpi_room_events (mode, room_id, type, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (mode, room_id, type) DO NOTHING
    `, [cleanMode, cleanRoomId, cleanType, normalizedCreatedAt]);
    const result = await adapter.pool.query(`
      SELECT *
      FROM kpi_room_events
      WHERE mode = $1 AND room_id = $2 AND type = $3
      LIMIT 1
    `, [cleanMode, cleanRoomId, cleanType]);
    return normalizeKpiRoomEventRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT OR IGNORE INTO kpi_room_events (mode, room_id, type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(cleanMode, cleanRoomId, cleanType, normalizedCreatedAt);
  return normalizeKpiRoomEventRow(
    adapter.database.prepare(`
      SELECT *
      FROM kpi_room_events
      WHERE mode = ? AND room_id = ? AND type = ?
      LIMIT 1
    `).get(cleanMode, cleanRoomId, cleanType),
  );
}

async function listKpiRoomEvents() {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    return [...fallbackKpiRoomEvents.values()]
      .map(normalizeKpiRoomEventRow)
      .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT *
      FROM kpi_room_events
      ORDER BY created_at ASC, id ASC
    `);
    return result.rows.map(normalizeKpiRoomEventRow);
  }

  return adapter.database.prepare(`
    SELECT *
    FROM kpi_room_events
    ORDER BY created_at ASC, id ASC
  `).all().map(normalizeKpiRoomEventRow);
}

async function createAnonymousUser(id) {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    const existing = fallbackUsers.get(id);
    if (existing) return normalizeUserRow(existing);
    const row = {
      id,
      email: null,
      display_name: null,
      agent_id: null,
      is_anonymous: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fallbackUsers.set(id, row);
    return normalizeUserRow(row);
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
    const existing = fallbackUsers.get(userId) || {
      id: userId,
      email: null,
      display_name: null,
      agent_id: null,
      is_anonymous: true,
      created_at: new Date().toISOString(),
    };
    const row = normalizeUserRow({
      ...existing,
      email: email || existing.email || null,
      display_name: displayName || existing.display_name || null,
      agent_id: agentId || existing.agent_id || null,
      is_anonymous: false,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
    });
    fallbackUsers.set(userId, row);
    return row;
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
    const session = fallbackSessions.get(token);
    if (!session) return null;
    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      fallbackSessions.delete(token);
      return null;
    }
    return normalizeUserRow(fallbackUsers.get(session.user_id) || null);
  }
  if (!adapter || adapter.kind === 'none' || !token) return null;
  const tokenHash = hashSecret(token);

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT u.* FROM users u
      JOIN sessions s ON s.user_id = u.id
      WHERE (s.token_hash = $1 OR s.token = $2) AND s.expires_at > NOW()
      LIMIT 1
    `, [tokenHash, token]);
    return normalizeUserRow(result.rows[0] || null);
  }

  return normalizeUserRow(adapter.database.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE (s.token_hash = ? OR s.token = ?) AND s.expires_at > datetime('now')
  `).get(tokenHash, token));
}

async function getUserById(userId) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && userId) {
    return normalizeUserRow(fallbackUsers.get(userId) || null);
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
  const cleanEmail = String(email || '').trim().toLowerCase();
  if ((!adapter || adapter.kind === 'none') && cleanEmail) {
    for (const row of fallbackUsers.values()) {
      if (String(row.email || '').trim().toLowerCase() === cleanEmail) return normalizeUserRow(row);
    }
    return null;
  }
  if (!adapter || adapter.kind === 'none' || !cleanEmail) return null;

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
    const existing = fallbackUsers.get(userId) || {
      id: userId,
      email: null,
      display_name: null,
      is_anonymous: true,
      created_at: new Date().toISOString(),
    };
    const row = normalizeUserRow({
      ...existing,
      agent_id: agentId || null,
      is_anonymous: existing?.is_anonymous !== false,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
    });
    fallbackUsers.set(userId, row);
    return row;
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
  const tokenHash = hashSecret(token);
  const fallback = normalizeSessionRow({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
  if (!adapter || adapter.kind === 'none') {
    fallbackSessions.set(token, fallback);
    return fallback;
  }

  if (adapter.kind === 'postgres') {
    await adapter.pool.query(
      'INSERT INTO sessions (id, user_id, token, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [id, userId, null, tokenHash, expiresAt],
    );
    return fallback;
  }

  adapter.database.prepare(
    'INSERT INTO sessions (id, user_id, token, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, null, tokenHash, expiresAt);
  return fallback;
}

async function getSessionByToken(token) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && token) {
    const session = fallbackSessions.get(token);
    if (!session) return null;
    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      fallbackSessions.delete(token);
      return null;
    }
    return normalizeSessionRow(session);
  }
  if (!adapter || adapter.kind === 'none' || !token) return null;
  const tokenHash = hashSecret(token);

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM sessions WHERE (token_hash = $1 OR token = $2) AND expires_at > NOW() LIMIT 1',
      [tokenHash, token],
    );
    return normalizeSessionRow(result.rows[0] || null);
  }

  return normalizeSessionRow(adapter.database.prepare(
    "SELECT * FROM sessions WHERE (token_hash = ? OR token = ?) AND expires_at > datetime('now')",
  ).get(tokenHash, token));
}

async function deleteSessionsByUserId(userId) {
  const adapter = await ensureDb();
  if ((!adapter || adapter.kind === 'none') && userId) {
    let deleted = 0;
    for (const [token, session] of fallbackSessions.entries()) {
      if (session.user_id === userId) {
        fallbackSessions.delete(token);
        deleted += 1;
      }
    }
    return deleted;
  }
  if (!adapter || adapter.kind === 'none' || !userId) return 0;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return toNumber(result.rowCount, 0);
  }

  const result = adapter.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return toNumber(result.changes, 0);
}

async function getUserDailyMatchUsage(userId, {
  usageDate = normalizeUsageDate(),
} = {}) {
  const adapter = await ensureDb();
  const cleanUserId = String(userId || '').trim();
  const cleanUsageDate = normalizeUsageDate(usageDate);
  if (!cleanUserId) return null;

  if (!adapter || adapter.kind === 'none') {
    return normalizeUserDailyMatchUsageRow(
      fallbackUserDailyMatchUsage.get(`${cleanUserId}:${cleanUsageDate}`) || null,
    );
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT *
      FROM user_daily_match_usage
      WHERE user_id = $1
        AND usage_date = $2
      LIMIT 1
    `, [cleanUserId, cleanUsageDate]);
    return normalizeUserDailyMatchUsageRow(result.rows[0] || null);
  }

  const row = adapter.database.prepare(`
    SELECT *
    FROM user_daily_match_usage
    WHERE user_id = ?
      AND usage_date = ?
    LIMIT 1
  `).get(cleanUserId, cleanUsageDate);
  return normalizeUserDailyMatchUsageRow(row || null);
}

async function getUserDailyMatchUsages(userIds = [], {
  usageDate = normalizeUsageDate(),
} = {}) {
  const adapter = await ensureDb();
  const cleanUsageDate = normalizeUsageDate(usageDate);
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).map((value) => String(value || '').trim()).filter(Boolean))];
  const usageByUserId = new Map();

  if (!ids.length) return usageByUserId;

  if (!adapter || adapter.kind === 'none') {
    for (const userId of ids) {
      const row = normalizeUserDailyMatchUsageRow(
        fallbackUserDailyMatchUsage.get(`${userId}:${cleanUsageDate}`) || null,
      );
      if (row?.userId) usageByUserId.set(row.userId, row);
    }
    return usageByUserId;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT *
      FROM user_daily_match_usage
      WHERE usage_date = $1
        AND user_id = ANY($2::text[])
    `, [cleanUsageDate, ids]);
    for (const row of result.rows || []) {
      const normalized = normalizeUserDailyMatchUsageRow(row);
      if (normalized?.userId) usageByUserId.set(normalized.userId, normalized);
    }
    return usageByUserId;
  }

  const rows = adapter.database.prepare(`
    SELECT *
    FROM user_daily_match_usage
    WHERE usage_date = ?
      AND user_id IN (${ids.map(() => '?').join(', ')})
  `).all(cleanUsageDate, ...ids);
  for (const row of rows || []) {
    const normalized = normalizeUserDailyMatchUsageRow(row);
    if (normalized?.userId) usageByUserId.set(normalized.userId, normalized);
  }
  return usageByUserId;
}

async function consumeUserDailyMatchQuota(userId, {
  limit = 25,
  usageDate = normalizeUsageDate(),
  now = Date.now(),
} = {}) {
  const adapter = await ensureDb();
  const cleanUserId = String(userId || '').trim();
  const cleanUsageDate = normalizeUsageDate(usageDate);
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  const startedAtIso = normalizeIso(now) || nowIso();
  if (!cleanUserId) {
    return { allowed: false, row: null };
  }
  if (safeLimit <= 0) {
    return {
      allowed: false,
      row: await getUserDailyMatchUsage(cleanUserId, { usageDate: cleanUsageDate }),
    };
  }

  if (!adapter || adapter.kind === 'none') {
    const key = `${cleanUserId}:${cleanUsageDate}`;
    const existing = normalizeUserDailyMatchUsageRow(
      fallbackUserDailyMatchUsage.get(key) || {
        user_id: cleanUserId,
        usage_date: cleanUsageDate,
        matches_started: 0,
        last_match_started_at: null,
        created_at: startedAtIso,
        updated_at: startedAtIso,
      },
    );
    if (existing.matchesStarted >= safeLimit) {
      return { allowed: false, row: existing };
    }
    const row = normalizeUserDailyMatchUsageRow({
      ...existing,
      matches_started: existing.matchesStarted + 1,
      last_match_started_at: startedAtIso,
      updated_at: startedAtIso,
    });
    fallbackUserDailyMatchUsage.set(key, row);
    return { allowed: true, row };
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      WITH upserted AS (
        INSERT INTO user_daily_match_usage (
          user_id,
          usage_date,
          matches_started,
          last_match_started_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 1, $3, NOW(), NOW())
        ON CONFLICT (user_id, usage_date) DO UPDATE
        SET matches_started = user_daily_match_usage.matches_started + 1,
            last_match_started_at = EXCLUDED.last_match_started_at,
            updated_at = NOW()
        WHERE user_daily_match_usage.matches_started < $4
        RETURNING *
      )
      SELECT upserted.*, TRUE AS allowed
      FROM upserted
      UNION ALL
      SELECT usage.*, FALSE AS allowed
      FROM user_daily_match_usage AS usage
      WHERE usage.user_id = $1
        AND usage.usage_date = $2
        AND NOT EXISTS (SELECT 1 FROM upserted)
      LIMIT 1
    `, [cleanUserId, cleanUsageDate, startedAtIso, safeLimit]);
    const row = result.rows[0] || null;
    return {
      allowed: Boolean(row?.allowed),
      row: normalizeUserDailyMatchUsageRow(row),
    };
  }

  const transaction = adapter.database.transaction((normalizedUserId, normalizedUsageDate, limitCap, timestampIso) => {
    const existing = adapter.database.prepare(`
      SELECT *
      FROM user_daily_match_usage
      WHERE user_id = ?
        AND usage_date = ?
      LIMIT 1
    `).get(normalizedUserId, normalizedUsageDate);

    if (!existing) {
      adapter.database.prepare(`
        INSERT INTO user_daily_match_usage (
          user_id,
          usage_date,
          matches_started,
          last_match_started_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))
      `).run(normalizedUserId, normalizedUsageDate, timestampIso);
      return {
        allowed: true,
        row: adapter.database.prepare(`
          SELECT *
          FROM user_daily_match_usage
          WHERE user_id = ?
            AND usage_date = ?
          LIMIT 1
        `).get(normalizedUserId, normalizedUsageDate),
      };
    }

    const normalizedExisting = normalizeUserDailyMatchUsageRow(existing);
    if (normalizedExisting.matchesStarted >= limitCap) {
      return {
        allowed: false,
        row: existing,
      };
    }

    adapter.database.prepare(`
      UPDATE user_daily_match_usage
      SET matches_started = matches_started + 1,
          last_match_started_at = ?,
          updated_at = datetime('now')
      WHERE user_id = ?
        AND usage_date = ?
    `).run(timestampIso, normalizedUserId, normalizedUsageDate);

    return {
      allowed: true,
      row: adapter.database.prepare(`
        SELECT *
        FROM user_daily_match_usage
        WHERE user_id = ?
          AND usage_date = ?
        LIMIT 1
      `).get(normalizedUserId, normalizedUsageDate),
    };
  });

  const result = transaction(cleanUserId, cleanUsageDate, safeLimit, startedAtIso);
  return {
    allowed: Boolean(result?.allowed),
    row: normalizeUserDailyMatchUsageRow(result?.row || null),
  };
}

async function releaseUserDailyMatchQuota(userId, {
  usageDate = normalizeUsageDate(),
} = {}) {
  const adapter = await ensureDb();
  const cleanUserId = String(userId || '').trim();
  const cleanUsageDate = normalizeUsageDate(usageDate);
  if (!cleanUserId) return null;

  if (!adapter || adapter.kind === 'none') {
    const key = `${cleanUserId}:${cleanUsageDate}`;
    const existing = normalizeUserDailyMatchUsageRow(fallbackUserDailyMatchUsage.get(key) || null);
    if (!existing) return null;
    const row = normalizeUserDailyMatchUsageRow({
      ...existing,
      matches_started: Math.max(0, existing.matchesStarted - 1),
      updated_at: nowIso(),
    });
    fallbackUserDailyMatchUsage.set(key, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE user_daily_match_usage
      SET matches_started = GREATEST(0, matches_started - 1),
          updated_at = NOW()
      WHERE user_id = $1
        AND usage_date = $2
      RETURNING *
    `, [cleanUserId, cleanUsageDate]);
    return normalizeUserDailyMatchUsageRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE user_daily_match_usage
    SET matches_started = MAX(0, matches_started - 1),
        updated_at = datetime('now')
    WHERE user_id = ?
      AND usage_date = ?
  `).run(cleanUserId, cleanUsageDate);
  const row = adapter.database.prepare(`
    SELECT *
    FROM user_daily_match_usage
    WHERE user_id = ?
      AND usage_date = ?
    LIMIT 1
  `).get(cleanUserId, cleanUsageDate);
  return normalizeUserDailyMatchUsageRow(row || null);
}

async function upsertAgentRecord(agent = {}) {
  const adapter = await ensureDb();
  const id = String(agent.id || '').trim();
  if (!id) return null;

  const ownerUserId = String(agent.ownerUserId || agent.owner_user_id || '').trim() || null;
  const ownerEmail = String(
    agent.ownerEmail
      || agent.owner_email
      || agent.owner
      || ''
  ).trim().toLowerCase() || null;
  const name = String(agent.name || id).trim().slice(0, 64) || id;
  const nameNormalized = normalizeAgentNameKey(agent.nameNormalized || agent.name_normalized || name) || null;
  const source = String(agent.source || 'openclaw').trim().slice(0, 32) || 'openclaw';
  const lifecycleState = String(agent.lifecycleState || agent.lifecycle_state || 'active').trim() || 'active';
  const deployed = agent.deployed !== false;
  const karma = toNumber(agent.karma, 0);
  const personaJson = stringifyJson(agent.persona || null);
  const openclawNote = String(agent.openclaw?.note || agent.openclawNote || agent.openclaw_note || '').trim() || null;
  const createdAt = normalizeIso(agent.createdAt || agent.created_at) || new Date().toISOString();
  const lastConnectedAt = normalizeIso(
    agent.lastConnectedAt
      || agent.last_connected_at
      || agent.openclaw?.connectedAt,
  );
  const archivedAt = normalizeIso(agent.archivedAt || agent.archived_at);

  if (!adapter || adapter.kind === 'none') {
    const row = normalizeAgentRow({
      id,
      owner_user_id: ownerUserId,
      owner_email: ownerEmail,
      name,
      name_normalized: nameNormalized,
      source,
      lifecycle_state: lifecycleState,
      deployed,
      karma,
      persona_json: personaJson,
      openclaw_note: openclawNote,
      created_at: createdAt,
      updated_at: new Date().toISOString(),
      last_connected_at: lastConnectedAt,
      archived_at: archivedAt,
    });
    fallbackAgents.set(id, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO agents (
        id, owner_user_id, owner_email, name, name_normalized, source, lifecycle_state, deployed, karma, persona_json, openclaw_note, created_at, updated_at, last_connected_at, archived_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14)
      ON CONFLICT (id) DO UPDATE
      SET owner_user_id = EXCLUDED.owner_user_id,
          owner_email = EXCLUDED.owner_email,
          name = EXCLUDED.name,
          name_normalized = EXCLUDED.name_normalized,
          source = EXCLUDED.source,
          lifecycle_state = EXCLUDED.lifecycle_state,
          deployed = EXCLUDED.deployed,
          karma = EXCLUDED.karma,
          persona_json = EXCLUDED.persona_json,
          openclaw_note = EXCLUDED.openclaw_note,
          updated_at = NOW(),
          last_connected_at = COALESCE(EXCLUDED.last_connected_at, agents.last_connected_at),
          archived_at = EXCLUDED.archived_at
      RETURNING *
    `, [
      id,
      ownerUserId,
      ownerEmail,
      name,
      nameNormalized,
      source,
      lifecycleState,
      deployed,
      karma,
      personaJson,
      openclawNote,
      createdAt,
      lastConnectedAt,
      archivedAt,
    ]);
    return normalizeAgentRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO agents (
      id, owner_user_id, owner_email, name, name_normalized, source, lifecycle_state, deployed, karma, persona_json, openclaw_note, created_at, updated_at, last_connected_at, archived_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      owner_email = excluded.owner_email,
      name = excluded.name,
      name_normalized = excluded.name_normalized,
      source = excluded.source,
      lifecycle_state = excluded.lifecycle_state,
      deployed = excluded.deployed,
      karma = excluded.karma,
      persona_json = excluded.persona_json,
      openclaw_note = excluded.openclaw_note,
      updated_at = datetime('now'),
      last_connected_at = COALESCE(excluded.last_connected_at, agents.last_connected_at),
      archived_at = excluded.archived_at
  `).run(
    id,
    ownerUserId,
    ownerEmail,
    name,
    nameNormalized,
    source,
    lifecycleState,
    deployed ? 1 : 0,
    karma,
    personaJson,
    openclawNote,
    createdAt,
    lastConnectedAt,
    archivedAt,
  );
  return normalizeAgentRow(adapter.database.prepare('SELECT * FROM agents WHERE id = ? LIMIT 1').get(id));
}

async function getAgentRecordById(agentId) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanAgentId) {
    return normalizeAgentRow(fallbackAgents.get(cleanAgentId) || null);
  }
  if (!adapter || adapter.kind === 'none' || !cleanAgentId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [cleanAgentId]);
    return normalizeAgentRow(result.rows[0] || null);
  }

  return normalizeAgentRow(adapter.database.prepare('SELECT * FROM agents WHERE id = ? LIMIT 1').get(cleanAgentId));
}

async function getAgentRecordByName(name) {
  const adapter = await ensureDb();
  const cleanName = normalizeAgentNameKey(name);
  if ((!adapter || adapter.kind === 'none') && cleanName) {
    for (const row of fallbackAgents.values()) {
      if (normalizeAgentNameKey(row.name_normalized || row.nameNormalized || row.name) === cleanName) {
        return normalizeAgentRow(row);
      }
    }
    return null;
  }
  if (!adapter || adapter.kind === 'none' || !cleanName) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM agents WHERE name_normalized = $1 LIMIT 1',
      [cleanName],
    );
    return normalizeAgentRow(result.rows[0] || null);
  }

  return normalizeAgentRow(
    adapter.database.prepare('SELECT * FROM agents WHERE name_normalized = ? LIMIT 1').get(cleanName),
  );
}

async function archiveAgentRecord(agentId) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanAgentId) {
    const existing = fallbackAgents.get(cleanAgentId);
    if (!existing) return null;
    const row = normalizeAgentRow({
      ...existing,
      lifecycle_state: 'archived',
      deployed: 0,
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fallbackAgents.set(cleanAgentId, row);
    return row;
  }
  if (!adapter || adapter.kind === 'none' || !cleanAgentId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE agents
      SET lifecycle_state = 'archived',
          deployed = FALSE,
          archived_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [cleanAgentId]);
    return normalizeAgentRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE agents
    SET lifecycle_state = 'archived',
        deployed = 0,
        archived_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(cleanAgentId);
  return normalizeAgentRow(adapter.database.prepare('SELECT * FROM agents WHERE id = ? LIMIT 1').get(cleanAgentId));
}

async function listAgentRecordsByOwnerUserId(ownerUserId) {
  const adapter = await ensureDb();
  const cleanUserId = String(ownerUserId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanUserId) {
    return [...fallbackAgents.values()]
      .filter((row) => String(row.owner_user_id || row.ownerUserId || '').trim() === cleanUserId)
      .map(normalizeAgentRow);
  }
  if (!adapter || adapter.kind === 'none' || !cleanUserId) return [];

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(
      'SELECT * FROM agents WHERE owner_user_id = $1 ORDER BY updated_at DESC, created_at DESC',
      [cleanUserId],
    );
    return result.rows.map(normalizeAgentRow);
  }

  return adapter.database.prepare(
    "SELECT * FROM agents WHERE owner_user_id = ? ORDER BY updated_at DESC, created_at DESC",
  ).all(cleanUserId).map(normalizeAgentRow);
}

async function listAllAgentRecords() {
  const adapter = await ensureDb();
  if (!adapter || adapter.kind === 'none') {
    return [...fallbackAgents.values()].map(normalizeAgentRow);
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM agents ORDER BY created_at ASC');
    return result.rows.map(normalizeAgentRow);
  }

  return adapter.database.prepare('SELECT * FROM agents ORDER BY created_at ASC').all().map(normalizeAgentRow);
}

async function reassignAgentRecordsToOwner(sourceUserId, targetUserId, { ownerEmail = null } = {}) {
  const adapter = await ensureDb();
  const fromUserId = String(sourceUserId || '').trim();
  const toUserId = String(targetUserId || '').trim();
  if ((!adapter || adapter.kind === 'none') && fromUserId && toUserId && fromUserId !== toUserId) {
    let changed = 0;
    for (const [id, row] of fallbackAgents.entries()) {
      if (String(row.owner_user_id || row.ownerUserId || '').trim() !== fromUserId) continue;
      fallbackAgents.set(id, normalizeAgentRow({
        ...row,
        owner_user_id: toUserId,
        owner_email: ownerEmail || row.owner_email || row.ownerEmail || null,
        updated_at: new Date().toISOString(),
      }));
      changed += 1;
    }
    return changed;
  }
  if (!adapter || adapter.kind === 'none' || !fromUserId || !toUserId || fromUserId === toUserId) return 0;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE agents
      SET owner_user_id = $1,
          owner_email = COALESCE($2, owner_email),
          updated_at = NOW()
      WHERE owner_user_id = $3
    `, [toUserId, ownerEmail || null, fromUserId]);
    return toNumber(result.rowCount, 0);
  }

  const result = adapter.database.prepare(`
    UPDATE agents
    SET owner_user_id = ?,
        owner_email = COALESCE(?, owner_email),
        updated_at = datetime('now')
    WHERE owner_user_id = ?
  `).run(toUserId, ownerEmail || null, fromUserId);
  return toNumber(result.changes, 0);
}

async function createOrRotateAgentRuntimeCredential(agentId, secretHash) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  const cleanSecretHash = String(secretHash || '').trim();
  if (!cleanAgentId || !cleanSecretHash) return null;

  if (!adapter || adapter.kind === 'none') {
    const row = normalizeRuntimeCredentialRow({
      agent_id: cleanAgentId,
      secret_hash: cleanSecretHash,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_used_at: null,
    });
    fallbackRuntimeCredentials.set(cleanAgentId, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO agent_runtime_credentials (
        agent_id, secret_hash, created_at, last_used_at, revoked_at
      )
      VALUES ($1, $2, NOW(), NULL, NULL)
      ON CONFLICT (agent_id) DO UPDATE
      SET secret_hash = EXCLUDED.secret_hash,
          created_at = NOW(),
          last_used_at = NULL,
          revoked_at = NULL
      RETURNING *
    `, [cleanAgentId, cleanSecretHash]);
    return normalizeRuntimeCredentialRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO agent_runtime_credentials (
      agent_id, secret_hash, created_at, last_used_at, revoked_at
    )
    VALUES (?, ?, datetime('now'), NULL, NULL)
    ON CONFLICT(agent_id) DO UPDATE SET
      secret_hash = excluded.secret_hash,
      created_at = datetime('now'),
      last_used_at = NULL,
      revoked_at = NULL
  `).run(cleanAgentId, cleanSecretHash);
  return normalizeRuntimeCredentialRow(
    adapter.database.prepare('SELECT * FROM agent_runtime_credentials WHERE agent_id = ? LIMIT 1').get(cleanAgentId),
  );
}

async function getAgentRuntimeCredential(agentId) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanAgentId) {
    return normalizeRuntimeCredentialRow(fallbackRuntimeCredentials.get(cleanAgentId) || null);
  }
  if (!adapter || adapter.kind === 'none' || !cleanAgentId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT * FROM agent_runtime_credentials
      WHERE agent_id = $1
      LIMIT 1
    `, [cleanAgentId]);
    return normalizeRuntimeCredentialRow(result.rows[0] || null);
  }

  return normalizeRuntimeCredentialRow(
    adapter.database.prepare('SELECT * FROM agent_runtime_credentials WHERE agent_id = ? LIMIT 1').get(cleanAgentId),
  );
}

async function touchAgentRuntimeCredential(agentId) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanAgentId) {
    const existing = fallbackRuntimeCredentials.get(cleanAgentId);
    if (!existing || existing.revoked_at) return null;
    const row = normalizeRuntimeCredentialRow({
      ...existing,
      last_used_at: new Date().toISOString(),
    });
    fallbackRuntimeCredentials.set(cleanAgentId, row);
    return row;
  }
  if (!adapter || adapter.kind === 'none' || !cleanAgentId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE agent_runtime_credentials
      SET last_used_at = NOW()
      WHERE agent_id = $1
        AND revoked_at IS NULL
      RETURNING *
    `, [cleanAgentId]);
    return normalizeRuntimeCredentialRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    UPDATE agent_runtime_credentials
    SET last_used_at = datetime('now')
    WHERE agent_id = ?
      AND revoked_at IS NULL
  `).run(cleanAgentId);
  return normalizeRuntimeCredentialRow(
    adapter.database.prepare('SELECT * FROM agent_runtime_credentials WHERE agent_id = ? LIMIT 1').get(cleanAgentId),
  );
}

async function revokeAgentRuntimeCredential(agentId) {
  const adapter = await ensureDb();
  const cleanAgentId = String(agentId || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanAgentId) {
    const existing = fallbackRuntimeCredentials.get(cleanAgentId);
    if (!existing || existing.revoked_at) return 0;
    fallbackRuntimeCredentials.set(cleanAgentId, normalizeRuntimeCredentialRow({
      ...existing,
      revoked_at: new Date().toISOString(),
    }));
    return 1;
  }
  if (!adapter || adapter.kind === 'none' || !cleanAgentId) return 0;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE agent_runtime_credentials
      SET revoked_at = NOW()
      WHERE agent_id = $1
        AND revoked_at IS NULL
    `, [cleanAgentId]);
    return toNumber(result.rowCount, 0);
  }

  const result = adapter.database.prepare(`
    UPDATE agent_runtime_credentials
    SET revoked_at = datetime('now')
    WHERE agent_id = ?
      AND revoked_at IS NULL
  `).run(cleanAgentId);
  return toNumber(result.changes, 0);
}

async function createConnectSessionRecord(session) {
  const adapter = await ensureDb();
  const id = String(session?.id || '').trim();
  if (!id) return null;
  const ownerUserId = String(session.ownerUserId || session.owner_user_id || '').trim() || null;
  const emailSnapshot = String(session.emailSnapshot || session.email_snapshot || session.email || '').trim().toLowerCase() || null;
  const status = String(session.status || 'pending_confirmation').trim() || 'pending_confirmation';
  const callbackUrl = String(session.callbackUrl || session.callback_url || '').trim();
  const accessTokenHash = String(session.accessTokenHash || session.access_token_hash || '').trim();
  const callbackProofHash = String(session.callbackProofHash || session.callback_proof_hash || '').trim();
  const agentId = String(session.agentId || session.agent_id || '').trim() || null;
  const agentName = String(session.agentName || session.agent_name || '').trim() || null;
  const createdAt = normalizeIso(session.createdAt || session.created_at) || new Date().toISOString();
  const expiresAt = normalizeIso(session.expiresAt || session.expires_at);
  const connectedAt = normalizeIso(session.connectedAt || session.connected_at);

  if (!adapter || adapter.kind === 'none') {
    const row = normalizeConnectSessionRow({
      id,
      owner_user_id: ownerUserId,
      email_snapshot: emailSnapshot,
      status,
      callback_url: callbackUrl,
      access_token_hash: accessTokenHash,
      callback_proof_hash: callbackProofHash,
      agent_id: agentId,
      agent_name: agentName,
      created_at: createdAt,
      expires_at: expiresAt,
      connected_at: connectedAt,
    });
    fallbackConnectSessions.set(id, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO connect_sessions (
        id, owner_user_id, email_snapshot, status, callback_url, access_token_hash, callback_proof_hash, agent_id, agent_name, created_at, expires_at, connected_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE
      SET owner_user_id = EXCLUDED.owner_user_id,
          email_snapshot = EXCLUDED.email_snapshot,
          status = EXCLUDED.status,
          callback_url = EXCLUDED.callback_url,
          access_token_hash = EXCLUDED.access_token_hash,
          callback_proof_hash = EXCLUDED.callback_proof_hash,
          agent_id = EXCLUDED.agent_id,
          agent_name = EXCLUDED.agent_name,
          expires_at = EXCLUDED.expires_at,
          connected_at = EXCLUDED.connected_at
      RETURNING *
    `, [
      id,
      ownerUserId,
      emailSnapshot,
      status,
      callbackUrl,
      accessTokenHash,
      callbackProofHash,
      agentId,
      agentName,
      createdAt,
      expiresAt,
      connectedAt,
    ]);
    return normalizeConnectSessionRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO connect_sessions (
      id, owner_user_id, email_snapshot, status, callback_url, access_token_hash, callback_proof_hash, agent_id, agent_name, created_at, expires_at, connected_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      email_snapshot = excluded.email_snapshot,
      status = excluded.status,
      callback_url = excluded.callback_url,
      access_token_hash = excluded.access_token_hash,
      callback_proof_hash = excluded.callback_proof_hash,
      agent_id = excluded.agent_id,
      agent_name = excluded.agent_name,
      expires_at = excluded.expires_at,
      connected_at = excluded.connected_at
  `).run(
    id,
    ownerUserId,
    emailSnapshot,
    status,
    callbackUrl,
    accessTokenHash,
    callbackProofHash,
    agentId,
    agentName,
    createdAt,
    expiresAt,
    connectedAt,
  );
  return normalizeConnectSessionRow(adapter.database.prepare('SELECT * FROM connect_sessions WHERE id = ? LIMIT 1').get(id));
}

async function getConnectSessionRecord(id) {
  const adapter = await ensureDb();
  const cleanId = String(id || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanId) {
    return normalizeConnectSessionRow(fallbackConnectSessions.get(cleanId) || null);
  }
  if (!adapter || adapter.kind === 'none' || !cleanId) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query('SELECT * FROM connect_sessions WHERE id = $1 LIMIT 1', [cleanId]);
    return normalizeConnectSessionRow(result.rows[0] || null);
  }

  return normalizeConnectSessionRow(adapter.database.prepare('SELECT * FROM connect_sessions WHERE id = ? LIMIT 1').get(cleanId));
}

async function updateConnectSessionRecord(id, updates = {}) {
  const adapter = await ensureDb();
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;
  const existing = await getConnectSessionRecord(cleanId);
  if (!existing) return null;
  return createConnectSessionRecord({
    ...existing,
    ...updates,
    id: cleanId,
  });
}

async function countConnectSessionsCreatedByOwnerUserId(ownerUserId, {
  createdAfter = null,
  createdBefore = null,
} = {}) {
  const adapter = await ensureDb();
  const cleanOwnerUserId = String(ownerUserId || '').trim();
  const normalizedCreatedAfter = normalizeIso(createdAfter);
  const normalizedCreatedBefore = normalizeIso(createdBefore);
  if ((!adapter || adapter.kind === 'none') && cleanOwnerUserId) {
    let count = 0;
    const createdAfterMs = normalizedCreatedAfter ? new Date(normalizedCreatedAfter).getTime() : null;
    const createdBeforeMs = normalizedCreatedBefore ? new Date(normalizedCreatedBefore).getTime() : null;
    for (const row of fallbackConnectSessions.values()) {
      const normalized = normalizeConnectSessionRow(row);
      if (String(normalized?.owner_user_id || '').trim() !== cleanOwnerUserId) continue;
      const createdAtMs = new Date(normalized?.created_at || 0).getTime();
      if (createdAfterMs != null && createdAtMs < createdAfterMs) continue;
      if (createdBeforeMs != null && createdAtMs >= createdBeforeMs) continue;
      count += 1;
    }
    return count;
  }
  if (!adapter || adapter.kind === 'none' || !cleanOwnerUserId) return 0;

  if (adapter.kind === 'postgres') {
    const conditions = ['owner_user_id = $1'];
    const values = [cleanOwnerUserId];
    if (normalizedCreatedAfter) {
      values.push(normalizedCreatedAfter);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (normalizedCreatedBefore) {
      values.push(normalizedCreatedBefore);
      conditions.push(`created_at < $${values.length}`);
    }
    const result = await adapter.pool.query(`
      SELECT COUNT(*)::int AS count
      FROM connect_sessions
      WHERE ${conditions.join(' AND ')}
    `, values);
    return toNumber(result.rows[0]?.count, 0);
  }

  const conditions = ['owner_user_id = ?'];
  const values = [cleanOwnerUserId];
  if (normalizedCreatedAfter) {
    conditions.push('created_at >= ?');
    values.push(normalizedCreatedAfter);
  }
  if (normalizedCreatedBefore) {
    conditions.push('created_at < ?');
    values.push(normalizedCreatedBefore);
  }
  const row = adapter.database.prepare(`
    SELECT COUNT(*) AS count
    FROM connect_sessions
    WHERE ${conditions.join(' AND ')}
  `).get(...values);
  return toNumber(row?.count, 0);
}

async function createMagicLinkTokenRecord(tokenRecord = {}) {
  const adapter = await ensureDb();
  const tokenHash = String(tokenRecord.tokenHash || tokenRecord.token_hash || '').trim();
  if (!tokenHash) return null;
  const userId = String(tokenRecord.userId || tokenRecord.user_id || '').trim() || null;
  const email = String(tokenRecord.email || '').trim().toLowerCase();
  const intent = String(tokenRecord.intent || 'login').trim() || 'login';
  const sourceUserId = String(tokenRecord.sourceUserId || tokenRecord.source_user_id || '').trim() || null;
  const expiresAt = normalizeIso(tokenRecord.expiresAt || tokenRecord.expires_at);

  if (!adapter || adapter.kind === 'none') {
    const row = normalizeMagicLinkTokenRow({
      token_hash: tokenHash,
      user_id: userId,
      email,
      intent,
      source_user_id: sourceUserId,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      consumed_at: null,
    });
    fallbackMagicLinkTokens.set(tokenHash, row);
    return row;
  }

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      INSERT INTO magic_link_tokens (
        token_hash, user_id, email, intent, source_user_id, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (token_hash) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          email = EXCLUDED.email,
          intent = EXCLUDED.intent,
          source_user_id = EXCLUDED.source_user_id,
          expires_at = EXCLUDED.expires_at,
          consumed_at = NULL
      RETURNING *
    `, [tokenHash, userId, email, intent, sourceUserId, expiresAt]);
    return normalizeMagicLinkTokenRow(result.rows[0] || null);
  }

  adapter.database.prepare(`
    INSERT INTO magic_link_tokens (
      token_hash, user_id, email, intent, source_user_id, expires_at, consumed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(token_hash) DO UPDATE SET
      user_id = excluded.user_id,
      email = excluded.email,
      intent = excluded.intent,
      source_user_id = excluded.source_user_id,
      expires_at = excluded.expires_at,
      consumed_at = NULL
  `).run(tokenHash, userId, email, intent, sourceUserId, expiresAt);
  return normalizeMagicLinkTokenRow(
    adapter.database.prepare('SELECT * FROM magic_link_tokens WHERE token_hash = ? LIMIT 1').get(tokenHash),
  );
}

async function consumeMagicLinkTokenRecord(tokenHash) {
  const adapter = await ensureDb();
  const cleanTokenHash = String(tokenHash || '').trim();
  if ((!adapter || adapter.kind === 'none') && cleanTokenHash) {
    const existing = fallbackMagicLinkTokens.get(cleanTokenHash);
    if (!existing) return null;
    if (existing.consumed_at) return null;
    if (existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now()) return null;
    const row = normalizeMagicLinkTokenRow({
      ...existing,
      consumed_at: new Date().toISOString(),
    });
    fallbackMagicLinkTokens.set(cleanTokenHash, row);
    return row;
  }
  if (!adapter || adapter.kind === 'none' || !cleanTokenHash) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      UPDATE magic_link_tokens
      SET consumed_at = NOW()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING *
    `, [cleanTokenHash]);
    return normalizeMagicLinkTokenRow(result.rows[0] || null);
  }

  const row = adapter.database.prepare(`
    SELECT * FROM magic_link_tokens
    WHERE token_hash = ?
      AND consumed_at IS NULL
      AND expires_at > datetime('now')
    LIMIT 1
  `).get(cleanTokenHash);
  if (!row) return null;

  adapter.database.prepare(`
    UPDATE magic_link_tokens
    SET consumed_at = datetime('now')
    WHERE token_hash = ?
  `).run(cleanTokenHash);

  return normalizeMagicLinkTokenRow({
    ...row,
    consumed_at: new Date().toISOString(),
  });
}

async function countMagicLinkTokensByEmail(email, {
  createdAfter = null,
  createdBefore = null,
} = {}) {
  const adapter = await ensureDb();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const normalizedCreatedAfter = normalizeIso(createdAfter);
  const normalizedCreatedBefore = normalizeIso(createdBefore);
  if ((!adapter || adapter.kind === 'none') && cleanEmail) {
    let count = 0;
    const createdAfterMs = normalizedCreatedAfter ? new Date(normalizedCreatedAfter).getTime() : null;
    const createdBeforeMs = normalizedCreatedBefore ? new Date(normalizedCreatedBefore).getTime() : null;
    for (const row of fallbackMagicLinkTokens.values()) {
      const normalized = normalizeMagicLinkTokenRow(row);
      if (String(normalized?.email || '').trim().toLowerCase() !== cleanEmail) continue;
      const createdAtMs = new Date(normalized?.created_at || 0).getTime();
      if (createdAfterMs != null && createdAtMs < createdAfterMs) continue;
      if (createdBeforeMs != null && createdAtMs >= createdBeforeMs) continue;
      count += 1;
    }
    return count;
  }
  if (!adapter || adapter.kind === 'none' || !cleanEmail) return 0;

  if (adapter.kind === 'postgres') {
    const conditions = ['email = $1'];
    const values = [cleanEmail];
    if (normalizedCreatedAfter) {
      values.push(normalizedCreatedAfter);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (normalizedCreatedBefore) {
      values.push(normalizedCreatedBefore);
      conditions.push(`created_at < $${values.length}`);
    }
    const result = await adapter.pool.query(`
      SELECT COUNT(*)::int AS count
      FROM magic_link_tokens
      WHERE ${conditions.join(' AND ')}
    `, values);
    return toNumber(result.rows[0]?.count, 0);
  }

  const conditions = ['email = ?'];
  const values = [cleanEmail];
  if (normalizedCreatedAfter) {
    conditions.push('created_at >= ?');
    values.push(normalizedCreatedAfter);
  }
  if (normalizedCreatedBefore) {
    conditions.push('created_at < ?');
    values.push(normalizedCreatedBefore);
  }
  const row = adapter.database.prepare(`
    SELECT COUNT(*) AS count
    FROM magic_link_tokens
    WHERE ${conditions.join(' AND ')}
  `).get(...values);
  return toNumber(row?.count, 0);
}

async function getLatestMagicLinkTokenRecordByEmail(email) {
  const adapter = await ensureDb();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if ((!adapter || adapter.kind === 'none') && cleanEmail) {
    let latest = null;
    let latestCreatedAtMs = -1;
    for (const row of fallbackMagicLinkTokens.values()) {
      const normalized = normalizeMagicLinkTokenRow(row);
      if (String(normalized?.email || '').trim().toLowerCase() !== cleanEmail) continue;
      const createdAtMs = new Date(normalized?.created_at || 0).getTime();
      if (createdAtMs <= latestCreatedAtMs) continue;
      latest = normalized;
      latestCreatedAtMs = createdAtMs;
    }
    return latest;
  }
  if (!adapter || adapter.kind === 'none' || !cleanEmail) return null;

  if (adapter.kind === 'postgres') {
    const result = await adapter.pool.query(`
      SELECT *
      FROM magic_link_tokens
      WHERE email = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [cleanEmail]);
    return normalizeMagicLinkTokenRow(result.rows[0] || null);
  }

  return normalizeMagicLinkTokenRow(adapter.database.prepare(`
    SELECT *
    FROM magic_link_tokens
    WHERE email = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(cleanEmail));
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
            match_id, user_id, agent_id, player_name, role, is_bot, survived, placement, night_kill_credits
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          id,
          player.userId || null,
          player.agentId || null,
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
      match_id, user_id, agent_id, player_name, role, is_bot, survived, placement, night_kill_credits
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        player.agentId || null,
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
        mp.agent_id,
        mp.player_name,
        mp.role,
        mp.survived,
        mp.placement,
        mp.night_kill_credits
      FROM match_results mr
      JOIN match_players mp ON mp.match_id = mr.id
      WHERE COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) = $1
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
      mp.agent_id,
      mp.player_name,
      mp.role,
      mp.survived,
      mp.placement,
      mp.night_kill_credits
    FROM match_results mr
    JOIN match_players mp ON mp.match_id = mr.id
    WHERE COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) = ?
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
        COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) AS id,
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
        ON ar.agent_id = COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name)
       AND ar.mode = mr.mode
      WHERE mp.is_bot = FALSE
        AND mr.mode = $1
        ${whereWindow}
      GROUP BY COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name)
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
      COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) AS id,
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
      ON ar.agent_id = COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name)
     AND ar.mode = mr.mode
    WHERE mp.is_bot = 0
      AND mr.mode = ?
      ${windowFilter}
    GROUP BY COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name)
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
        COUNT(DISTINCT CASE WHEN mp.is_bot = FALSE THEN COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) END)::int AS unique_agents,
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
      COUNT(DISTINCT CASE WHEN mp.is_bot = 0 THEN COALESCE(NULLIF(mp.agent_id,''), NULLIF(mp.user_id,''), mp.player_name) END) AS unique_agents,
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
      WHERE COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) = $1
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
      WHERE COALESCE(NULLIF(mp.agent_id, ''), NULLIF(mp.user_id, ''), mp.player_name) = ?
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

function deletionCount(result) {
  if (!result) return 0;
  if (typeof result.rowCount === 'number') return toNumber(result.rowCount, 0);
  if (typeof result.changes === 'number') return toNumber(result.changes, 0);
  return 0;
}

function isPastCutoff(value, cutoffMs) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) && timestamp <= cutoffMs;
}

async function cleanupExpiredRecords({
  sessionGraceMs = DEFAULT_RETENTION_GRACE_MS,
  connectSessionGraceMs = DEFAULT_RETENTION_GRACE_MS,
  magicLinkGraceMs = DEFAULT_RETENTION_GRACE_MS,
  now = Date.now(),
} = {}) {
  const adapter = await ensureDb();
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const sessionCutoffIso = new Date(safeNow - Math.max(0, Number(sessionGraceMs) || 0)).toISOString();
  const connectSessionCutoffIso = new Date(safeNow - Math.max(0, Number(connectSessionGraceMs) || 0)).toISOString();
  const magicLinkCutoffIso = new Date(safeNow - Math.max(0, Number(magicLinkGraceMs) || 0)).toISOString();
  const counts = {
    sessions: 0,
    connectSessions: 0,
    magicLinkTokens: 0,
  };

  if (!adapter || adapter.kind === 'none') {
    const sessionCutoffMs = new Date(sessionCutoffIso).getTime();
    const connectCutoffMs = new Date(connectSessionCutoffIso).getTime();
    const magicCutoffMs = new Date(magicLinkCutoffIso).getTime();

    for (const [token, session] of fallbackSessions.entries()) {
      if (!isPastCutoff(session?.expires_at, sessionCutoffMs)) continue;
      fallbackSessions.delete(token);
      counts.sessions += 1;
    }

    for (const [id, connectSession] of fallbackConnectSessions.entries()) {
      if (!isPastCutoff(connectSession?.expires_at, connectCutoffMs)) continue;
      fallbackConnectSessions.delete(id);
      counts.connectSessions += 1;
    }

    for (const [tokenHash, tokenRecord] of fallbackMagicLinkTokens.entries()) {
      const deleteConsumed = tokenRecord?.consumed_at && isPastCutoff(tokenRecord.consumed_at, magicCutoffMs);
      const deleteExpired = !tokenRecord?.consumed_at && isPastCutoff(tokenRecord?.expires_at, magicCutoffMs);
      if (!deleteConsumed && !deleteExpired) continue;
      fallbackMagicLinkTokens.delete(tokenHash);
      counts.magicLinkTokens += 1;
    }

    return counts;
  }

  if (adapter.kind === 'postgres') {
    const [sessionsResult, connectSessionsResult, magicLinksResult] = await Promise.all([
      adapter.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [sessionCutoffIso]),
      adapter.pool.query('DELETE FROM connect_sessions WHERE expires_at <= $1', [connectSessionCutoffIso]),
      adapter.pool.query(`
        DELETE FROM magic_link_tokens
        WHERE (consumed_at IS NOT NULL AND consumed_at <= $1)
           OR (consumed_at IS NULL AND expires_at <= $2)
      `, [magicLinkCutoffIso, magicLinkCutoffIso]),
    ]);
    counts.sessions = deletionCount(sessionsResult);
    counts.connectSessions = deletionCount(connectSessionsResult);
    counts.magicLinkTokens = deletionCount(magicLinksResult);
    return counts;
  }

  counts.sessions = deletionCount(
    adapter.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(sessionCutoffIso),
  );
  counts.connectSessions = deletionCount(
    adapter.database.prepare('DELETE FROM connect_sessions WHERE expires_at <= ?').run(connectSessionCutoffIso),
  );
  counts.magicLinkTokens = deletionCount(
    adapter.database.prepare(`
      DELETE FROM magic_link_tokens
      WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
         OR (consumed_at IS NULL AND expires_at <= ?)
    `).run(magicLinkCutoffIso, magicLinkCutoffIso),
  );
  return counts;
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
      let sizeBytes = null;
      let maxConnections = null;
      try {
        const statsResult = await adapter.pool.query(`
          SELECT
            pg_database_size(current_database())::bigint AS size_bytes,
            current_setting('max_connections')::int AS max_connections
        `);
        const statsRow = statsResult.rows[0] || {};
        sizeBytes = statsRow.size_bytes == null ? null : toNumber(statsRow.size_bytes, null);
        maxConnections = statsRow.max_connections == null ? null : toNumber(statsRow.max_connections, null);
      } catch (_err) {
        // Best-effort database sizing stats only.
      }
      return {
        driver: 'postgres',
        status: 'ok',
        sizeBytes,
        maxConnections,
        poolConnections: {
          total: toNumber(adapter.pool.totalCount, 0),
          idle: toNumber(adapter.pool.idleCount, 0),
          waiting: toNumber(adapter.pool.waitingCount, 0),
        },
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
    let sizeBytes = null;
    if (adapter.databasePath && fs.existsSync(adapter.databasePath)) {
      sizeBytes = fs.statSync(adapter.databasePath).size;
    }
    return {
      driver: 'sqlite',
      status: integrityCheck[0]?.integrity_check === 'ok' ? 'ok' : 'degraded',
      sizeBytes,
    };
  } catch (error) {
    return {
      driver: 'sqlite',
      status: 'error',
      error: error.message,
    };
  }
}

function resetFallbackPersistence() {
  fallbackUsers.clear();
  fallbackSessions.clear();
  fallbackAgents.clear();
  fallbackRuntimeCredentials.clear();
  fallbackConnectSessions.clear();
  fallbackMagicLinkTokens.clear();
  fallbackMetricCounters.clear();
  fallbackUserDailyMatchUsage.clear();
  fallbackOpsSnapshots.clear();
  fallbackKpiRoomEvents.clear();
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
  deleteSessionsByUserId,
  getUserDailyMatchUsage,
  getUserDailyMatchUsages,
  consumeUserDailyMatchQuota,
  releaseUserDailyMatchQuota,
  incrementMetricCounter,
  getMetricCounters,
  saveOpsSnapshot,
  getOpsSnapshot,
  recordKpiRoomEvent,
  listKpiRoomEvents,
  upsertAgentRecord,
  getAgentRecordById,
  getAgentRecordByName,
  archiveAgentRecord,
  listAgentRecordsByOwnerUserId,
  listAllAgentRecords,
  reassignAgentRecordsToOwner,
  createOrRotateAgentRuntimeCredential,
  getAgentRuntimeCredential,
  touchAgentRuntimeCredential,
  revokeAgentRuntimeCredential,
  createConnectSessionRecord,
  getConnectSessionRecord,
  updateConnectSessionRecord,
  countConnectSessionsCreatedByOwnerUserId,
  createMagicLinkTokenRecord,
  consumeMagicLinkTokenRecord,
  countMagicLinkTokensByEmail,
  getLatestMagicLinkTokenRecordByEmail,
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
  cleanupExpiredRecords,
  getDatabaseHealth,
  currentAdapter,
  resetFallbackPersistence,
};
