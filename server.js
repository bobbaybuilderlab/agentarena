const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  Sentry.captureException(reason);
});

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mafiaGame = require('./games/agent-mafia');
const { createRoomScheduler } = require('./lib/room-scheduler');
const { createRoomEventLog } = require('./lib/room-events');
const { loadEvents, buildKpiReport } = require('./lib/kpi-report');
const { shortId, correlationId, logStructured } = require('./server/state/helpers');
const { createPlayTelemetryService } = require('./server/services/play-telemetry');
const { createOpenClawRouter } = require('./server/routes/openclaw');
const { socketOwnsPlayer, socketIsHostPlayer } = require('./server/sockets/ownership-guards');
const { registerRoomEventRoutes } = require('./server/routes/room-events');
const {
  initDb,
  recordMatch,
  getPlayerMatches,
  getLeaderboardEntries,
  getMatchBaselineSummary,
  getGlobalStats,
  getAgentStats,
  getRatingHealth,
  getUserByToken,
  getUserById,
  getUserByEmail,
  getSessionByToken,
  setUserAgentId,
  createAnonymousUser,
  createSession,
  upgradeUser,
  deleteSessionsByUserId,
  incrementMetricCounter,
  getMetricCounters,
  saveOpsSnapshot,
  getOpsSnapshot,
  upsertAgentRecord,
  getAgentRecordById,
  archiveAgentRecord,
  listAgentRecordsByOwnerUserId,
  listAllAgentRecords,
  reassignAgentRecordsToOwner,
  createOrRotateAgentRuntimeCredential,
  getAgentRuntimeCredential,
  touchAgentRuntimeCredential,
  revokeAgentRuntimeCredential,
  createMagicLinkTokenRecord,
  consumeMagicLinkTokenRecord,
  createReport,
  getReports,
  updateReportStatus,
  getMatch,
  recordKpiRoomEvent,
  listKpiRoomEvents,
  cleanupExpiredRecords,
  getDatabaseHealth,
  closeDb,
  resetFallbackPersistence,
} = require('./server/db');
const {
  getConnectSession,
  isConnectSessionExpired,
} = require('./server/services/connect-sessions');
const { buildResolvedPersona } = require('./extensions/clawofdeceit-connect/style-presets.cjs');
const { hashSecret, secretMatches, randomSecret } = require('./server/services/secret-tokens');
const {
  DEFAULT_MMR,
  buildDefaultRatingSnapshot,
  normalizeRatingSnapshot,
  calculateMatchRatingChanges,
  resolveParticipantId,
} = require('./server/services/mafia-elo');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { track: trackEvent } = require('./server/services/analytics');

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readBooleanEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampIntensity(value, fallback = 6) {
  const numeric = Number(value);
  return Math.max(1, Math.min(10, Number.isFinite(numeric) ? numeric : fallback));
}

function buildArenaPersona({ style, presetId, intensity } = {}) {
  const resolved = buildResolvedPersona({ style, presetId });
  return {
    style: resolved.style,
    presetId: resolved.presetId,
    intensity: clampIntensity(intensity, 6),
  };
}

function normalizeAgentNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isArchivedAgentProfile(agent) {
  return String(agent?.lifecycleState || agent?.lifecycle_state || '').trim().toLowerCase() === 'archived';
}

function ensureAgentRatingMirror(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const rating = buildDefaultRatingSnapshot({
    mmr: agent.mmr,
    peakMmr: agent.peakMmr,
    ratedMatches: agent.ratedMatches,
    lastRatingDelta: agent.lastRatingDelta,
  });
  agent.mmr = rating.mmr;
  agent.peakMmr = rating.peakMmr;
  agent.ratedMatches = rating.ratedMatches;
  agent.lastRatingDelta = rating.lastRatingDelta;
  return agent;
}

function getAgentRatingMirror(agentId) {
  const agent = agentProfiles.get(String(agentId || '').trim());
  return normalizeRatingSnapshot(agent ? ensureAgentRatingMirror(agent) : {});
}

function buildCurrentRatingsForMatch(matchRecord) {
  const snapshots = Object.create(null);
  for (const player of matchRecord?.players || []) {
    const participantId = resolveParticipantId(player);
    if (!participantId) continue;
    snapshots[participantId] = getAgentRatingMirror(participantId);
  }
  return snapshots;
}

function syncAgentRatingMirrors(ratingUpdates = []) {
  let changed = false;
  for (const update of ratingUpdates) {
    const agent = agentProfiles.get(String(update?.id || '').trim());
    if (!agent) continue;
    ensureAgentRatingMirror(agent);
    agent.mmr = Number(update.mmrAfter || DEFAULT_MMR);
    agent.peakMmr = Number(update.peakMmrAfter || agent.mmr);
    agent.ratedMatches = Number(update.ratedMatchesAfter || 0);
    agent.lastRatingDelta = Number(update.delta || 0);
    changed = true;
  }
  if (changed) persistState();
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_APP_URL = normalizeBaseUrl(process.env.PUBLIC_APP_URL || '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const MAGIC_LINK_FROM_RAW = String(process.env.MAGIC_LINK_FROM || '').trim();
const MAGIC_LINK_FROM = MAGIC_LINK_FROM_RAW || 'Claw of Deceit <noreply@clawofdeceit.com>';
const PUBLIC_ROOM_EVENT_ROUTES_ENABLED = readBooleanEnv('PUBLIC_ROOM_EVENT_ROUTES', !IS_PRODUCTION);
const ROOM_EVENT_FILE_PERSISTENCE_ENABLED = readBooleanEnv('ROOM_EVENT_FILE_PERSISTENCE', !IS_PRODUCTION);
const ALLOW_INSECURE_DEV_SURFACES = readBooleanEnv('ALLOW_INSECURE_DEV_SURFACES', false);

if (IS_PRODUCTION && !PUBLIC_APP_URL) {
  throw new Error('PUBLIC_APP_URL is required when NODE_ENV=production');
}
if (IS_PRODUCTION && !DATABASE_URL) {
  throw new Error('DATABASE_URL is required when NODE_ENV=production');
}
const PRODUCTION_ORIGINS = [PUBLIC_APP_URL].filter(Boolean);
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:4173', 'http://127.0.0.1:4173'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (IS_PRODUCTION && !allowedOrigins.length && PUBLIC_APP_URL) {
  console.warn('[startup] ALLOWED_ORIGINS not set; defaulting to PUBLIC_APP_URL');
}
const effectiveOrigins = allowedOrigins.length
  ? allowedOrigins
  : IS_PRODUCTION
    ? PRODUCTION_ORIGINS
    : [...PRODUCTION_ORIGINS, ...DEV_ORIGINS];
const socketCorsOrigin = effectiveOrigins.length ? effectiveOrigins : true;

function resolvePublicBaseUrl(req) {
  if (PUBLIC_APP_URL) return PUBLIC_APP_URL;
  return normalizeBaseUrl(`${req.protocol}://${req.get('host')}`);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const STALE_PUBLIC_BASE_URLS = [
  'https://agent-arena-vert.vercel.app',
  'https://agent-arena-xi0b.onrender.com',
];

function injectPublicBaseUrl(html, publicBaseUrl) {
  let next = String(html || '');
  const normalizedPublicBaseUrl = normalizeBaseUrl(publicBaseUrl);
  if (!normalizedPublicBaseUrl) return next;

  next = next.replace(
    /https:\/\/agent-arena[-a-z0-9]*\.(?:onrender\.com|vercel\.app)/gi,
    normalizedPublicBaseUrl,
  );

  for (const staleBaseUrl of STALE_PUBLIC_BASE_URLS) {
    const normalizedStaleBaseUrl = normalizeBaseUrl(staleBaseUrl);
    if (!normalizedStaleBaseUrl || normalizedStaleBaseUrl === normalizedPublicBaseUrl) continue;
    next = next.split(normalizedStaleBaseUrl).join(normalizedPublicBaseUrl);
  }

  return next;
}

function resolvePublicHtmlPath(requestPath) {
  const normalizedPath = requestPath === '/' ? '/index.html' : String(requestPath || '');
  if (!normalizedPath.endsWith('.html')) return null;
  const absolutePath = path.resolve(PUBLIC_DIR, `.${normalizedPath}`);
  if (!absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return absolutePath;
}

function buildRuntimeConfigScript(req) {
  const runtimeConfig = {
    API_URL: '',
    SOCKET_URL: '',
    PUBLIC_APP_URL: resolvePublicBaseUrl(req),
  };
  return `window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig, null, 2)};\n`;
}

function sendRuntimeHtml(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const htmlPath = resolvePublicHtmlPath(req.path);
  if (!htmlPath) return next();

  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const publicBaseUrl = resolvePublicBaseUrl(req);
    res.type('html');
    res.send(injectPublicBaseUrl(html, publicBaseUrl));
  } catch (err) {
    next(err);
  }
}

function readBearerToken(req) {
  return String(req.headers.authorization || '').replace('Bearer ', '').trim();
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '').trim();
  if (!header) return {};
  return header.split(';').reduce((cookies, chunk) => {
    const [rawName, ...rest] = chunk.split('=');
    const name = String(rawName || '').trim();
    if (!name) return cookies;
    cookies[name] = decodeURIComponent(rest.join('=').trim());
    return cookies;
  }, {});
}

function readSiteSessionCookie(req) {
  return String(parseCookies(req).site_session || '').trim();
}

function readSiteSessionToken(req) {
  return readBearerToken(req) || readSiteSessionCookie(req);
}

function requestUsesSecureTransport(req) {
  if (req.secure) return true;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  return normalizeBaseUrl(PUBLIC_APP_URL).startsWith('https://');
}

function buildSiteSessionCookie(token, req) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return '';
  const parts = [
    `site_session=${encodeURIComponent(normalizedToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (requestUsesSecureTransport(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSiteSessionCookie(req) {
  const parts = [
    'site_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (requestUsesSecureTransport(req)) parts.push('Secure');
  return parts.join('; ');
}

function readRemoteAddress(req) {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').trim().toLowerCase();
}

function isLoopbackRemoteAddress(remoteAddress) {
  const normalized = String(remoteAddress || '').trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

function isLoopbackRequest(req) {
  return isLoopbackRemoteAddress(readRemoteAddress(req));
}

function envFlagEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function opsSurfaceEnabled(nodeEnv = process.env.NODE_ENV) {
  const normalizedEnv = String(nodeEnv || '').trim().toLowerCase();
  return normalizedEnv !== 'production' && envFlagEnabled(process.env.ENABLE_LOCAL_OPS);
}

function manualMafiaSocketFeatureEnabled(nodeEnv = process.env.NODE_ENV) {
  const normalizedEnv = String(nodeEnv || '').trim().toLowerCase();
  return normalizedEnv !== 'production' && envFlagEnabled(process.env.ENABLE_MANUAL_MAFIA_SOCKET);
}

function retiredManualMafiaSocketResponse() {
  return {
    ok: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Manual Mafia room controls are not part of the current MVP.',
    },
  };
}

function buildOpsHealthPayload() {
  const scheduler = roomScheduler.stats();
  const eventQueueDepth = roomEvents.pending();
  const eventQueueByMode = roomEvents.pendingByMode();
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    launchMode: PUBLIC_LAUNCH_MODE,
    publicBaseUrl: PUBLIC_APP_URL || null,
    uptimeSec: Math.floor(process.uptime()),
    rooms: {
      mafia: mafiaRooms.size,
    },
    agents: agentProfiles.size,
    publicArena: buildPublicArenaQueueMetrics(),
    schedulerTimers: scheduler,
    eventQueueDepth,
    eventQueueByMode,
  };
}

function opsLoopbackApiGate(req, res, next) {
  if (!opsSurfaceEnabled()) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  if (isLoopbackRequest(req)) return next();
  res.status(404).json({ ok: false, error: 'not found' });
}

function opsLoopbackPageGate(req, res, next) {
  if (!opsSurfaceEnabled()) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  if (isLoopbackRequest(req)) return next();
  res.status(404).type('text/plain').send('Not found');
}

function isLoopbackAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized === '::ffff:127.0.0.1') return true;
  if (normalized.startsWith('127.')) return true;
  return false;
}

function isLocalOnlyRequest(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  return [
    forwardedFor,
    req.ip,
    req.socket?.remoteAddress,
    host,
  ].some(isLoopbackAddress);
}

function insecureDevSurfacesAllowed(req) {
  return ALLOW_INSECURE_DEV_SURFACES && isLocalOnlyRequest(req);
}

function setSiteSessionCookie(res, token, req) {
  const cookie = buildSiteSessionCookie(token, req);
  if (cookie) res.append('Set-Cookie', cookie);
}

const io = new Server(server, {
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || undefined;
const mafiaRooms = mafiaGame.createStore();

const roomScheduler = createRoomScheduler();
const roomEvents = createRoomEventLog({
  dataDir: path.join(__dirname, 'data'),
  persistToFile: ROOM_EVENT_FILE_PERSISTENCE_ENABLED,
});
const playRoomTelemetry = new Map();
const pendingQuickJoinTickets = new Map();
const reconnectClaimTickets = new Map();
const liveAgentRuntimes = new Map();
const agentRuntimeSockets = new Map();
const activeAgentMatchRooms = new Set();
const completedMatchRecords = [];

function clearAllGameTimers() {
  clearPublicArenaQueueRetryTimer();
  roomScheduler.clearAll();
  roomEvents.clear();
  resetPlayTelemetry();
  growthMetrics = buildEmptyGrowthMetrics();
  growthMetricsLoaded = false;
  resetFallbackPersistence();
}

const {
  telemetryKey,
  getRoomTelemetry,
  recordRoomWinner,
  recordTelemetryEvent,
  recordRematch,
  issueQuickJoinTicket,
  recordQuickJoinConversion,
  recordReconnectAutoTelemetry,
  recordReconnectClickTelemetry,
  recordJoinAttempt,
  recordSocketSeatCapBlocked,
  consumeReconnectClaimTicket,
  resolveReconnectJoinName,
  pickReconnectSuggestion,
  seedPlayTelemetry,
  resetPlayTelemetry,
} = createPlayTelemetryService({
  playRoomTelemetry,
  pendingQuickJoinTickets,
  reconnectClaimTickets,
  roomEvents,
  shortId,
  getClaimableLobbySeats: (mode, roomId) => getClaimableLobbySeats(mode, roomId),
});

// Map room event types to Amplitude event names
const AMPLITUDE_EVENT_MAP = {
  ROOM_CREATED: 'room_created',
  PLAYER_JOINED: 'room_joined',
  MATCH_STARTED: 'match_started',
  BATTLE_FINISHED: 'match_completed',
  MATCH_FINISHED: 'match_completed',
  REMATCH_STARTED: 'rematch_started',
  QUICK_JOIN_CONVERTED: 'quick_join_used',
};

function logRoomEvent(mode, room, type, payload = {}) {
  if (!room?.id) return;
  const event = roomEvents.append(mode, room.id, type, payload);

  if (KPI_ROOM_EVENT_TYPES.has(type)) {
    void recordKpiRoomEvent({
      mode,
      roomId: room.id,
      type,
      createdAt: event?.at || Date.now(),
    }).catch((err) => {
      logStructured('error.recordKpiRoomEvent', { error: err.message, mode, roomId: room.id, type });
    });
  }

  // Track to Amplitude
  const amplitudeEvent = AMPLITUDE_EVENT_MAP[type];
  if (amplitudeEvent) {
    const userId = payload.userId || payload.socketId || room.id;
    trackEvent(amplitudeEvent, userId, { mode, roomId: room.id, ...payload });
  }
}

const MAFIA_REPLAY_EVENT_TYPES = new Set([
  'PHASE',
  'NIGHT_ELIMINATION',
  'DAY_EXECUTION',
  'VOTE_TIED',
  'GAME_FINISHED',
  'PLAYER_FORFEITED',
  'REMATCH_READY',
]);

function syncMafiaReplayEvents(room) {
  if (!room?.id || !Array.isArray(room.events)) return;
  const cursor = Math.max(0, Math.min(Number(room._syncedReplayEventIndex) || 0, room.events.length));
  for (let index = cursor; index < room.events.length; index += 1) {
    const event = room.events[index];
    if (!event?.type || !MAFIA_REPLAY_EVENT_TYPES.has(event.type)) continue;
    const target = event.targetId
      ? (room.players || []).find((player) => player.id === event.targetId)
      : null;
    const player = event.playerId
      ? (room.players || []).find((entry) => entry.id === event.playerId)
      : null;
    const actor = event.actorId
      ? (room.players || []).find((player) => player.id === event.actorId)
      : null;
    logRoomEvent('mafia', room, event.type, {
      actorId: event.actorId || null,
      actorName: event.actorName || actor?.name || null,
      targetId: event.targetId || null,
      targetName: target?.name || null,
      playerId: event.playerId || null,
      playerName: player?.name || null,
      actorIds: Array.isArray(event.actorIds) ? event.actorIds : undefined,
      reason: event.reason || null,
      text: event.text || null,
      winner: event.winner || room.winner || null,
      status: room.status,
      phase: event.phase || room.phase || null,
      day: Number(event.day || room.day || 0) || 0,
    });
  }
  room._syncedReplayEventIndex = room.events.length;
}

function emitMafiaRoom(room) {
  syncMafiaReplayEvents(room);
  io.to(`mafia:${room.id}`).emit('mafia:state', mafiaGame.toPublic(room));
}

function pickDeterministicTarget(players, actorId) {
  return players
    .filter((p) => p.alive && p.id !== actorId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function buildDeterministicDiscussionMessage(room, actor) {
  const target = pickDeterministicTarget(room.players || [], actor?.id);
  if (!target) return '';
  return `${target.name} is still my strongest read. Their timing keeps landing a little too clean.`;
}

function isAvailableDiscussionSpeaker(player) {
  if (!player?.alive) return false;
  if (player.isBot) return true;
  return Boolean(player.isConnected);
}

function clearMafiaDiscussionTurn(room) {
  if (!room) return;
  room._discussionTurnKey = null;
  roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'discussion-turn' });
  if (room.discussion) {
    room.discussion.turnId = null;
    room.discussion.turnEndsAt = null;
  }
}

function completeMafiaDiscussionTurn(room, { spoke = false } = {}) {
  const discussion = room?.discussion;
  if (!discussion) return;
  if (spoke) discussion.cycleHadSpeech = true;

  clearMafiaDiscussionTurn(room);

  const order = Array.isArray(discussion.speakerOrder) ? discussion.speakerOrder : [];
  if (!order.length || !discussion.currentSpeakerId) {
    discussion.currentSpeakerId = null;
    return;
  }

  const currentIndex = Math.max(0, Number(discussion.speakerIndex || 0));
  const nextIndex = (currentIndex + 1) % order.length;
  const wrapped = nextIndex <= currentIndex;

  if (wrapped) {
    if (!discussion.cycleHadSpeech) {
      discussion.currentSpeakerId = null;
      return;
    }
    discussion.cycleHadSpeech = false;
    discussion.cycleNumber = Math.max(0, Number(discussion.cycleNumber || 0)) + 1;
  }

  discussion.speakerIndex = nextIndex;
  discussion.currentSpeakerId = order[nextIndex] || null;
}

function runMafiaBotAutoplay(room) {
  if (!room || room.status !== 'in_progress') return { acted: 0 };
  if (room.publicArena) return { acted: 0 };
  let acted = 0;

  if (room.phase === 'night') {
    const mafiaBots = room.players.filter((p) => p.alive && p.role === 'mafia' && p.isBot);
    for (const bot of mafiaBots) {
      if (room.actions?.night?.[bot.id]) continue;
      const target = room.players
        .filter((p) => p.alive && p.id !== bot.id && p.role !== 'mafia')
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      if (!target) continue;
      const result = mafiaGame.submitAction(mafiaRooms, { roomId: room.id, playerId: bot.id, type: 'nightKill', targetId: target.id });
      if (!result.ok) continue;
      acted += 1;
      if (room.status !== 'in_progress') break;
    }
  }

  if (room.status === 'in_progress' && room.phase === 'discussion') {
    while (room.status === 'in_progress' && room.phase === 'discussion') {
      const currentSpeakerId = room.discussion?.currentSpeakerId || null;
      const speaker = currentSpeakerId
        ? room.players.find((player) => player.id === currentSpeakerId)
        : null;
      if (!speaker || !speaker.alive || !speaker.isBot) break;

      const alreadySpoke = Boolean(room.discussion?.spokenByPlayerId?.[speaker.id]);
      const message = alreadySpoke ? '' : buildDeterministicDiscussionMessage(room, speaker);
      const type = message ? 'discussion' : 'pass';
      const result = mafiaGame.submitAction(mafiaRooms, {
        roomId: room.id,
        playerId: speaker.id,
        type,
        message,
        turnId: room.discussion?.turnId || null,
      });
      if (!result.ok) break;
      if (message) {
        room.discussion.spokenByPlayerId[speaker.id] = true;
        appendMafiaDiscussionMessage(room, speaker, message, {
          phase: room.phase,
          day: room.day,
        });
      }
      completeMafiaDiscussionTurn(room, { spoke: Boolean(message) });
      acted += 1;
    }
  }

  if (room.status === 'in_progress' && room.phase === 'voting') {
    const aliveBots = room.players.filter((p) => p.alive && p.isBot);
    for (const bot of aliveBots) {
      if (room.actions?.vote?.[bot.id]) continue;
      const target = pickDeterministicTarget(room.players, bot.id);
      if (!target) continue;
      const result = mafiaGame.submitAction(mafiaRooms, { roomId: room.id, playerId: bot.id, type: 'vote', targetId: target.id });
      if (result.ok) acted += 1;
      if (room.phase !== 'voting' || room.status !== 'in_progress') break;
    }
  }

  if (acted > 0) {
    logRoomEvent('mafia', room, 'BOTS_AUTOPLAYED', { acted, phase: room.phase, day: room.day, status: room.status });
  }
  return { acted };
}

function buildMafiaAgentDecisionPayload(room, player) {
  const alivePlayers = (room.players || [])
    .filter((p) => p.alive)
    .map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isSelf: p.id === player.id,
    }));

  return {
    roomId: room.id,
    playerId: player.id,
    phase: room.phase,
    day: room.day,
    role: player.role,
    phaseEndsAt: room.phaseEndsAt || null,
    turnId: room.discussion?.turnId || null,
    turnEndsAt: room.discussion?.turnEndsAt || null,
    currentSpeakerId: room.discussion?.currentSpeakerId || null,
    players: alivePlayers,
    tally: room.tally || {},
    events: (room.events || []).slice(-8),
  };
}

function sanitizeDiscussionTranscriptMessage(rawMessage) {
  return String(rawMessage || '').trim().replace(/\s+/g, ' ').slice(0, 280);
}

function appendMafiaDiscussionMessage(room, player, text, { phase, day } = {}) {
  const message = sanitizeDiscussionTranscriptMessage(text);
  if (!room?.id || !player?.id || !message) return null;

  const event = {
    type: 'DISCUSSION_MESSAGE',
    actorId: player.id,
    actorName: player.name,
    text: message,
    phase: phase || room.phase,
    day: Number(day || room.day || 0),
    at: Date.now(),
  };

  room.events = Array.isArray(room.events) ? room.events : [];
  room.events.push(event);
  if (room.events.length > 100) room.events = room.events.slice(-50);
  logRoomEvent('mafia', room, 'DISCUSSION_MESSAGE', {
    actorId: player.id,
    actorName: player.name,
    text: message,
    phase: event.phase,
    day: event.day,
    status: room.status,
  });
  return event;
}

function normalizeDiscussionTurnAction(type, rawMessage) {
  const normalizedType = String(type || '').trim();
  if (normalizedType === 'pass') {
    return { actionType: 'pass', transcriptMessage: '' };
  }

  if (normalizedType === 'ready') {
    const message = sanitizeDiscussionTranscriptMessage(rawMessage) || LIVE_AGENT_FALLBACK_DISCUSSION_MESSAGE;
    return { actionType: 'discussion', transcriptMessage: message };
  }

  if (normalizedType === 'discussion') {
    const message = sanitizeDiscussionTranscriptMessage(rawMessage);
    if (!message) {
      return { error: { code: 'MESSAGE_REQUIRED', message: 'Discussion messages require text' } };
    }
    return { actionType: 'discussion', transcriptMessage: message };
  }

  return { actionType: normalizedType, transcriptMessage: '' };
}

function emitMafiaLiveAgentRequests(room) {
  if (!room?.publicArena || room.status !== 'in_progress') return;
  const promptKey = room.phase === 'discussion'
    ? String(room.discussion?.turnId || '')
    : `${room.day}:${room.phase}`;
  if (!promptKey) return;
  if (room.liveAgentPromptKey === promptKey) return;

  let eventName = null;
  let targets = [];
  if (room.phase === 'night') {
    eventName = 'mafia:agent:night_request';
    targets = room.players.filter((p) => p.alive && p.isLiveAgent && p.role === 'mafia' && !room.actions?.night?.[p.id]);
  } else if (room.phase === 'discussion') {
    eventName = 'mafia:agent:discussion_request';
    const currentSpeakerId = room.discussion?.currentSpeakerId || null;
    const currentSpeaker = currentSpeakerId
      ? room.players.find((player) => player.id === currentSpeakerId)
      : null;
    targets = currentSpeaker && currentSpeaker.alive && currentSpeaker.isLiveAgent ? [currentSpeaker] : [];
  } else if (room.phase === 'voting') {
    eventName = 'mafia:agent:vote_request';
    targets = room.players.filter((p) => p.alive && p.isLiveAgent && !room.actions?.vote?.[p.id]);
  }
  if (!eventName || !targets.length) return;
  room.liveAgentPromptKey = promptKey;

  for (const player of targets) {
    const runtime = getAgentRuntime(player.agentId);
    if (!runtime?.connected || !runtime.socketId) continue;
    const sock = io.sockets.sockets.get(runtime.socketId);
    if (!sock) continue;
    sock.emit(eventName, buildMafiaAgentDecisionPayload(room, player));
  }
}

function releasePublicArenaRoom(room) {
  if (!room?.publicArena || !activeAgentMatchRooms.has(room.id)) return;
  activeAgentMatchRooms.delete(room.id);
  for (const player of room.players || []) {
    if (!player.isLiveAgent || !player.agentId) continue;
    const runtime = getAgentRuntime(player.agentId);
    clearAgentRuntimeAssignment(player.agentId, runtime?.connected ? 'idle' : 'offline');
  }
  setImmediate(() => {
    void processPublicArenaQueue();
  });
}

function handlePublicArenaRoomUpdate(room) {
  if (!room?.publicArena) return;
  if (room.status === 'finished') {
    releasePublicArenaRoom(room);
  } else {
    emitMafiaLiveAgentRequests(room);
  }
}

function scheduleMafiaPhase(room) {
  if (room.status !== 'in_progress') {
    room.phaseEndsAt = null;
    room._phaseScheduleKey = null;
    room.liveAgentPromptKey = null;
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    clearMafiaDiscussionTurn(room);
    handlePublicArenaRoomUpdate(room);
    return;
  }

  const phaseKey = `${room.matchId || room.id}:${room.status}:${room.phase}:${room.day}:${room.winner || ''}`;
  const ms = room.phase === 'night' ? MAFIA_PHASE_MS.night : room.phase === 'discussion' ? MAFIA_PHASE_MS.discussion : room.phase === 'voting' ? MAFIA_PHASE_MS.voting : 0;
  if (!ms) {
    room.phaseEndsAt = null;
    room._phaseScheduleKey = null;
  } else if (room._phaseScheduleKey !== phaseKey || !room.phaseEndsAt || room.phaseEndsAt <= Date.now()) {
    room._phaseScheduleKey = phaseKey;
    room.phaseEndsAt = Date.now() + ms;
    room.liveAgentPromptKey = null;
    roomScheduler.schedule({ namespace: 'mafia', roomId: room.id, slot: 'phase', delayMs: ms, token: phaseKey }, () => {
      if (room._phaseScheduleKey !== phaseKey) return;
      room._phaseScheduleKey = null;
      clearMafiaDiscussionTurn(room);
      const advanced = mafiaGame.forceAdvance(mafiaRooms, { roomId: room.id });
      if (advanced.ok) {
        if (room.status === 'finished') recordFirstMatchCompletion('mafia', room.id);
        emitMafiaRoom(room);
        handlePublicArenaRoomUpdate(room);
        scheduleMafiaPhase(room);
      }
    });
  }

  const auto = runMafiaBotAutoplay(room);
  if (auto.acted > 0) emitMafiaRoom(room);
  if (room.status !== 'in_progress') {
    room.phaseEndsAt = null;
    room._phaseScheduleKey = null;
    room.liveAgentPromptKey = null;
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    clearMafiaDiscussionTurn(room);
    handlePublicArenaRoomUpdate(room);
    return;
  }

  const currentPhaseKey = `${room.matchId || room.id}:${room.status}:${room.phase}:${room.day}:${room.winner || ''}`;
  if (currentPhaseKey !== phaseKey) {
    room._phaseScheduleKey = null;
    room.phaseEndsAt = null;
    room.liveAgentPromptKey = null;
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    clearMafiaDiscussionTurn(room);
    scheduleMafiaPhase(room);
    return;
  }

  if (room.phase === 'discussion') {
    const discussion = room.discussion;
    if (discussion) {
      while (discussion.currentSpeakerId) {
        const currentSpeaker = room.players.find((player) => player.id === discussion.currentSpeakerId);
        if (isAvailableDiscussionSpeaker(currentSpeaker)) break;
        completeMafiaDiscussionTurn(room, { spoke: false });
      }

      if (discussion.currentSpeakerId) {
        if (!discussion.turnId) {
          discussion.turnNumber = Math.max(0, Number(discussion.turnNumber || 0)) + 1;
          discussion.turnId = `${room.matchId || room.id}:${room.day}:${discussion.cycleNumber || 0}:${discussion.turnNumber}:${discussion.currentSpeakerId}`;
          const remainingPhaseMs = Math.max(1, Number(room.phaseEndsAt || 0) - Date.now());
          discussion.turnEndsAt = Date.now() + Math.min(MAFIA_DISCUSSION_TURN_MS, remainingPhaseMs);
        }

        if (room._discussionTurnKey !== discussion.turnId || !discussion.turnEndsAt || discussion.turnEndsAt <= Date.now()) {
          const turnId = discussion.turnId;
          const delayMs = Math.max(1, Number(discussion.turnEndsAt || 0) - Date.now());
          room._discussionTurnKey = turnId;
          roomScheduler.schedule({ namespace: 'mafia', roomId: room.id, slot: 'discussion-turn', delayMs, token: turnId }, () => {
            if (room.phase !== 'discussion' || !room.discussion || room.discussion.turnId !== turnId) return;
            completeMafiaDiscussionTurn(room, { spoke: false });
            emitMafiaRoom(room);
            handlePublicArenaRoomUpdate(room);
            scheduleMafiaPhase(room);
          });
        }
      } else {
        clearMafiaDiscussionTurn(room);
      }
    } else {
      clearMafiaDiscussionTurn(room);
    }
  } else {
    clearMafiaDiscussionTurn(room);
  }

  handlePublicArenaRoomUpdate(room);
}



function recordJoinHardeningEvent(mode, roomId, socketId, attemptedName) {
  const normalizedRoomId = String(roomId || '').trim().toUpperCase();
  if (!normalizedRoomId) return;
  recordSocketSeatCapBlocked(mode, normalizedRoomId);
  const store = getLobbyStore(mode);
  const room = store?.get(normalizedRoomId) || null;
  if (!room) return;
  logRoomEvent(mode, room, 'JOIN_BLOCKED_SOCKET_MULTI_SEAT', {
    socketId,
    attemptedName: String(attemptedName || '').slice(0, 24),
    status: room.status,
    phase: room.phase,
  });
}

io.use((socket, next) => {
  socket.data.correlationId = correlationId(socket.handshake.auth?.correlationId || socket.handshake.headers['x-correlation-id']);
  next();
});

// ── Socket rate limiting ──
const SOCKET_RATE_LIMIT = 30; // max events per window
const SOCKET_RATE_WINDOW_MS = 5000;
const socketEventCounts = new Map();

function checkSocketRateLimit(socketId) {
  const now = Date.now();
  let entry = socketEventCounts.get(socketId);
  if (!entry || now - entry.windowStart > SOCKET_RATE_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    socketEventCounts.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= SOCKET_RATE_LIMIT;
}

// Cleanup stale entries periodically.
const socketRateCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - SOCKET_RATE_WINDOW_MS * 2;
  for (const [id, entry] of socketEventCounts) {
    if (entry.windowStart < cutoff) socketEventCounts.delete(id);
  }
}, 30000);
if (typeof socketRateCleanupTimer.unref === 'function') {
  socketRateCleanupTimer.unref();
}

io.on('connection', (socket) => {
  // Rate limiting via socket.use middleware — blocks handler execution
  socket.use(([event, ...args], next) => {
    if (!checkSocketRateLimit(socket.id)) {
      logStructured('socket.rate_limited', { socketId: socket.id, event });
      const entry = socketEventCounts.get(socket.id);
      if (entry && entry.count > SOCKET_RATE_LIMIT * 3) {
        logStructured('socket.rate_limit_disconnect', { socketId: socket.id });
        socket.disconnect(true);
      }
      return next(new Error('rate limited'));
    }

    if (event.includes(':')) {
      const payload = args[0];
      const roomId = String(payload?.roomId || '').toUpperCase() || null;
      logStructured('socket.event', {
        correlationId: socket.data.correlationId,
        socketId: socket.id,
        event,
        roomId,
      });
    }
    next();
  });
  socket.on('agent:runtime:register', async (payload, cb) => {
    const runtimeAgentId = String(payload?.agentId || '').trim();
    const runtimeSecret = String(payload?.runtimeSecret || '').trim();
    const legacyToken = String(payload?.token || '').trim();
    const legacyProof = String(payload?.proof || '').trim();

    let agent = null;
    let connect = null;
    let authMode = '';

    if (runtimeAgentId && runtimeSecret) {
      const verified = await verifyAgentRuntimeCredential(runtimeAgentId, runtimeSecret);
      if (!verified) {
        return cb?.({ ok: false, error: { code: 'INVALID_RUNTIME_CREDENTIAL', message: 'invalid runtime credential' } });
      }
      agent = await ensureAgentProfileLoaded(runtimeAgentId);
      if (!agent) return cb?.({ ok: false, error: { code: 'AGENT_NOT_FOUND', message: 'agent not found' } });
      if (isArchivedAgentProfile(agent)) {
        return cb?.({ ok: false, error: { code: 'AGENT_ARCHIVED', message: 'agent archived' } });
      }
      authMode = 'runtime_secret';
    } else {
      connect = await getConnectSession(connectSessions, legacyToken);
      if (!connect) return cb?.({ ok: false, error: { code: 'CONNECT_SESSION_NOT_FOUND', message: 'connect session not found' } });
      if (isConnectSessionExpired(connect)) return cb?.({ ok: false, error: { code: 'CONNECT_SESSION_EXPIRED', message: 'connect session expired' } });
      const proofMatches = legacyProof
        && (
          legacyProof === String(connect.callbackProof || '').trim()
          || legacyProof === String(connect.accessToken || '').trim()
          || secretMatches(legacyProof, connect.callbackProofHash)
          || secretMatches(legacyProof, connect.accessTokenHash)
        );
      if (!proofMatches) {
        return cb?.({ ok: false, error: { code: 'INVALID_RUNTIME_PROOF', message: 'invalid runtime proof' } });
      }
      if (!connect.agentId) return cb?.({ ok: false, error: { code: 'AGENT_NOT_READY', message: 'agent profile not ready yet' } });
      agent = await ensureAgentProfileLoaded(connect.agentId);
      if (!agent) return cb?.({ ok: false, error: { code: 'AGENT_NOT_FOUND', message: 'agent not found' } });
      if (isArchivedAgentProfile(agent)) {
        return cb?.({ ok: false, error: { code: 'AGENT_ARCHIVED', message: 'agent archived' } });
      }
      authMode = 'legacy_connect_session';
    }

    const prior = getAgentRuntime(agent.id);
    const nextStatus = prior?.currentRoomId && prior?.currentPlayerId
      ? String(prior.status || 'in_match')
      : 'idle';

    socket.data.agentRuntime = {
      agentId: agent.id,
      connectSessionId: connect?.id || null,
      authMode,
    };
    bindAgentRuntimeSocket(agent.id, socket.id, {
      status: nextStatus,
      connectSessionId: connect?.id || null,
      connectedAt: prior?.connectedAt || Date.now(),
      currentRoomId: prior?.currentRoomId || null,
      currentPlayerId: prior?.currentPlayerId || null,
    });
    markAgentProfileConnection(agent.id, true, 'live runtime connected');
    await syncAgentProfileToPersistence(agent);
    persistState();
    await processPublicArenaQueue();
    cb?.({
      ok: true,
      agent: { id: agent.id, name: agent.name },
      arena: summarizeAgentArenaState(agent.id),
    });
  });

  function rejectRetiredManualMafiaSocket(cb) {
    if (manualMafiaSocketFeatureEnabled()) return false;
    cb?.(retiredManualMafiaSocketResponse());
    return true;
  }

  socket.on('mafia:room:create', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { name } = payload || {};
    const created = mafiaGame.createRoom(mafiaRooms, { hostName: name, hostSocketId: socket.id });
    if (!created.ok) return cb?.(created);
    socket.join(`mafia:${created.room.id}`);
    logRoomEvent('mafia', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
    emitMafiaRoom(created.room);
    cb?.({ ok: true, roomId: created.room.id, playerId: created.player.id, state: mafiaGame.toPublic(created.room) });
  });

  socket.on('mafia:room:join', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId, name } = payload || {};
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    if (normalizedRoomId && mafiaRooms.has(normalizedRoomId)) recordJoinAttempt('mafia', normalizedRoomId);
    const joined = mafiaGame.joinRoom(mafiaRooms, { roomId, name, socketId: socket.id });
    if (!joined.ok) {
      if (joined.error?.code === 'SOCKET_ALREADY_JOINED') {
        recordJoinHardeningEvent('mafia', normalizedRoomId, socket.id, name);
      }
      return cb?.(joined);
    }
    socket.join(`mafia:${joined.room.id}`);
    recordQuickJoinConversion('mafia', joined.room.id, joined.player.name);
    logRoomEvent('mafia', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, status: joined.room.status, phase: joined.room.phase });
    emitMafiaRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: mafiaGame.toPublic(joined.room) });
  });

  socket.on('mafia:room:watch', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    socket.join(`mafia:${room.id}`);
    cb?.({ ok: true, roomId: room.id, state: mafiaGame.toPublic(room) });
  });

  socket.on('mafia:autofill', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId, playerId, minPlayers } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('mafia', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('mafia:start', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId, playerId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = mafiaGame.startGame(mafiaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('mafia', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, day: started.room.day });
    scheduleMafiaPhase(started.room);
    emitMafiaRoom(started.room);
    handlePublicArenaRoomUpdate(started.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(started.room) });
  });

  socket.on('mafia:start-ready', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId, playerId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = startReadyLobby('mafia', roomId, playerId);
    cb?.(started);
  });

  socket.on('mafia:rematch', (payload, cb) => {
    if (rejectRetiredManualMafiaSocket(cb)) return;
    const { roomId, playerId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    roomScheduler.clearRoom(String(roomId || '').toUpperCase(), 'mafia');
    const reset = mafiaGame.prepareRematch(mafiaRooms, { roomId, hostPlayerId: playerId });
    if (!reset.ok) return cb?.(reset);
    const started = mafiaGame.startGame(mafiaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    const telemetry = recordRematch('mafia', started.room.id);
    incrementGrowthMetric('funnel.rematchStarts', 1);
    recordTelemetryEvent('mafia', started.room.id, 'rematch_clicked');
    const partyStreak = Math.max(0, Number(started.room.partyStreak || 0));
    if (partyStreak > 0) {
      telemetry.partyStreakExtended = Math.max(0, Number(telemetry.partyStreakExtended || 0)) + 1;
      recordTelemetryEvent('mafia', started.room.id, 'party_streak_extended');
    }
    logRoomEvent('mafia', started.room, 'REMATCH_STARTED', { status: started.room.status, phase: started.room.phase, day: started.room.day });
    scheduleMafiaPhase(started.room);
    emitMafiaRoom(started.room);
    handlePublicArenaRoomUpdate(started.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(started.room) });
  });

  socket.on('mafia:action', (payload, cb) => {
    const { roomId, playerId, type, targetId, message, turnId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    const player = room.players.find((entry) => entry.id === playerId);
    const transcriptPhase = room.phase;
    const transcriptDay = room.day;
    let actionType = type;
    let transcriptMessage = '';

    if (transcriptPhase === 'discussion' && ['discussion', 'pass', 'ready'].includes(String(type || '').trim())) {
      const normalized = normalizeDiscussionTurnAction(type, message);
      if (normalized.error) return cb?.({ ok: false, error: normalized.error });
      actionType = normalized.actionType;
      transcriptMessage = normalized.transcriptMessage;
    }

    const result = mafiaGame.submitAction(mafiaRooms, {
      roomId,
      playerId,
      type: actionType,
      targetId,
      message: transcriptMessage,
      turnId,
    });
    if (!result.ok) return cb?.(result);
    if (transcriptPhase === 'discussion') {
      if (transcriptMessage && player) {
        appendMafiaDiscussionMessage(result.room, player, transcriptMessage, {
          phase: transcriptPhase,
          day: transcriptDay,
        });
      }
      completeMafiaDiscussionTurn(result.room, { spoke: Boolean(transcriptMessage) });
    }
    recordRoomWinner('mafia', result.room);
    if (result.room.status === 'finished') recordFirstMatchCompletion('mafia', result.room.id);
    logRoomEvent('mafia', result.room, 'ACTION_SUBMITTED', {
      actorId: playerId,
      action: actionType,
      targetId: targetId || null,
      text: transcriptMessage || null,
      status: result.room.status,
      phase: result.room.phase,
      day: result.room.day,
      winner: result.room.winner || null,
    });
    scheduleMafiaPhase(result.room);
    emitMafiaRoom(result.room);
    handlePublicArenaRoomUpdate(result.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('mafia:agent:decision', (payload, cb) => {
    const { roomId, playerId, phase, type, targetId, message, turnId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player || !player.isLiveAgent) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Player is not a live agent seat' } });
    if (player.socketId !== socket.id) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    if (phase && phase !== room.phase) return cb?.({ ok: false, error: { code: 'STALE_PHASE', message: 'Decision does not match current phase' } });
    if (room.phase === 'discussion') {
      if (!turnId || turnId !== room.discussion?.turnId || (room.discussion?.turnEndsAt && room.discussion.turnEndsAt <= Date.now())) {
        return cb?.({ ok: false, error: { code: 'STALE_TURN', message: 'Decision does not match current discussion turn' } });
      }
    }

    const transcriptPhase = room.phase;
    const transcriptDay = room.day;
    let actionType = type;
    let transcriptMessage = '';

    if (transcriptPhase === 'discussion' && ['discussion', 'pass', 'ready'].includes(String(type || '').trim())) {
      const normalized = normalizeDiscussionTurnAction(type, message);
      if (normalized.error) return cb?.({ ok: false, error: normalized.error });
      actionType = normalized.actionType;
      transcriptMessage = normalized.transcriptMessage;
    }

    const result = mafiaGame.submitAction(mafiaRooms, {
      roomId,
      playerId,
      type: actionType,
      targetId,
      message: transcriptMessage,
      turnId,
    });
    if (!result.ok) return cb?.(result);
    if (transcriptPhase === 'discussion') {
      if (transcriptMessage) {
        appendMafiaDiscussionMessage(result.room, player, transcriptMessage, {
          phase: transcriptPhase,
          day: transcriptDay,
        });
      }
      completeMafiaDiscussionTurn(result.room, { spoke: Boolean(transcriptMessage) });
    } else if (transcriptMessage) {
      appendMafiaDiscussionMessage(result.room, player, transcriptMessage, {
        phase: transcriptPhase,
        day: transcriptDay,
      });
    }
    recordRoomWinner('mafia', result.room);
    if (result.room.status === 'finished') recordFirstMatchCompletion('mafia', result.room.id);
    logRoomEvent('mafia', result.room, 'LIVE_AGENT_DECISION', {
      actorId: playerId,
      actorName: player.name,
      action: actionType,
      targetId: targetId || null,
      text: transcriptMessage || null,
      status: result.room.status,
      phase: result.room.phase,
      day: result.room.day,
    });
    scheduleMafiaPhase(result.room);
    emitMafiaRoom(result.room);
    handlePublicArenaRoomUpdate(result.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('disconnect', () => {
    for (const room of mafiaRooms.values()) {
      const changed = mafiaGame.disconnectPlayer(mafiaRooms, { roomId: room.id, socketId: socket.id });
      if (changed) emitMafiaRoom(room);
    }

    const runtimeAgentId = agentRuntimeSockets.get(socket.id);
    if (runtimeAgentId && agentSocketIsAuthoritative(runtimeAgentId, socket.id)) {
      const runtime = getAgentRuntime(runtimeAgentId);
      if (runtime) {
        releaseAgentRuntimeSocket(runtimeAgentId, socket.id, { status: 'offline' });
        markAgentProfileConnection(runtimeAgentId, false, 'live runtime disconnected');
        void syncAgentProfileToPersistence(agentProfiles.get(runtimeAgentId));
        persistState();

        if (runtime.currentRoomId && runtime.currentPlayerId) {
          const room = mafiaRooms.get(runtime.currentRoomId);
          if (room) {
            const forfeited = mafiaGame.forfeitPlayer(mafiaRooms, {
              roomId: runtime.currentRoomId,
              playerId: runtime.currentPlayerId,
              reason: 'runtime_disconnect',
            });
            if (forfeited.ok) {
              emitMafiaRoom(room);
              handlePublicArenaRoomUpdate(room);
              scheduleMafiaPhase(room);
            }
          }
        }
      }
      setImmediate(() => {
        void processPublicArenaQueue();
      });
    }
  });
});

app.use((req, res, next) => {
  req.correlationId = correlationId(req.headers['x-correlation-id']);
  res.setHeader('X-Correlation-Id', req.correlationId);
  res.on('finish', () => {
    if (req.path === '/health') return;
    logStructured('http.request', {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
    });
  });
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (effectiveOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self' https: ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
});

// ── Rate Limiting ──
const rateLimitKey = (req) => ipKeyGenerator(req.ip || req.headers['x-forwarded-for'] || 'unknown');
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 100);
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 10);
const OPS_RATE_LIMIT_MAX = Number(process.env.OPS_RATE_LIMIT_MAX || 5);
const apiLimiter = rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: API_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const authLimiter = rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const opsLimiter = rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: OPS_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/ops/', opsLoopbackApiGate);
app.use('/api/ops/', opsLimiter);

app.use((req, _res, next) => {
  if (req.method === 'GET' && ['/', '/index.html', '/play.html', '/arena.html', '/for-agents.html', '/guess-the-agent.html'].includes(req.path)) {
    incrementGrowthMetric('funnel.visits', 1);
  }
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const ROOM_EVENTS_FILE = path.join(DATA_DIR, 'room-events.ndjson');
const GROWTH_METRICS_SNAPSHOT_NAME = 'growth_metrics_all_time';
const MAINTENANCE_CLEANUP_INTERVAL_MS = Math.max(5 * 60 * 1000, Number(process.env.MAINTENANCE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000));
const SESSION_RETENTION_GRACE_MS = Math.max(0, Number(process.env.SESSION_RETENTION_GRACE_MS || 7 * 24 * 60 * 60 * 1000));
const CONNECT_SESSION_RETENTION_GRACE_MS = Math.max(0, Number(process.env.CONNECT_SESSION_RETENTION_GRACE_MS || 7 * 24 * 60 * 60 * 1000));
const MAGIC_LINK_RETENTION_GRACE_MS = Math.max(0, Number(process.env.MAGIC_LINK_RETENTION_GRACE_MS || 7 * 24 * 60 * 60 * 1000));

const KPI_ROOM_EVENT_TYPES = new Set([
  'ROOM_CREATED',
  'PLAYER_JOINED',
  'GAME_STARTED',
  'REMATCH_STARTED',
  'LOBBY_START_READY',
  'LOBBY_AUTOFILLED',
]);

const DURABLE_GROWTH_METRIC_PATHS = [
  'funnel.visits',
  'funnel.quickJoinStarts',
  'funnel.connectSessionStarts',
  'funnel.firstMatchesCompleted',
  'funnel.rematchStarts',
  'referral.inviteSends',
];

const agentProfiles = new Map();
// pair vote caps removed: agent voting is unlimited except self/owner restrictions
const sessions = new Map();
const connectSessions = new Map();
const completedMatchRooms = new Set();
const COMPLETED_MATCH_RECORD_CAP = 500;
const IN_MEMORY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let growthMetrics = null;
let growthMetricsLoaded = false;
const maintenanceState = {
  cleanup: {
    lastRunAt: null,
    lastCompletedAt: null,
    durationMs: null,
    lastError: null,
    deleted: {
      sessions: 0,
      connectSessions: 0,
      magicLinkTokens: 0,
      cachedSessions: 0,
      cachedConnectSessions: 0,
    },
  },
};

function readFileSizeBytes(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch (_err) {
    return null;
  }
}

function expiresAtFromNow(ttlMs = IN_MEMORY_SESSION_TTL_MS) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function isExpiredIso(value) {
  const expiresAtMs = new Date(value || '').getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function setCachedSession(session) {
  if (!session?.token) return null;
  sessions.set(session.token, session);
  return session;
}

function getCachedSession(token) {
  const cached = sessions.get(String(token || '').trim());
  if (!cached) return null;
  if (cached.expiresAt && isExpiredIso(cached.expiresAt)) {
    sessions.delete(cached.token);
    return null;
  }
  return cached;
}

function toTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanupExpiredCachedSessions(graceMs = SESSION_RETENTION_GRACE_MS) {
  const cutoffMs = Date.now() - Math.max(0, Number(graceMs) || 0);
  let deleted = 0;
  for (const [token, session] of sessions.entries()) {
    if (toTimestampMs(session?.expiresAt || session?.expires_at) > cutoffMs) continue;
    sessions.delete(token);
    deleted += 1;
  }
  return deleted;
}

function cleanupExpiredCachedConnectSessions(graceMs = CONNECT_SESSION_RETENTION_GRACE_MS) {
  const cutoffMs = Date.now() - Math.max(0, Number(graceMs) || 0);
  let deleted = 0;
  for (const [id, connect] of connectSessions.entries()) {
    if (toTimestampMs(connect?.expiresAt || connect?.expires_at) > cutoffMs) continue;
    connectSessions.delete(id);
    deleted += 1;
  }
  return deleted;
}

async function cleanupExpiredPersistence() {
  const startedAt = Date.now();
  maintenanceState.cleanup.lastRunAt = new Date(startedAt).toISOString();

  try {
    const deleted = await cleanupExpiredRecords({
      sessionGraceMs: SESSION_RETENTION_GRACE_MS,
      connectSessionGraceMs: CONNECT_SESSION_RETENTION_GRACE_MS,
      magicLinkGraceMs: MAGIC_LINK_RETENTION_GRACE_MS,
      now: startedAt,
    });
    const cachedSessionsDeleted = cleanupExpiredCachedSessions(SESSION_RETENTION_GRACE_MS);
    const cachedConnectSessionsDeleted = cleanupExpiredCachedConnectSessions(CONNECT_SESSION_RETENTION_GRACE_MS);
    maintenanceState.cleanup.lastCompletedAt = new Date().toISOString();
    maintenanceState.cleanup.durationMs = Date.now() - startedAt;
    maintenanceState.cleanup.lastError = null;
    maintenanceState.cleanup.deleted = {
      sessions: Number(deleted.sessions || 0),
      connectSessions: Number(deleted.connectSessions || 0),
      magicLinkTokens: Number(deleted.magicLinkTokens || 0),
      cachedSessions: cachedSessionsDeleted,
      cachedConnectSessions: cachedConnectSessionsDeleted,
    };
    logStructured('maintenance.cleanup', {
      ...maintenanceState.cleanup.deleted,
      durationMs: maintenanceState.cleanup.durationMs,
    });
    return maintenanceState.cleanup.deleted;
  } catch (error) {
    maintenanceState.cleanup.lastCompletedAt = new Date().toISOString();
    maintenanceState.cleanup.durationMs = Date.now() - startedAt;
    maintenanceState.cleanup.lastError = error.message;
    logStructured('error.maintenanceCleanup', { error: error.message });
    throw error;
  }
}

function mergePersistedAgentRecord(record) {
  if (!record?.id) return null;
  const existing = agentProfiles.get(record.id) || null;
  const connectedAt = existing?.openclaw?.connectedAt || toTimestampMs(record.lastConnectedAt || record.last_connected_at) || null;
  const openclaw = {
    ...(existing?.openclaw || {}),
    mode: existing?.openclaw?.mode || 'cli',
    connected: Boolean(existing?.openclaw?.connected),
    connectedAt,
    note: record.openclawNote || record.openclaw_note || existing?.openclaw?.note || null,
  };
  const merged = ensureAgentRatingMirror({
    ...(existing || {}),
    id: record.id,
    owner: record.ownerEmail || record.owner_email || existing?.owner || null,
    ownerUserId: record.ownerUserId || record.owner_user_id || null,
    name: record.name || existing?.name || record.id,
    nameNormalized: record.nameNormalized || record.name_normalized || existing?.nameNormalized || normalizeAgentNameKey(record.name || existing?.name || record.id),
    deployed: record.deployed !== false,
    lifecycleState: record.lifecycleState || record.lifecycle_state || existing?.lifecycleState || 'active',
    archivedAt: record.archivedAt || record.archived_at || existing?.archivedAt || null,
    karma: Number(record.karma || existing?.karma || 0),
    persona: record.persona || existing?.persona || null,
    openclaw,
    createdAt: toTimestampMs(record.created_at) || existing?.createdAt || Date.now(),
  });
  agentProfiles.set(merged.id, merged);
  return merged;
}

async function syncAgentProfileToPersistence(agent) {
  if (!agent?.id) return null;
  const persisted = await upsertAgentRecord(agent);
  if (persisted) return mergePersistedAgentRecord(persisted);
  return agent;
}

async function ensureAgentProfileLoaded(agentId) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return null;
  const cached = agentProfiles.get(cleanAgentId);
  if (cached) return cached;
  const persisted = await getAgentRecordById(cleanAgentId);
  if (!persisted) return null;
  return mergePersistedAgentRecord(persisted);
}

async function hydratePersistedAgents() {
  for (const agent of [...agentProfiles.values()]) {
    await upsertAgentRecord(agent);
  }
  const persistedAgents = await listAllAgentRecords();
  for (const record of persistedAgents) mergePersistedAgentRecord(record);
}

async function issueAgentRuntimeCredential(agentId) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return null;
  const runtimeSecret = randomSecret(24);
  await createOrRotateAgentRuntimeCredential(cleanAgentId, hashSecret(runtimeSecret));
  return {
    agentId: cleanAgentId,
    runtimeSecret,
  };
}

async function verifyAgentRuntimeCredential(agentId, runtimeSecret) {
  const cleanAgentId = String(agentId || '').trim();
  const cleanSecret = String(runtimeSecret || '').trim();
  if (!cleanAgentId || !cleanSecret) return false;
  const credential = await getAgentRuntimeCredential(cleanAgentId);
  if (!credential || credential.revoked_at) return false;
  if (!secretMatches(cleanSecret, credential.secret_hash)) return false;
  await touchAgentRuntimeCredential(cleanAgentId);
  return true;
}

async function authorizeBoundAgentRequest(req) {
  const agentId = String(req.params?.id || req.headers['x-openclaw-agent-id'] || '').trim();
  const agentToken = String(
    readBearerToken(req)
      || req.headers['x-openclaw-agent-token']
      || req.headers['x-agent-token']
      || ''
  ).trim();
  if (!agentId || !agentToken) {
    return {
      ok: false,
      status: 401,
      error: 'Agent token required',
      code: 'AGENT_AUTH_REQUIRED',
    };
  }

  const verified = await verifyAgentRuntimeCredential(agentId, agentToken);
  if (!verified) {
    return {
      ok: false,
      status: 401,
      error: 'Invalid agent token',
      code: 'INVALID_AGENT_TOKEN',
    };
  }

  const agent = await ensureAgentProfileLoaded(agentId);
  if (!agent) {
    return {
      ok: false,
      status: 404,
      error: 'agent not found',
      code: 'AGENT_NOT_FOUND',
    };
  }
  if (isArchivedAgentProfile(agent)) {
    return {
      ok: false,
      status: 410,
      error: 'agent archived',
      code: 'AGENT_ARCHIVED',
    };
  }

  return { ok: true, agent };
}

async function archiveBoundAgent(agentId) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return null;

  const runtime = getAgentRuntime(cleanAgentId);
  if (runtime?.socketId) {
    io.sockets.sockets.get(runtime.socketId)?.disconnect(true);
  }
  setAgentRuntimeStatus(cleanAgentId, 'offline', {
    connected: false,
    socketId: null,
    currentRoomId: null,
    currentPlayerId: null,
  });

  await revokeAgentRuntimeCredential(cleanAgentId);

  const agent = await ensureAgentProfileLoaded(cleanAgentId);
  if (!agent) return null;
  agent.deployed = false;
  agent.lifecycleState = 'archived';
  agent.archivedAt = new Date().toISOString();
  markAgentProfileConnection(cleanAgentId, false, 'agent archived');

  const persisted = await archiveAgentRecord(cleanAgentId);
  if (persisted) mergePersistedAgentRecord(persisted);
  await syncAgentProfileToPersistence(agent);
  persistState();
  return agentProfiles.get(cleanAgentId) || agent;
}

function buildGrowthMetricsPayload(report, durableCounters = {}) {
  const counterValue = (key) => Math.max(0, Number(durableCounters?.[key] || 0));
  return {
    updatedAt: new Date().toISOString(),
    window: 'all_time',
    funnel: {
      visits: counterValue('funnel.visits'),
      connectSessionStarts: counterValue('funnel.connectSessionStarts'),
      quickJoinStarts: counterValue('funnel.quickJoinStarts'),
      firstMatchesCompleted: counterValue('funnel.firstMatchesCompleted'),
      rematchStarts: counterValue('funnel.rematchStarts'),
      d1ReturnRate: report.rematch.retentionProxy,
    },
    referral: {
      inviteSends: counterValue('referral.inviteSends'),
      inviteToFirstMatchConversion: 0,
    },
    kpi: {
      activationRate: report.funnel.activationRate,
      roomStartRate: report.funnel.roomStartRate,
      reconnectSuccessRate: report.reconnect.successRate,
      rematchRate: report.rematch.rematchRate,
      retentionProxy: report.rematch.retentionProxy,
      quickJoinConversionRate: report.quickJoin.conversionRate,
      fairnessSocketSeatCapBlockRate: report.fairness?.socketSeatCapBlockRate || 0,
    },
    fairness: report.fairness,
    byMode: report.byMode,
    sample: report.sample,
    notes: 'Auto-generated from durable counters + KPI room events + in-memory play telemetry via /api/ops/kpis.',
  };
}

function readMetricPath(source, path) {
  const [bucket, key] = String(path || '').split('.');
  if (!bucket || !key) return 0;
  return Math.max(0, Number(source?.[bucket]?.[key] || 0));
}

function buildEmptyGrowthMetrics() {
  return buildGrowthMetricsPayload(buildKpiReport({ events: [], playRoomTelemetry: new Map() }), {});
}

function mergeDurableGrowthCounters(snapshot, durableCounters = {}) {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : buildEmptyGrowthMetrics();
  const updatedAt = new Date(base.updatedAt || base.updated_at || '');
  return {
    ...base,
    updatedAt: Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : new Date().toISOString(),
    funnel: {
      ...(base.funnel || {}),
      visits: Math.max(0, Number(durableCounters['funnel.visits'] || 0)),
      connectSessionStarts: Math.max(0, Number(durableCounters['funnel.connectSessionStarts'] || 0)),
      quickJoinStarts: Math.max(0, Number(durableCounters['funnel.quickJoinStarts'] || 0)),
      firstMatchesCompleted: Math.max(0, Number(durableCounters['funnel.firstMatchesCompleted'] || 0)),
      rematchStarts: Math.max(0, Number(durableCounters['funnel.rematchStarts'] || 0)),
    },
    referral: {
      ...(base.referral || {}),
      inviteSends: Math.max(0, Number(durableCounters['referral.inviteSends'] || 0)),
    },
  };
}

async function loadGrowthMetrics() {
  const emptyMetrics = buildEmptyGrowthMetrics();
  try {
    const [snapshotRow, durableCounters] = await Promise.all([
      getOpsSnapshot(GROWTH_METRICS_SNAPSHOT_NAME),
      getMetricCounters(DURABLE_GROWTH_METRIC_PATHS),
    ]);
    growthMetrics = mergeDurableGrowthCounters(snapshotRow?.payload || emptyMetrics, durableCounters);
  } catch (err) {
    logStructured('error.loadGrowthMetrics', { error: err.message });
    growthMetrics = emptyMetrics;
  }
  growthMetricsLoaded = true;
  return growthMetrics;
}

function incrementGrowthMetric(path, amount = 1) {
  if (!growthMetrics) growthMetrics = buildEmptyGrowthMetrics();
  const cleanPath = String(path || '').trim();
  const [bucket, key] = cleanPath.split('.');
  if (!bucket || !key) return;
  if (!growthMetrics[bucket] || typeof growthMetrics[bucket] !== 'object') growthMetrics[bucket] = {};
  growthMetrics[bucket][key] = Math.max(0, Number(growthMetrics[bucket][key] || 0) + Number(amount || 0));
  growthMetrics.updatedAt = new Date().toISOString();

  if (DURABLE_GROWTH_METRIC_PATHS.includes(cleanPath)) {
    void incrementMetricCounter(cleanPath, amount).catch((err) => {
      logStructured('error.incrementMetricCounter', { error: err.message, path: cleanPath, amount });
    });
  }
}

async function collectKpiEvents() {
  const deduped = new Map();
  const addEvent = (event = {}) => {
    const mode = String(event.mode || '').toLowerCase().trim();
    const roomId = String(event.roomId || event.room_id || '').toUpperCase().trim();
    const type = String(event.type || '').trim();
    if (!mode || !roomId || !type || !KPI_ROOM_EVENT_TYPES.has(type)) return;
    const key = `${mode}:${roomId}:${type}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        mode,
        roomId,
        type,
        at: event.at || event.createdAt || event.created_at || Date.now(),
      });
    }
  };

  const persistedEventsPromise = listKpiRoomEvents().catch((err) => {
    logStructured('error.listKpiRoomEvents', { error: err.message });
    return [];
  });

  if (ROOM_EVENT_FILE_PERSISTENCE_ENABLED) {
    for (const event of loadEvents(ROOM_EVENTS_FILE)) addEvent(event);
  }

  if (typeof roomEvents.all === 'function') {
    for (const event of roomEvents.all()) addEvent(event);
  }

  for (const event of await persistedEventsPromise) addEvent(event);

  return [...deduped.values()];
}

async function snapshotKpis() {
  const events = await collectKpiEvents();
  return buildKpiReport({ events, playRoomTelemetry });
}

async function persistGrowthMetricsSnapshot() {
  const [report, durableCounters] = await Promise.all([
    snapshotKpis(),
    getMetricCounters(DURABLE_GROWTH_METRIC_PATHS),
  ]);
  const mergedCounters = { ...durableCounters };
  for (const path of DURABLE_GROWTH_METRIC_PATHS) {
    mergedCounters[path] = Math.max(
      Math.max(0, Number(durableCounters[path] || 0)),
      readMetricPath(growthMetrics, path),
    );
  }
  const payload = buildGrowthMetricsPayload(report, mergedCounters);
  growthMetrics = payload;
  growthMetricsLoaded = true;

  try {
    await saveOpsSnapshot(GROWTH_METRICS_SNAPSHOT_NAME, payload);
  } catch (err) {
    logStructured('error.saveOpsSnapshot', { error: err.message, name: GROWTH_METRICS_SNAPSHOT_NAME });
  }

  return payload;
}

function roundCountForRoom(room) {
  return Number(room?.round || room?.day || room?.turn || 0);
}

function buildMatchRecordFromRoom(mode, roomId, room) {
  if (!room) return null;
  return {
    id: room.matchId || shortId(12),
    roomId,
    mode,
    winner: room.winner || room.lastWinner?.name || null,
    rounds: roundCountForRoom(room),
    durationMs: room.startedAt ? Math.max(0, (room.finishedAt || Date.now()) - room.startedAt) : null,
    startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
    finishedAt: room.finishedAt ? new Date(room.finishedAt).toISOString() : new Date().toISOString(),
    partyChainId: room.partyChainId || null,
    partyStreak: Number(room.partyStreak || 0),
    players: (room.players || []).map((player, index) => ({
      userId: player.userId || player.agentId || null,
      agentId: player.agentId || player.userId || null,
      name: player.name,
      role: player.role || null,
      isBot: Boolean(player.isBot),
      survived: player.alive !== false,
      placement: index + 1,
      nightKillCredits: Number(room.nightKillCredits?.[player.id] || 0),
    })),
  };
}

function recordFirstMatchCompletion(mode, roomId) {
  const store = getLobbyStore(mode);
  const room = store?.get(roomId);
  if (!room) return;

  const key = telemetryKey(mode, room.matchId || roomId);
  if (completedMatchRooms.has(key)) return;
  completedMatchRooms.add(key);
  incrementGrowthMetric('funnel.firstMatchesCompleted', 1);

  try {
    const matchRecord = buildMatchRecordFromRoom(mode, roomId, room);
    if (!matchRecord) return;
    completedMatchRecords.unshift(matchRecord);
    if (completedMatchRecords.length > COMPLETED_MATCH_RECORD_CAP) completedMatchRecords.length = COMPLETED_MATCH_RECORD_CAP;
    void recordMatch({
      ...matchRecord,
      currentRatings: buildCurrentRatingsForMatch(matchRecord),
    })
      .then((recorded) => {
        matchRecord.ratingUpdates = Array.isArray(recorded?.ratingUpdates) ? recorded.ratingUpdates : [];
        syncAgentRatingMirrors(matchRecord.ratingUpdates);
      })
      .catch((err) => {
        logStructured('error.recordMatch', { error: err.message, mode, roomId, matchId: matchRecord.id });
      });
  } catch (err) {
    logStructured('error.recordMatch', { error: err.message });
  }
}

function normalizeLeaderboardWindow(rawWindow) {
  const value = String(rawWindow || '12h').trim().toLowerCase();
  if (value === 'all') return { key: 'all', hours: null, label: 'All time' };
  if (value === '24h') return { key: '24h', hours: 24, label: '24 hours' };
  return { key: '12h', hours: 12, label: '12 hours' };
}

function computeMatchWin(match) {
  const winner = String(match?.winner || '').toLowerCase();
  const role = String(match?.role || '').toLowerCase();
  return Boolean(winner && role && winner === role);
}

function badgesForEntry(entry) {
  const badges = [];
  const gamesPlayed = Number(entry.gamesPlayed || 0);
  const wins = Number(entry.wins || 0);
  const winRate = Number(entry.winRate || 0);
  const survivalRate = Number(entry.survivalRate || 0);

  if (wins >= 3) badges.push('Hot Streak');
  if (gamesPlayed >= 10) badges.push('Volume Grinder');
  if (gamesPlayed >= 5 && winRate >= 70) badges.push('Closer');
  if (gamesPlayed >= 5 && survivalRate >= 80) badges.push('Iron Wall');

  return badges.slice(0, 3);
}

function summarizeLeaderboardEntry(entry) {
  const gamesPlayed = Number(entry.games_played || entry.gamesPlayed || 0);
  const wins = Number(entry.wins || 0);
  const survivals = Number(entry.survivals || entry.survivalCount || 0);
  const avgDurationMs = Number(entry.avg_duration_ms || entry.avgDurationMs || 0) || null;
  const rating = normalizeRatingSnapshot({
    mmr: entry.mmr,
    peakMmr: entry.peak_mmr || entry.peakMmr,
    ratedMatches: entry.rated_matches || entry.ratedMatches,
    lastRatingDelta: entry.last_delta || entry.lastDelta || entry.lastRatingDelta,
  });
  const winRate = gamesPlayed ? Math.round((wins / gamesPlayed) * 100) : 0;
  const survivalRate = gamesPlayed ? Math.round((survivals / gamesPlayed) * 100) : 0;

  const summary = {
    id: String(entry.id || '').trim() || String(entry.name || '').trim(),
    name: String(entry.name || 'Unknown').trim() || 'Unknown',
    gamesPlayed,
    wins,
    losses: Math.max(0, gamesPlayed - wins),
    survivalRate,
    winRate,
    avgDurationMs,
    lastPlayedAt: entry.last_played_at || entry.lastPlayedAt || null,
    mmr: rating.mmr,
    peakMmr: rating.peakMmr,
    ratedMatches: rating.ratedMatches,
    lastRatingDelta: rating.lastRatingDelta,
    isProvisional: rating.isProvisional,
  };
  summary.badges = badgesForEntry(summary);
  return summary;
}

function buildPublicArenaState(arena = null) {
  const queueStatus = String(arena?.queueStatus || 'offline').trim() || 'offline';
  return {
    runtimeConnected: Boolean(arena?.runtimeConnected),
    queueStatus,
    isLive: Boolean(arena?.isLive || arena?.activeRoomId || queueStatus === 'in_match'),
  };
}

function decorateLeaderboardEntry(entry) {
  const agent = agentProfiles.get(entry.id);
  const arena = agent ? summarizeAgentArenaState(agent.id) : {
    runtimeConnected: false,
    queueStatus: 'offline',
    activeRoomId: null,
    requiredAgents: 6,
  };
  const publicArena = buildPublicArenaState(arena);
  return {
    ...entry,
    ...publicArena,
  };
}

function buildLeaderboardFromMemory({ mode = 'mafia', windowHours = null, limit = 25 } = {}) {
  const cutoffMs = windowHours ? Date.now() - (windowHours * 60 * 60 * 1000) : null;
  const grouped = new Map();

  for (const match of completedMatchRecords) {
    if (!match || match.mode !== mode) continue;
    const finishedAtMs = match.finishedAt ? new Date(match.finishedAt).getTime() : NaN;
    if (cutoffMs && Number.isFinite(finishedAtMs) && finishedAtMs < cutoffMs) continue;

    for (const player of match.players || []) {
      if (!player || player.isBot) continue;
      const id = String(player.userId || player.name || '').trim();
      if (!id) continue;
      const current = grouped.get(id) || {
        id,
        name: player.name || id,
        gamesPlayed: 0,
        wins: 0,
        survivalCount: 0,
        totalDurationMs: 0,
        durationSamples: 0,
        lastPlayedAt: null,
      };

      current.gamesPlayed += 1;
      if (String(player.role || '').toLowerCase() === String(match.winner || '').toLowerCase()) current.wins += 1;
      if (player.survived) current.survivalCount += 1;
      if (Number(match.durationMs) > 0) {
        current.totalDurationMs += Number(match.durationMs);
        current.durationSamples += 1;
      }
      if (!current.lastPlayedAt || String(match.finishedAt || '') > String(current.lastPlayedAt)) {
        current.lastPlayedAt = match.finishedAt || null;
        current.name = player.name || current.name;
      }
      grouped.set(id, current);
    }
  }

  return [...grouped.values()]
    .map((entry) => summarizeLeaderboardEntry({
      ...entry,
      ...getAgentRatingMirror(entry.id),
      avgDurationMs: entry.durationSamples ? Math.round(entry.totalDurationMs / entry.durationSamples) : null,
    }))
    .sort((a, b) => b.mmr - a.mmr || b.wins - a.wins || b.gamesPlayed - a.gamesPlayed || String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')))
    .slice(0, limit);
}

async function getLeaderboardSummary({ mode = 'mafia', window = '12h', limit = 25 } = {}) {
  const normalizedWindow = normalizeLeaderboardWindow(window);
  let entries = [];
  let source = 'memory';

  try {
    entries = await getLeaderboardEntries({ mode, windowHours: normalizedWindow.hours, limit }) || [];
    if (entries.length) source = 'database';
  } catch (err) {
    logStructured('error.getLeaderboardEntries', { error: err.message, mode, window: normalizedWindow.key });
  }

  if (!entries.length) {
    entries = buildLeaderboardFromMemory({ mode, windowHours: normalizedWindow.hours, limit });
  } else {
    entries = entries.map((entry) => summarizeLeaderboardEntry(entry));
  }

  entries = entries.map((entry) => decorateLeaderboardEntry(entry));

  return {
    mode,
    window: normalizedWindow.key,
    windowLabel: normalizedWindow.label,
    source,
    topAgents: entries,
    windows: [
      { key: '12h', label: '12h' },
      { key: '24h', label: '24h' },
      { key: 'all', label: 'All' },
    ],
  };
}

function getPlayerMatchesFallback(userId, limit = 10) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return [];
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  return completedMatchRecords
    .flatMap((match) => (match.players || [])
      .filter((player) => String(player.userId || '').trim() === normalizedUserId)
      .map((player) => ({
        id: match.id,
        room_id: match.roomId,
        roomId: match.roomId,
        mode: match.mode,
        winner: match.winner,
        rounds: match.rounds,
        duration_ms: match.durationMs,
        durationMs: match.durationMs,
        started_at: match.startedAt || null,
        startedAt: match.startedAt || null,
        finished_at: match.finishedAt || null,
        finishedAt: match.finishedAt || null,
        party_chain_id: match.partyChainId || null,
        partyChainId: match.partyChainId || null,
        party_streak: Number(match.partyStreak || 0),
        partyStreak: Number(match.partyStreak || 0),
        player_name: player.name,
        playerName: player.name,
        role: player.role,
        survived: Boolean(player.survived),
        placement: player.placement || null,
        night_kill_credits: Number(player.nightKillCredits || 0),
        nightKillCredits: Number(player.nightKillCredits || 0),
      })))
    .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))
    .slice(0, cappedLimit);
}

function getGlobalStatsFallback(mode = 'mafia') {
  const uniqueAgents = new Set();
  let totalGames = 0;
  let townWins = 0;
  let totalEliminations = 0;
  let mafiasCaught = 0;

  for (const match of completedMatchRecords) {
    if (!match || match.mode !== mode) continue;
    totalGames += 1;
    if (String(match.winner || '').toLowerCase() === 'town') townWins += 1;
    for (const player of match.players || []) {
      if (!player) continue;
      if (!player.isBot) {
        const identity = String(player.userId || player.name || '').trim();
        if (identity) uniqueAgents.add(identity);
      }
      if (player.survived === false) totalEliminations += 1;
      if (player.survived === false && String(player.role || '').toLowerCase() === 'mafia') mafiasCaught += 1;
    }
  }

  return {
    totalGames,
    townWins,
    uniqueAgents: uniqueAgents.size,
    totalEliminations,
    mafiasCaught,
  };
}

function buildMemoryStatsMeta() {
  const capped = completedMatchRecords.length >= COMPLETED_MATCH_RECORD_CAP;
  return {
    source: 'memory',
    durable: false,
    capped,
    durability: capped ? 'capped_memory' : 'ephemeral_memory',
  };
}

function emptyAgentStats() {
  return {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    survivals: 0,
    survivalRate: 0,
    eliminationsSuffered: 0,
    mafiaGames: 0,
    mafiaWins: 0,
    townGames: 0,
    townWins: 0,
    nightKillCredits: 0,
    lastPlayedAt: null,
    mmr: DEFAULT_MMR,
    peakMmr: DEFAULT_MMR,
    ratedMatches: 0,
    lastRatingDelta: 0,
    isProvisional: true,
    byRole: {
      mafia: { gamesPlayed: 0, wins: 0 },
      town: { gamesPlayed: 0, wins: 0 },
    },
  };
}

function getAgentStatsFallback(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return null;

  const summary = emptyAgentStats();
  const rating = getAgentRatingMirror(normalizedAgentId);
  summary.mmr = rating.mmr;
  summary.peakMmr = rating.peakMmr;
  summary.ratedMatches = rating.ratedMatches;
  summary.lastRatingDelta = rating.lastRatingDelta;
  summary.isProvisional = rating.isProvisional;

  for (const match of completedMatchRecords) {
    if (!match) continue;
    const player = (match.players || []).find((entry) => String(entry.userId || '').trim() === normalizedAgentId);
    if (!player) continue;

    summary.gamesPlayed += 1;
    if (computeMatchWin({ winner: match.winner, role: player.role })) summary.wins += 1;
    if (player.survived) summary.survivals += 1;
    if (!player.survived) summary.eliminationsSuffered += 1;
    if (String(player.role || '').toLowerCase() === 'mafia') {
      summary.mafiaGames += 1;
      if (String(match.winner || '').toLowerCase() === 'mafia') summary.mafiaWins += 1;
    }
    if (String(player.role || '').toLowerCase() === 'town') {
      summary.townGames += 1;
      if (String(match.winner || '').toLowerCase() === 'town') summary.townWins += 1;
    }
    summary.nightKillCredits += Number(player.nightKillCredits || 0);
    if (!summary.lastPlayedAt || String(match.finishedAt || '') > String(summary.lastPlayedAt || '')) {
      summary.lastPlayedAt = match.finishedAt || null;
    }
  }

  summary.losses = Math.max(0, summary.gamesPlayed - summary.wins);
  summary.winRate = summary.gamesPlayed ? Math.round((summary.wins / summary.gamesPlayed) * 100) : 0;
  summary.survivalRate = summary.gamesPlayed ? Math.round((summary.survivals / summary.gamesPlayed) * 100) : 0;
  summary.byRole = {
    mafia: {
      gamesPlayed: summary.mafiaGames,
      wins: summary.mafiaWins,
    },
    town: {
      gamesPlayed: summary.townGames,
      wins: summary.townWins,
    },
  };

  return summary;
}

async function buildGlobalStats(mode = 'mafia') {
  try {
    const persisted = await getGlobalStats(mode);
    if (persisted) {
      return {
        stats: persisted,
        source: 'database',
        durable: true,
        capped: false,
        durability: 'database',
      };
    }
  } catch (err) {
    logStructured('error.getGlobalStats', { error: err.message, mode });
  }
  return {
    stats: getGlobalStatsFallback(mode),
    ...buildMemoryStatsMeta(),
  };
}

async function buildOwnedAgentStats(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return null;

  try {
    const persisted = await getAgentStats(normalizedAgentId);
    if (persisted) {
      return {
        stats: persisted,
        source: 'database',
        durable: true,
        capped: false,
        durability: 'database',
      };
    }
  } catch (err) {
    logStructured('error.getAgentStats', { error: err.message, agentId: normalizedAgentId });
  }

  return {
    stats: getAgentStatsFallback(normalizedAgentId),
    ...buildMemoryStatsMeta(),
  };
}

async function buildMatchBaseline(mode = 'mafia') {
  let baseline = null;
  try {
    baseline = await getMatchBaselineSummary({ mode });
  } catch (err) {
    logStructured('error.getMatchBaselineSummary', { error: err.message, mode });
  }

  if (!baseline) {
    const finishedMatches = completedMatchRecords
      .filter((match) => match?.mode === mode && Number(match.durationMs) > 0)
      .map((match) => ({
        roomId: match.roomId,
        durationMs: Number(match.durationMs),
        finishedAt: match.finishedAt ? new Date(match.finishedAt).getTime() : NaN,
      }))
      .sort((a, b) => b.finishedAt - a.finishedAt);

    const durations = finishedMatches.map((entry) => entry.durationMs).filter((value) => value > 0);
    const avgDurationMs = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null;

    baseline = {
      sampleSize: durations.length,
      avgDurationMs,
      fastestDurationMs: durations.length ? Math.min(...durations) : null,
      slowestDurationMs: durations.length ? Math.max(...durations) : null,
      latestCompletedRoomId: finishedMatches[0]?.roomId || null,
      latestCompletedAt: Number.isFinite(finishedMatches[0]?.finishedAt)
        ? new Date(finishedMatches[0].finishedAt).toISOString()
        : null,
    };
  }

  return {
    mode,
    sampleSize: baseline.sampleSize || 0,
    avgDurationMs: baseline.avgDurationMs || null,
    fastestDurationMs: baseline.fastestDurationMs || null,
    slowestDurationMs: baseline.slowestDurationMs || null,
    estimatedGamesPerHour: baseline.avgDurationMs ? Number((3600000 / baseline.avgDurationMs).toFixed(1)) : null,
    estimatedGamesPer12Hours: baseline.avgDurationMs ? Number(((12 * 3600000) / baseline.avgDurationMs).toFixed(1)) : null,
    latestCompletedRoomId: baseline.latestCompletedRoomId || null,
    latestCompletedAt: baseline.latestCompletedAt || null,
  };
}

function averageNumber(values = []) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function buildRatingHealthFallback(mode = 'mafia') {
  const matches = completedMatchRecords.filter((match) => match?.mode === mode);
  const totalGames = matches.length;
  const townWins = matches.filter((match) => String(match?.winner || '').toLowerCase() === 'town').length;
  const mafiaWins = matches.filter((match) => String(match?.winner || '').toLowerCase() === 'mafia').length;
  const townDeltas = [];
  const mafiaDeltas = [];

  for (const match of matches) {
    for (const update of match?.ratingUpdates || []) {
      const role = String(update?.role || '').toLowerCase();
      if (role === 'town') townDeltas.push(Number(update.delta || 0));
      if (role === 'mafia') mafiaDeltas.push(Number(update.delta || 0));
    }
  }

  const ratedAgents = [...agentProfiles.values()]
    .map((agent) => ensureAgentRatingMirror(agent))
    .filter((agent) => Number(agent?.ratedMatches || 0) > 0);
  const provisionalAgents = ratedAgents.filter((agent) => Number(agent.ratedMatches || 0) < 10).length;
  const averageMmr = ratedAgents.length
    ? Math.round(ratedAgents.reduce((sum, agent) => sum + Number(agent.mmr || DEFAULT_MMR), 0) / ratedAgents.length)
    : DEFAULT_MMR;

  return {
    mode,
    sampleSize: totalGames,
    ratedMatchCount: matches.filter((match) => Array.isArray(match?.ratingUpdates) && match.ratingUpdates.length > 0).length,
    townWinRate: totalGames ? Number(((townWins / totalGames) * 100).toFixed(1)) : 0,
    mafiaWinRate: totalGames ? Number(((mafiaWins / totalGames) * 100).toFixed(1)) : 0,
    averageMmr,
    avgDeltaByRole: {
      town: averageNumber(townDeltas),
      mafia: averageNumber(mafiaDeltas),
    },
    ratedAgents: ratedAgents.length,
    provisionalAgents,
    provisionalShare: ratedAgents.length ? Number(((provisionalAgents / ratedAgents.length) * 100).toFixed(1)) : 0,
  };
}

let _persistDirty = false;
let _persistTimer = null;

function _flushState() {
  _persistTimer = null;
  _persistDirty = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const serializable = {
      agents: [...agentProfiles.values()],
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializable, null, 2));
  } catch (err) {
    logStructured('error.persistState', { error: err.message });
  }
}

function persistState() {
  _persistDirty = true;
  if (!_persistTimer) {
    _persistTimer = setTimeout(_flushState, 5000);
  }
}

let _stateLoaded = false;
function loadState() {
  if (_stateLoaded) return;
  _stateLoaded = true;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (parsed.agents || []).forEach((a) => {
      ensureAgentRatingMirror(a);
      agentProfiles.set(a.id, a);
    });
  } catch (err) {
    logStructured('error.loadState', { error: err.message });
  }
}

function isPublicRankedAgent(agent) {
  if (!agent) return false;
  if (agent.owner === 'system') return false;
  if (isArchivedAgentProfile(agent)) return false;
  return true;
}

function isEnabledPublicMode(mode) {
  return mode === PUBLIC_LAUNCH_MODE;
}

function listConnectedLaunchAgents() {
  return [...agentProfiles.values()].filter((agent) => {
    if (!isPublicRankedAgent(agent)) return false;
    if (!agent.deployed) return false;
    return Boolean(liveAgentRuntimes.get(agent.id)?.connected);
  });
}

function buildArenaAvailability() {
  const connectedAgents = listConnectedLaunchAgents();
  const requiredAgents = PUBLIC_ARENA_REQUIRED_AGENTS;
  return {
    mode: PUBLIC_LAUNCH_MODE,
    connectedAgents: connectedAgents.length,
    requiredAgents,
    missingAgents: Math.max(0, requiredAgents - connectedAgents.length),
    canStart: connectedAgents.length >= requiredAgents,
  };
}

function buildAgentArenaUrl(agentId, arena = summarizeAgentArenaState(agentId)) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return '/connect.html';
  const params = new URLSearchParams({ agentId: cleanAgentId });
  return `/connect.html?${params.toString()}`;
}

async function resolveSiteSession(req) {
  const token = readSiteSessionToken(req);
  if (!token) return null;

  try {
    const [session, user] = await Promise.all([
      getSessionByToken(token),
      getUserByToken(token),
    ]);
    if (session || user) {
      return {
        token,
        userId: user?.id || session?.user_id || null,
        email: user?.email || null,
        displayName: user?.display_name || null,
        agentId: user?.agent_id || null,
        primaryAgentId: user?.agent_id || null,
        isAnonymous: !!user?.is_anonymous,
        expiresAt: session?.expires_at || null,
        durable: true,
      };
    }
  } catch (err) {
    logStructured('error.resolveSiteSession', { error: err.message });
    if (IS_PRODUCTION) return null;
  }

  // Non-production fallback: check in-memory session cache
  const fallback = getCachedSession(token);
  if (!fallback) return null;
  return {
    token,
    userId: fallback.userId || null,
    email: fallback.email || null,
    displayName: fallback.displayName || null,
    agentId: fallback.agentId || null,
    primaryAgentId: fallback.agentId || null,
    isAnonymous: !fallback.email,
    expiresAt: fallback.expiresAt || null,
    durable: false,
  };
}

function updateCachedUserPrimaryAgent(userId, agentId) {
  for (const session of sessions.values()) {
    if (session?.expiresAt && isExpiredIso(session.expiresAt)) continue;
    if (session?.userId === userId) session.agentId = agentId;
  }
}

async function rememberUserPrimaryAgent(userId, agentId) {
  const cleanUserId = String(userId || '').trim();
  const cleanAgentId = String(agentId || '').trim() || null;
  if (!cleanUserId) return;
  try {
    await setUserAgentId(cleanUserId, cleanAgentId);
  } catch (err) {
    logStructured('warn.userPrimaryAgent.persistence_unavailable', {
      userId: cleanUserId,
      agentId: cleanAgentId,
      error: err.message,
    });
    if (IS_PRODUCTION) throw err;
  }
  updateCachedUserPrimaryAgent(cleanUserId, cleanAgentId);
}

async function assignAgentOwnerUserId(agentId, ownerUserId, { ifMissing = false } = {}) {
  const cleanAgentId = String(agentId || '').trim();
  const cleanUserId = String(ownerUserId || '').trim();
  if (!cleanAgentId || !cleanUserId) return null;

  const agent = await ensureAgentProfileLoaded(cleanAgentId);
  if (!agent) return null;

  const existingOwnerUserId = String(agent.ownerUserId || '').trim();
  if (ifMissing && existingOwnerUserId && existingOwnerUserId !== cleanUserId) return null;
  if (existingOwnerUserId === cleanUserId) return agent;

  const ownerUser = await getUserById(cleanUserId).catch(() => null);
  agent.ownerUserId = cleanUserId;
  if (ownerUser?.email) agent.owner = ownerUser.email;
  await syncAgentProfileToPersistence(agent);
  persistState();
  return agent;
}

async function rescueLegacyOwnedAgentOwnership(ownerUserId, primaryAgentId) {
  const cleanUserId = String(ownerUserId || '').trim();
  const cleanAgentId = String(primaryAgentId || '').trim();
  if (!cleanUserId || !cleanAgentId) return null;
  return assignAgentOwnerUserId(cleanAgentId, cleanUserId, { ifMissing: true });
}

function getAgentLastConnectedAt(agent) {
  const runtime = getAgentRuntime(agent?.id);
  return Number(runtime?.connectedAt || agent?.openclaw?.connectedAt || 0);
}

function toActivityTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toActivityIso(value) {
  const timestamp = toActivityTimestamp(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function compareOwnedAgentSummaries(a, b) {
  const aLive = Boolean(a?.arena?.isLive);
  const bLive = Boolean(b?.arena?.isLive);
  if (aLive !== bLive) return aLive ? -1 : 1;

  const aRuntimeConnected = Boolean(a?.arena?.runtimeConnected);
  const bRuntimeConnected = Boolean(b?.arena?.runtimeConnected);
  if (aRuntimeConnected !== bRuntimeConnected) return aRuntimeConnected ? -1 : 1;

  const activityDelta = toActivityTimestamp(b?.activityAt) - toActivityTimestamp(a?.activityAt);
  if (activityDelta !== 0) return activityDelta;

  return String(a?.name || a?.id || '').localeCompare(String(b?.name || b?.id || ''));
}

async function listOwnedAgentsForUser(ownerUserId) {
  const cleanUserId = String(ownerUserId || '').trim();
  if (!cleanUserId) return [];
  const persistedAgents = await listAgentRecordsByOwnerUserId(cleanUserId).catch(() => []);
  for (const record of persistedAgents) mergePersistedAgentRecord(record);
  return [...agentProfiles.values()]
    .filter((agent) => String(agent?.ownerUserId || '').trim() === cleanUserId);
}

function summarizeOwnedAgentProfile(agentOrId, { stats = null } = {}) {
  const agent = typeof agentOrId === 'string'
    ? agentProfiles.get(String(agentOrId || '').trim())
    : agentOrId;
  if (!agent?.id) return null;
  ensureAgentRatingMirror(agent);
  const lastConnectedAt = toActivityIso(getAgentLastConnectedAt(agent));
  const lastPlayedAt = stats?.lastPlayedAt || null;
  const activityAt = toActivityIso(Math.max(
    toActivityTimestamp(lastConnectedAt),
    toActivityTimestamp(lastPlayedAt),
  ));
  const arena = {
    ...buildPublicArenaState(summarizeAgentArenaState(agent.id)),
    ...buildArenaAvailability(),
  };
  return {
    id: agent.id,
    name: agent.name,
    deployed: !!agent.deployed,
    persona: agent.persona || null,
    arenaUrl: buildAgentArenaUrl(agent.id, arena),
    watchUrl: null,
    arena,
    gamesPlayed: Number(stats?.gamesPlayed || 0),
    mmr: Number(stats?.mmr ?? agent.mmr ?? DEFAULT_MMR),
    peakMmr: Number(stats?.peakMmr ?? agent.peakMmr ?? DEFAULT_MMR),
    ratedMatches: Number(stats?.ratedMatches ?? agent.ratedMatches ?? 0),
    lastRatingDelta: Number(stats?.lastRatingDelta ?? agent.lastRatingDelta ?? 0),
    isProvisional: Boolean(stats?.isProvisional ?? normalizeRatingSnapshot(agent).isProvisional),
    lastPlayedAt,
    lastConnectedAt,
    activityAt,
  };
}

async function listRenderableOwnedAgentsForUser(ownerUserId) {
  const ownedAgents = await listOwnedAgentsForUser(ownerUserId);
  if (!ownedAgents.length) return [];

  const summaries = await Promise.all(ownedAgents.map(async (agent) => {
    const statsBundle = await buildOwnedAgentStats(agent.id);
    const summary = summarizeOwnedAgentProfile(agent, {
      stats: statsBundle?.stats || null,
    });
    if (!summary) return null;

    if (summary.arena?.runtimeConnected) return summary;
    if (summary.lastPlayedAt) return summary;
    if (summary.lastConnectedAt) return summary;
    if (summary.deployed) return summary;
    return null;
  }));

  return summaries.filter(Boolean).sort(compareOwnedAgentSummaries);
}

async function buildOwnedArenaContext(siteSession, { requestedAgentId = '', includeStats = false } = {}) {
  if (!siteSession?.userId) {
    return {
      primaryAgentId: null,
      selectedAgentId: null,
      selectionSource: 'none',
      agents: [],
      agent: null,
      statsBundle: null,
    };
  }

  let primaryAgentId = String(siteSession.primaryAgentId || siteSession.agentId || '').trim() || null;
  if (primaryAgentId) await rescueLegacyOwnedAgentOwnership(siteSession.userId, primaryAgentId);

  const requestedId = String(requestedAgentId || '').trim();
  const ownedAgents = await listRenderableOwnedAgentsForUser(siteSession.userId);
  const ownedById = new Map(ownedAgents.map((agent) => [agent.id, agent]));

  let selectedAgent = requestedId ? ownedById.get(requestedId) || null : null;
  let selectionSource = selectedAgent ? 'query' : 'none';

  if (!selectedAgent && primaryAgentId) {
    selectedAgent = ownedById.get(primaryAgentId) || null;
    if (selectedAgent) selectionSource = 'primary';
  }

  if (!selectedAgent && ownedAgents.length > 0) {
    selectedAgent = ownedAgents[0];
    selectionSource = 'auto';
  }

  if (selectedAgent?.id && selectedAgent.id !== primaryAgentId) {
    await rememberUserPrimaryAgent(siteSession.userId, selectedAgent.id);
    primaryAgentId = selectedAgent.id;
  }

  const agent = selectedAgent || null;
  return {
    primaryAgentId,
    selectedAgentId: agent?.id || null,
    selectionSource,
    agents: ownedAgents,
    agent,
    statsBundle: includeStats && agent?.id ? await buildOwnedAgentStats(agent.id) : null,
  };
}

async function bindOwnedAgent(ownerUserId, agentId) {
  const cleanUserId = String(ownerUserId || '').trim();
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanUserId || !cleanAgentId) return;

  await assignAgentOwnerUserId(cleanAgentId, cleanUserId);
  await rememberUserPrimaryAgent(cleanUserId, cleanAgentId);
}

async function resolveMatchAgentId(rawId) {
  const normalizedId = String(rawId || '').trim();
  if (!normalizedId) return '';

  try {
    const user = await getUserById(normalizedId);
    if (user?.agent_id) return user.agent_id;
  } catch (_err) {
    // fall through to in-memory session map
  }

  for (const session of sessions.values()) {
    if (session?.expiresAt && isExpiredIso(session.expiresAt)) continue;
    if (session?.userId === normalizedId && session?.agentId) return session.agentId;
  }

  return normalizedId;
}

function decorateMatchForClient(match) {
  const {
    roomId: _roomId,
    room_id: _legacyRoomId,
    replayUrl: _replayUrl,
    ...safeMatch
  } = match || {};
  return {
    ...safeMatch,
  };
}

function decorateMatchesForClient(matches = []) {
  return Array.isArray(matches) ? matches.map((match) => decorateMatchForClient(match)) : [];
}

function getAgentRuntime(agentId) {
  return liveAgentRuntimes.get(String(agentId || '').trim()) || null;
}

function upsertAgentRuntime(agentId, patch) {
  const current = getAgentRuntime(agentId) || {
    agentId,
    connected: false,
    status: 'offline',
    socketId: null,
    connectSessionId: null,
    currentRoomId: null,
    currentPlayerId: null,
    connectedAt: 0,
    idleSince: 0,
    lastSeenAt: 0,
  };
  const next = {
    ...current,
    ...patch,
    agentId: current.agentId || agentId,
    lastSeenAt: Date.now(),
  };
  liveAgentRuntimes.set(next.agentId, next);
  return next;
}

function setAgentRuntimeStatus(agentId, status, patch = {}) {
  const normalizedStatus = String(status || 'offline').trim() || 'offline';
  const nextPatch = { ...patch, status: normalizedStatus };

  if (Object.prototype.hasOwnProperty.call(patch, 'idleSince')) {
    nextPatch.idleSince = Number(patch.idleSince || 0);
  } else if (normalizedStatus === 'idle') {
    nextPatch.idleSince = Date.now();
  } else {
    nextPatch.idleSince = 0;
  }

  return upsertAgentRuntime(agentId, nextPatch);
}

function agentSocketIsAuthoritative(agentId, socketId) {
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedSocketId = String(socketId || '').trim();
  if (!normalizedAgentId || !normalizedSocketId) return false;
  const runtime = getAgentRuntime(normalizedAgentId);
  if (!runtime?.socketId || runtime.socketId !== normalizedSocketId) return false;
  return agentRuntimeSockets.get(normalizedSocketId) === normalizedAgentId;
}

function bindAgentRuntimeSocket(agentId, socketId, patch = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedSocketId = String(socketId || '').trim();
  if (!normalizedAgentId || !normalizedSocketId) return null;

  const priorRuntime = getAgentRuntime(normalizedAgentId);
  if (priorRuntime?.socketId && priorRuntime.socketId !== normalizedSocketId) {
    agentRuntimeSockets.delete(priorRuntime.socketId);
    io.sockets.sockets.get(priorRuntime.socketId)?.disconnect(true);
  }

  const priorAgentId = agentRuntimeSockets.get(normalizedSocketId);
  if (priorAgentId && priorAgentId !== normalizedAgentId) {
    const displacedRuntime = getAgentRuntime(priorAgentId);
    if (displacedRuntime?.socketId === normalizedSocketId) {
      setAgentRuntimeStatus(priorAgentId, 'offline', {
        connected: false,
        socketId: null,
        currentRoomId: null,
        currentPlayerId: null,
      });
    }
  }

  agentRuntimeSockets.set(normalizedSocketId, normalizedAgentId);
  const nextStatus = Object.prototype.hasOwnProperty.call(patch, 'status')
    ? String(patch.status || '').trim() || 'offline'
    : (priorRuntime?.currentRoomId && priorRuntime?.currentPlayerId
      ? String(priorRuntime.status || 'in_match')
      : 'idle');
  return setAgentRuntimeStatus(normalizedAgentId, nextStatus, {
    ...patch,
    connected: true,
    socketId: normalizedSocketId,
  });
}

function releaseAgentRuntimeSocket(agentId, socketId, patch = {}) {
  if (!agentSocketIsAuthoritative(agentId, socketId)) return null;
  agentRuntimeSockets.delete(String(socketId || '').trim());
  return setAgentRuntimeStatus(agentId, 'offline', {
    ...patch,
    connected: false,
    socketId: null,
  });
}

function clearAgentRuntimeAssignment(agentId, nextStatus = 'idle', patch = {}) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) return null;
  if (!runtime.connected) nextStatus = 'offline';
  return setAgentRuntimeStatus(agentId, nextStatus, {
    ...patch,
    currentRoomId: null,
    currentPlayerId: null,
  });
}

function runtimeSocketForAgent(agentId) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime?.socketId) return null;
  return io.sockets.sockets.get(runtime.socketId) || null;
}

function runtimeConnectedAt(agentId) {
  return Number(getAgentRuntime(agentId)?.connectedAt || 0);
}

function buildPublicArenaQueueMetrics() {
  let connectedAgents = 0;
  let idleAgents = 0;
  let reservedAgents = 0;
  let inMatchAgents = 0;

  for (const agent of agentProfiles.values()) {
    if (!isPublicRankedAgent(agent) || !agent.deployed) continue;
    const runtime = getAgentRuntime(agent.id);
    if (!runtime?.connected) continue;
    connectedAgents += 1;
    if (runtime.status === 'idle') idleAgents += 1;
    else if (runtime.status === 'reserved') reservedAgents += 1;
    else if (runtime.status === 'in_match') inMatchAgents += 1;
  }

  return {
    connectedAgents,
    idleAgents,
    reservedAgents,
    inMatchAgents,
    activeMatches: activeAgentMatchRooms.size,
    queueRunning: publicArenaQueueRunning,
  };
}

function idleLaunchAgents() {
  return [...agentProfiles.values()]
    .filter((agent) => {
      if (!isPublicRankedAgent(agent) || !agent.deployed) return false;
      const runtime = getAgentRuntime(agent.id);
      return Boolean(runtime?.connected) && runtime.status === 'idle';
    })
    .sort((a, b) => {
      const aRuntime = getAgentRuntime(a.id);
      const bRuntime = getAgentRuntime(b.id);
      const aIdleSince = Number(aRuntime?.idleSince || aRuntime?.connectedAt || 0);
      const bIdleSince = Number(bRuntime?.idleSince || bRuntime?.connectedAt || 0);
      return aIdleSince - bIdleSince || Number(aRuntime?.connectedAt || 0) - Number(bRuntime?.connectedAt || 0);
    });
}

function markAgentProfileConnection(agentId, connected, note = null) {
  const agent = agentProfiles.get(agentId);
  if (!agent) return;
  agent.openclaw = {
    ...(agent.openclaw || {}),
    connected,
    connectedAt: connected ? Date.now() : agent.openclaw?.connectedAt || null,
    note: note || agent.openclaw?.note || null,
  };
}

function summarizeAgentArenaState(agentId) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) {
    return {
      runtimeConnected: false,
      queueStatus: 'offline',
      activeRoomId: null,
      activePlayerId: null,
    };
  }

  return {
    runtimeConnected: Boolean(runtime.connected),
    queueStatus: runtime.status || 'offline',
    activeRoomId: runtime.currentRoomId || null,
    activePlayerId: runtime.currentPlayerId || null,
  };
}

function modeDisabledError(mode) {
  return {
    ok: false,
    error: {
      code: 'MODE_DISABLED',
      message: `Only Agent Mafia is available at launch. ${mode || 'That'} mode is coming soon.`,
    },
  };
}

function agentRequiredError() {
  return {
    ok: false,
    error: {
      code: 'AGENT_REQUIRED',
      message: 'Connect an OpenClaw agent before entering the Mafia arena.',
    },
  };
}

function agentNotReadyError() {
  return {
    ok: false,
    error: {
      code: 'AGENT_NOT_READY',
      message: 'Your OpenClaw agent is not connected and deployed yet.',
    },
  };
}

function agentRuntimeRequiredError() {
  return {
    ok: false,
    error: {
      code: 'AGENT_RUNTIME_REQUIRED',
      message: 'Your agent is not online in the live arena yet. Finish the OpenClaw runtime connection first.',
    },
  };
}

let publicArenaQueueRunning = false;
let publicArenaQueueRetryTimer = null;
let publicArenaQueueRetryAt = 0;
const PUBLIC_ARENA_REPEAT_OVERLAP_THRESHOLD = 4;
const DEFAULT_PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS = 60_000;

function publicArenaRepeatIdleFallbackMs() {
  const configured = Number(process.env.PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS || DEFAULT_PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS);
  return Math.max(0, Number.isFinite(configured) ? configured : DEFAULT_PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS);
}

function clearPublicArenaQueueRetryTimer() {
  if (publicArenaQueueRetryTimer) clearTimeout(publicArenaQueueRetryTimer);
  publicArenaQueueRetryTimer = null;
  publicArenaQueueRetryAt = 0;
}

function schedulePublicArenaQueueRetry(waitMs) {
  const safeDelay = Math.max(25, Number(waitMs || 0));
  const nextRetryAt = Date.now() + safeDelay;
  if (publicArenaQueueRetryTimer && publicArenaQueueRetryAt && publicArenaQueueRetryAt <= nextRetryAt) return;
  clearPublicArenaQueueRetryTimer();
  publicArenaQueueRetryAt = nextRetryAt;
  publicArenaQueueRetryTimer = setTimeout(() => {
    publicArenaQueueRetryTimer = null;
    publicArenaQueueRetryAt = 0;
    void processPublicArenaQueue();
  }, safeDelay);
  if (typeof publicArenaQueueRetryTimer?.unref === 'function') {
    publicArenaQueueRetryTimer.unref();
  }
}

function attachLiveAgentToMafiaSeat(room, player, agent, runtime) {
  if (!room || !player || !agent || !runtime) return;
  player.isLiveAgent = true;
  player.isBot = false;
  player.agentId = agent.id;
  player.userId = agent.id;
  player.owner = agent.owner || null;
  player.socketId = runtime.socketId || null;
  player.isConnected = true;
  runtime.currentRoomId = room.id;
  runtime.currentPlayerId = player.id;
  runtime.status = 'in_match';
  runtime.idleSince = 0;
  const sock = io.sockets.sockets.get(runtime.socketId);
  if (sock) sock.join(`mafia:${room.id}`);
}

function clearPublicArenaSeatRuntime(agentId, nextStatus = 'reserved') {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) return null;
  return setAgentRuntimeStatus(agentId, runtime.connected ? nextStatus : 'offline', {
    currentRoomId: null,
    currentPlayerId: null,
  });
}

function rollbackPublicArenaMafiaRoom(room, agentIds = []) {
  if (room?.id) {
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    mafiaRooms.delete(room.id);
  }
  for (const agentId of agentIds) {
    clearPublicArenaSeatRuntime(agentId, 'reserved');
  }
}

function validatePublicArenaBatch(agents) {
  if (!Array.isArray(agents) || agents.length !== PUBLIC_ARENA_REQUIRED_AGENTS) {
    return { ok: false, error: 'invalid agent batch size' };
  }

  const seenNames = new Set();
  const seenSocketIds = new Set();
  for (const agent of agents) {
    if (!agent?.id) return { ok: false, error: 'missing agent id' };
    if (seenNames.has(agent.name)) return { ok: false, error: 'duplicate agent name in batch' };
    seenNames.add(agent.name);
    const runtime = getAgentRuntime(agent.id);
    if (!runtime?.connected || !runtime.socketId) {
      return { ok: false, error: `agent runtime unavailable: ${agent.id}` };
    }
    if (agentRuntimeSockets.get(runtime.socketId) !== agent.id) {
      return { ok: false, error: `stale runtime socket: ${agent.id}` };
    }
    if (!io.sockets.sockets.get(runtime.socketId)) {
      return { ok: false, error: `dead runtime socket: ${agent.id}` };
    }
    if (seenSocketIds.has(runtime.socketId)) {
      return { ok: false, error: 'duplicate runtime socket in batch' };
    }
    seenSocketIds.add(runtime.socketId);
  }

  return { ok: true };
}

function listPublicArenaMatchAgentIds(match) {
  const ids = [];
  for (const player of match?.players || []) {
    if (!player || player.isBot) continue;
    const participantId = resolveParticipantId(player);
    if (participantId) ids.push(participantId);
  }
  return ids;
}

function getLastCompletedPublicArenaMatch(mode = 'mafia') {
  return completedMatchRecords.find((match) => match?.mode === mode && match?.publicArena) || null;
}

function buildLastCompletedPublicArenaAgentSet(mode = 'mafia') {
  const match = getLastCompletedPublicArenaMatch(mode);
  return new Set(listPublicArenaMatchAgentIds(match));
}

function buildSafePublicArenaBatch(idleAgents, recentAgentIds) {
  const batch = [];
  const maxRepeatedAgents = PUBLIC_ARENA_REPEAT_OVERLAP_THRESHOLD - 1;
  let repeatedAgents = 0;

  for (const agent of idleAgents) {
    if (!agent?.id) continue;
    const isRepeat = recentAgentIds.has(agent.id);
    if (isRepeat && repeatedAgents >= maxRepeatedAgents) continue;
    batch.push(agent);
    if (isRepeat) repeatedAgents += 1;
    if (batch.length === PUBLIC_ARENA_REQUIRED_AGENTS) return batch;
  }

  return null;
}

function publicArenaRepeatAgents(batch, recentAgentIds) {
  return (batch || []).filter((agent) => recentAgentIds.has(agent?.id));
}

function batchRepeatFallbackReady(agents, now = Date.now()) {
  const fallbackMs = publicArenaRepeatIdleFallbackMs();
  return agents.every((agent) => {
    const runtime = getAgentRuntime(agent?.id);
    const idleSince = Number(runtime?.idleSince || 0);
    return idleSince > 0 && (now - idleSince) >= fallbackMs;
  });
}

function selectPublicArenaBatch(idleAgents, now = Date.now()) {
  if (!Array.isArray(idleAgents) || idleAgents.length < PUBLIC_ARENA_REQUIRED_AGENTS) {
    return { batch: null, reason: 'insufficient_agents' };
  }

  const recentAgentIds = buildLastCompletedPublicArenaAgentSet('mafia');
  if (!recentAgentIds.size) {
    return {
      batch: idleAgents.slice(0, PUBLIC_ARENA_REQUIRED_AGENTS),
      reason: 'no_recent_public_table',
    };
  }

  const safeBatch = buildSafePublicArenaBatch(idleAgents, recentAgentIds);
  if (safeBatch?.length === PUBLIC_ARENA_REQUIRED_AGENTS) {
    return {
      batch: safeBatch,
      reason: 'overlap_safe',
    };
  }

  const blockedCandidate = idleAgents.slice(0, PUBLIC_ARENA_REQUIRED_AGENTS);
  const repeatedAgents = publicArenaRepeatAgents(blockedCandidate, recentAgentIds);
  if (repeatedAgents.length < PUBLIC_ARENA_REPEAT_OVERLAP_THRESHOLD) {
    return {
      batch: blockedCandidate,
      reason: 'oldest_candidate_safe',
    };
  }

  if (batchRepeatFallbackReady(repeatedAgents, now)) {
    return {
      batch: blockedCandidate,
      reason: 'fallback_after_idle_timeout',
    };
  }

  const waits = repeatedAgents.map((agent) => {
    const runtime = getAgentRuntime(agent?.id);
    const idleSince = Number(runtime?.idleSince || 0);
    const waitedMs = idleSince > 0 ? Math.max(0, now - idleSince) : 0;
    return Math.max(0, publicArenaRepeatIdleFallbackMs() - waitedMs);
  });

  return {
    batch: null,
    reason: 'blocked_recent_overlap',
    blockedCandidate,
    repeatedAgentIds: repeatedAgents.map((agent) => agent.id),
    waitMs: waits.length ? Math.max(...waits) : publicArenaRepeatIdleFallbackMs(),
  };
}

function createPublicArenaMafiaRoom(agents, options = {}) {
  const validation = validatePublicArenaBatch(agents);
  if (!validation.ok) return null;

  const [hostAgent, ...others] = agents;
  const hostRuntime = getAgentRuntime(hostAgent.id);
  if (!hostRuntime?.connected || !hostRuntime.socketId) return null;

  const created = mafiaGame.createRoom(mafiaRooms, {
    hostName: hostAgent.name,
    hostSocketId: hostRuntime.socketId,
  });
  if (!created.ok) return null;

  const room = created.room;
  const attachedAgentIds = [];
  room.publicArena = true;
  room.autoMatch = true;
  room.liveAgentPromptKey = null;
  room.publicArenaMatchmaking = options?.matchmaking
    ? {
      agentIds: agents.map((agent) => agent.id),
      reason: String(options.matchmaking.reason || '').trim() || null,
      repeatedAgentIds: Array.isArray(options.matchmaking.repeatedAgentIds)
        ? options.matchmaking.repeatedAgentIds.slice()
        : [],
    }
    : null;
  attachLiveAgentToMafiaSeat(room, created.player, hostAgent, hostRuntime);
  attachedAgentIds.push(hostAgent.id);

  for (const agent of others) {
    const runtime = getAgentRuntime(agent.id);
    if (!runtime?.connected || !runtime.socketId) {
      rollbackPublicArenaMafiaRoom(room, attachedAgentIds);
      return null;
    }
    const joined = mafiaGame.joinRoom(mafiaRooms, {
      roomId: room.id,
      name: agent.name,
      socketId: runtime.socketId,
    });
    if (!joined.ok) {
      rollbackPublicArenaMafiaRoom(room, attachedAgentIds);
      return null;
    }
    attachLiveAgentToMafiaSeat(room, joined.player, agent, runtime);
    attachedAgentIds.push(agent.id);
  }

  const started = mafiaGame.startGame(mafiaRooms, { roomId: room.id, hostPlayerId: room.hostPlayerId });
  if (!started.ok) {
    rollbackPublicArenaMafiaRoom(room, attachedAgentIds);
    return null;
  }

  logRoomEvent('mafia', room, 'ROOM_CREATED', {
    status: room.status,
    phase: room.phase,
    publicArena: true,
    agents: agents.map((agent) => agent.id),
    matchmakingReason: room.publicArenaMatchmaking?.reason || null,
    repeatedAgentIds: Array.isArray(room.publicArenaMatchmaking?.repeatedAgentIds)
      ? room.publicArenaMatchmaking.repeatedAgentIds
      : [],
  });
  emitMafiaRoom(room);
  activeAgentMatchRooms.add(room.id);
  logRoomEvent('mafia', room, 'GAME_STARTED', {
    status: room.status,
    phase: room.phase,
    day: room.day,
    publicArena: true,
  });
  scheduleMafiaPhase(room);
  emitMafiaRoom(room);
  handlePublicArenaRoomUpdate(room);
  return room;
}

async function processPublicArenaQueue() {
  if (publicArenaQueueRunning) return;
  publicArenaQueueRunning = true;
  clearPublicArenaQueueRetryTimer();
  try {
    let idleAgents = idleLaunchAgents();
    while (idleAgents.length >= PUBLIC_ARENA_REQUIRED_AGENTS) {
      const selection = selectPublicArenaBatch(idleAgents);
      if (!selection.batch?.length) {
        if (selection.reason === 'blocked_recent_overlap') {
          logStructured('mafia.publicArena.batch_deferred', {
            reason: selection.reason,
            blockedAgentIds: selection.repeatedAgentIds || [],
            waitMs: Number(selection.waitMs || 0),
            connectedAgents: idleAgents.length,
          });
          schedulePublicArenaQueueRetry(selection.waitMs);
        }
        break;
      }

      const batch = selection.batch;
      const preservedIdleSince = new Map(
        batch.map((agent) => [agent.id, Number(getAgentRuntime(agent.id)?.idleSince || 0)]),
      );
      batch.forEach((agent) => setAgentRuntimeStatus(agent.id, 'reserved'));
      const room = createPublicArenaMafiaRoom(batch, { matchmaking: selection });
      if (!room) {
        logStructured('mafia.publicArena.batch_failed', {
          reason: selection.reason,
          agentIds: batch.map((agent) => agent.id),
          connectedAgents: idleAgents.length,
        });
        batch.forEach((agent) => clearAgentRuntimeAssignment(agent.id, 'idle', {
          idleSince: preservedIdleSince.get(agent.id) || 0,
        }));
        schedulePublicArenaQueueRetry(250);
        break;
      }
      idleAgents = idleLaunchAgents();
    }
  } finally {
    publicArenaQueueRunning = false;
  }
}

// Health check — single handler (see bottom of file)

app.post('/api/track/share', (_req, res) => {
  incrementGrowthMetric('referral.inviteSends', 1);
  res.json({ ok: true });
});

app.post('/api/auth/session', async (req, res) => {
  // Check for existing session token
  const existingToken = String(req.body?.token || readSiteSessionToken(req) || '').trim();
  if (existingToken) {
    const [siteSession, existing] = await Promise.all([
      resolveSiteSession({ headers: { authorization: `Bearer ${existingToken}` } }),
      getSessionByToken(existingToken),
    ]);
    if (siteSession?.userId) {
      const ownedContext = await buildOwnedArenaContext(siteSession);
      setSiteSessionCookie(res, existingToken, req);
      return res.json({
        ok: true,
        session: {
          token: existingToken,
          userId: siteSession.userId || existing?.user_id || null,
          agentId: ownedContext.primaryAgentId || siteSession?.primaryAgentId || siteSession?.agentId || null,
          primaryAgentId: ownedContext.primaryAgentId || siteSession?.primaryAgentId || siteSession?.agentId || null,
          isAnonymous: siteSession?.isAnonymous !== false,
          expiresAt: siteSession?.expiresAt || existing?.expires_at || null,
          durable: siteSession?.durable !== false,
        },
        ownedAgent: ownedContext.agent,
        ownedAgents: ownedContext.agents,
        selectedAgentId: ownedContext.selectedAgentId,
        renewed: true,
      });
    }
  }

  // Create anonymous user + session
  const userId = shortId(12);
  const token = shortId(24);
  const expiresAt = expiresAtFromNow();

  try {
    await createAnonymousUser(userId);
    await createSession(shortId(8), userId, token, expiresAt);

    // Also keep in-memory sessions for backward compat
    setCachedSession({ token, userId, email: null, createdAt: Date.now(), expiresAt });
    setSiteSessionCookie(res, token, req);

    res.json({
      ok: true,
      session: { token, userId, agentId: null, primaryAgentId: null, isAnonymous: true, expiresAt, durable: true },
      ownedAgent: null,
      ownedAgents: [],
      selectedAgentId: null,
    });
  } catch (err) {
    logStructured('error.auth.session.create', { error: err.message });
    if (IS_PRODUCTION) {
      return res.status(503).json({ ok: false, error: 'Session storage unavailable' });
    }
    // Non-production fallback: issue in-memory session
    const token2 = shortId(20);
    const fallbackExpiresAt = expiresAtFromNow();
    setCachedSession({ token: token2, userId, createdAt: Date.now(), expiresAt: fallbackExpiresAt });
    setSiteSessionCookie(res, token2, req);
    res.json({
      ok: true,
      session: { token: token2, userId, agentId: null, primaryAgentId: null, isAnonymous: true, expiresAt: fallbackExpiresAt, durable: false },
      ownedAgent: null,
      ownedAgents: [],
      selectedAgentId: null,
    });
  }
});

// ── Auth: register (email + display name → token) ──
app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const displayName = String(req.body?.displayName || '').trim().slice(0, 40);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (!displayName) {
    return res.status(400).json({ ok: false, error: 'Display name is required' });
  }

  try {
    const userId = shortId(12);
    const token = shortId(24);
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days

    await createAnonymousUser(userId);
    await upgradeUser(userId, { email, displayName });
    await createSession(shortId(8), userId, token, expiresAt);
    setCachedSession({ token, userId, email, displayName, createdAt: Date.now(), expiresAt });
    setSiteSessionCookie(res, token, req);

    res.json({
      ok: true,
      user: { id: userId, email, displayName },
      session: { token, userId, expiresAt, durable: true },
    });
  } catch (err) {
    if (/unique|duplicate key/i.test(String(err.message || ''))) {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// ── Auth: get current user profile ──
app.get('/api/auth/me', async (req, res) => {
  try {
    const siteSession = await resolveSiteSession(req);
    if (!siteSession?.userId) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    const user = await getUserById(siteSession.userId);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isAnonymous: !!user.is_anonymous,
        createdAt: user.created_at,
      },
    });
  } catch (_err) {
    res.status(500).json({ ok: false, error: 'Failed to fetch profile' });
  }
});

// ── Auth: upgrade anonymous → email-based ──
app.post('/api/auth/upgrade', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const displayName = String(req.body?.displayName || '').trim().slice(0, 40);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }

  try {
    const siteSession = await resolveSiteSession(req);
    if (!siteSession?.userId) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    const user = await getUserById(siteSession.userId);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

    const existingUser = await getUserByEmail(email);
    if (existingUser && existingUser.id !== user.id) {
      const issued = await issueMagicLink({
        req,
        email,
        userId: existingUser.id,
        intent: 'claim',
        sourceUserId: user.id,
      });
      if (!issued.emailSent && !insecureDevSurfacesAllowed(req)) {
        return res.status(503).json({ ok: false, error: 'Magic link delivery unavailable' });
      }
      return res.json({
        ok: true,
        claimLinkSent: true,
        emailSent: issued.emailSent,
        ...(issued.emailSent || !insecureDevSurfacesAllowed(req) ? {} : { magicUrl: issued.magicUrl }),
      });
    }

    const updated = await upgradeUser(user.id, { email, displayName: displayName || undefined });
    res.json({
      ok: true,
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.display_name,
        isAnonymous: !!updated.is_anonymous,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Upgrade failed' });
  }
});

// ── Magic link login ──
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function sendMagicLinkEmail(toEmail, magicUrl) {
  if (!RESEND_API_KEY) {
    console.log(`[magic-link] (no RESEND_API_KEY, logging to console)\n  → ${magicUrl}`);
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: MAGIC_LINK_FROM,
        to: [toEmail],
        subject: 'Your Claw of Deceit Login Link',
        html: `<p>Click the link below to finish logging in to Claw of Deceit:</p>
<p><a href="${magicUrl}" style="display:inline-block;padding:12px 24px;background:#DC2626;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Log In to Claw of Deceit</a></p>
<p style="color:#888;">This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
      }),
    });
    const data = await res.json();
    if (data.id) return { sent: true };
    logStructured('error.magicLink.send', { error: data.message || 'Unknown Resend error' });
    return { sent: false, reason: data.message || 'send_failed' };
  } catch (err) {
    logStructured('error.magicLink.send', { error: err.message });
    return { sent: false, reason: 'network_error' };
  }
}

async function ensureMagicLinkUser(email) {
  let user = await getUserByEmail(email);
  let isNewUser = false;

  if (!user) {
    try {
      const userId = shortId(12);
      await createAnonymousUser(userId);
      await upgradeUser(userId, { email });
      user = await getUserById(userId);
      isNewUser = true;
    } catch (err) {
      if (/unique|duplicate key/i.test(String(err.message || ''))) {
        user = await getUserByEmail(email);
      } else {
        throw err;
      }
    }
  }

  return { user, isNewUser };
}

async function issueMagicLink({
  req,
  email,
  userId,
  intent = 'login',
  sourceUserId = null,
}) {
  const magicToken = randomSecret(24);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
  await createMagicLinkTokenRecord({
    tokenHash: hashSecret(magicToken),
    userId,
    email,
    intent,
    sourceUserId,
    expiresAt,
  });

  const publicBaseUrl = resolvePublicBaseUrl(req);
  const magicUrl = `${publicBaseUrl}/api/auth/verify?token=${encodeURIComponent(magicToken)}`;
  const sendResult = await sendMagicLinkEmail(email, magicUrl);

  return {
    magicUrl,
    emailSent: sendResult.sent,
  };
}

async function mergeOwnedAgentsIntoUser(sourceUserId, targetUserId, targetEmail) {
  const cleanSourceUserId = String(sourceUserId || '').trim();
  const cleanTargetUserId = String(targetUserId || '').trim();
  if (!cleanSourceUserId || !cleanTargetUserId || cleanSourceUserId === cleanTargetUserId) return;

  const [sourceUser, targetUser] = await Promise.all([
    getUserById(cleanSourceUserId).catch(() => null),
    getUserById(cleanTargetUserId).catch(() => null),
  ]);

  await reassignAgentRecordsToOwner(cleanSourceUserId, cleanTargetUserId, {
    ownerEmail: targetEmail || targetUser?.email || null,
  });

  for (const agent of agentProfiles.values()) {
    if (String(agent?.ownerUserId || '').trim() !== cleanSourceUserId) continue;
    agent.ownerUserId = cleanTargetUserId;
    if (targetEmail || targetUser?.email) agent.owner = targetEmail || targetUser?.email;
  }
  persistState();

  const preferredAgentId = String(sourceUser?.agent_id || targetUser?.agent_id || '').trim() || null;
  if (preferredAgentId) {
    await rememberUserPrimaryAgent(cleanTargetUserId, preferredAgentId);
  }

  await deleteSessionsByUserId(cleanSourceUserId);
  for (const [sessionToken, session] of sessions.entries()) {
    if (String(session?.userId || '').trim() === cleanSourceUserId) {
      sessions.delete(sessionToken);
    }
  }
}

function sendRetiredApiResponse(res, message) {
  res.status(410).json({
    ok: false,
    error: message,
  });
}

app.post('/api/auth/magic-link', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }

  let resolved;
  try {
    resolved = await ensureMagicLinkUser(email);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Failed to create account' });
  }

  if (!resolved?.user) {
    return res.status(500).json({ ok: false, error: 'Failed to resolve account' });
  }

  const issued = await issueMagicLink({
    req,
    email,
    userId: resolved.user.id,
    intent: 'login',
  });

  if (!issued.emailSent && !insecureDevSurfacesAllowed(req)) {
    return res.status(503).json({ ok: false, error: 'Magic link delivery unavailable' });
  }

  res.json({
    ok: true,
    isNewUser: Boolean(resolved.isNewUser),
    emailSent: issued.emailSent,
    ...(issued.emailSent || !insecureDevSurfacesAllowed(req) ? {} : { magicUrl: issued.magicUrl }),
  });
});

app.get('/api/auth/verify', async (req, res) => {
  const magicToken = String(req.query.token || '').trim();
  if (!magicToken) return res.status(400).send('Missing token');

  const entry = await consumeMagicLinkTokenRecord(hashSecret(magicToken));
  if (!entry) return res.status(400).send('Invalid or expired login link. <a href="/connect.html">Try again</a>');

  if (entry.intent === 'claim' && entry.sourceUserId && entry.user_id && entry.sourceUserId !== entry.user_id) {
    try {
      await mergeOwnedAgentsIntoUser(entry.sourceUserId, entry.user_id, entry.email);
    } catch (err) {
      logStructured('error.magicLink.claim', { error: err.message, sourceUserId: entry.sourceUserId, userId: entry.user_id });
      return res.status(500).send('Failed to claim your agent. <a href="/connect.html">Try again</a>');
    }
  }

  // Create a session for this user
  const sessionToken = shortId(24);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days

  try {
    await createSession(shortId(8), entry.user_id, sessionToken, expiresAt);
    setCachedSession({ token: sessionToken, userId: entry.user_id, email: entry.email, createdAt: Date.now(), expiresAt });
  } catch (err) {
    logStructured('error.magicLink.verify', { error: err.message });
    return res.status(500).send('Failed to create session. <a href="/connect.html">Try again</a>');
  }

  setSiteSessionCookie(res, sessionToken, req);
  res.redirect('/connect.html');
});

// ── Match history for authenticated user ──
app.get('/api/matches/mine', async (req, res) => {
  try {
    const siteSession = await resolveSiteSession(req);
    if (!siteSession?.userId) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const ownedContext = await buildOwnedArenaContext(siteSession, {
      requestedAgentId: req.query.agentId,
    });
    const agentId = String(ownedContext.selectedAgentId || '').trim();
    let matches = [];
    let source = 'none';
    let durability = 'none';
    if (agentId) {
      matches = await getPlayerMatches(agentId, limit, offset);
      if (matches.length) {
        source = 'database';
        durability = 'database';
      } else if (offset === 0) {
        matches = getPlayerMatchesFallback(agentId, limit);
        source = 'memory';
        durability = 'ephemeral_memory';
      }
    }
    res.json({
      ok: true,
      agentId: agentId || null,
      selectedAgentId: ownedContext.selectedAgentId || null,
      primaryAgentId: ownedContext.primaryAgentId || null,
      matches: decorateMatchesForClient(matches),
      source,
      durability,
    });
  } catch (err) {
    logStructured('error.getPlayerMatches.mine', { error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to fetch matches' });
  }
});

app.use('/api/openclaw', createOpenClawRouter({
  bindOwnedAgent,
  agentProfiles,
  connectSessions,
  incrementGrowthMetric,
  issueRuntimeCredential: issueAgentRuntimeCredential,
  persistState,
  resolvePublicBaseUrl,
  resolveSiteSession,
  roomEvents,
  sanitizeArenaState: buildPublicArenaState,
  shortId,
  summarizeAgentArenaState,
}));

app.get('/api/openclaw/agents/:id', async (req, res) => {
  const authorized = await authorizeBoundAgentRequest(req);
  if (!authorized.ok) {
    return res.status(authorized.status).json({
      ok: false,
      error: authorized.error,
      code: authorized.code,
    });
  }

  const statsBundle = await buildOwnedAgentStats(authorized.agent.id);
  const summary = summarizeOwnedAgentProfile(authorized.agent, {
    stats: statsBundle?.stats || null,
  });

  res.json({
    ok: true,
    agent: {
      id: authorized.agent.id,
      name: authorized.agent.name,
      lifecycleState: authorized.agent.lifecycleState || 'active',
      archivedAt: authorized.agent.archivedAt || null,
      deployed: !!authorized.agent.deployed,
      persona: authorized.agent.persona || null,
      arenaUrl: summary?.arenaUrl || buildAgentArenaUrl(authorized.agent.id),
      watchUrl: summary?.watchUrl || null,
      arena: summary?.arena || {
        ...buildPublicArenaState(summarizeAgentArenaState(authorized.agent.id)),
        ...buildArenaAvailability(),
      },
      gamesPlayed: Number(summary?.gamesPlayed || 0),
      mmr: Number(statsBundle?.stats?.mmr ?? authorized.agent.mmr ?? DEFAULT_MMR),
      peakMmr: Number(statsBundle?.stats?.peakMmr ?? authorized.agent.peakMmr ?? DEFAULT_MMR),
      ratedMatches: Number(statsBundle?.stats?.ratedMatches ?? authorized.agent.ratedMatches ?? 0),
      lastRatingDelta: Number(statsBundle?.stats?.lastRatingDelta ?? authorized.agent.lastRatingDelta ?? 0),
      isProvisional: Boolean(statsBundle?.stats?.isProvisional ?? normalizeRatingSnapshot(authorized.agent).isProvisional),
      lastPlayedAt: summary?.lastPlayedAt || null,
      lastConnectedAt: summary?.lastConnectedAt || null,
      activityAt: summary?.activityAt || null,
    },
    management: {
      styleSyncPath: `/api/openclaw/agents/${encodeURIComponent(authorized.agent.id)}/style-sync`,
      archivePath: `/api/openclaw/agents/${encodeURIComponent(authorized.agent.id)}/archive`,
    },
  });
});

app.post('/api/openclaw/agents/:id/style-sync', async (req, res) => {
  const authorized = await authorizeBoundAgentRequest(req);
  if (!authorized.ok) {
    return res.status(authorized.status).json({
      ok: false,
      error: authorized.error,
      code: authorized.code,
    });
  }

  const profile = req.body?.profile && typeof req.body.profile === 'object' ? req.body.profile : null;
  if (!profile) {
    return res.status(400).json({ ok: false, error: 'profile required' });
  }

  const agent = authorized.agent;
  const nextPersona = buildArenaPersona({
    style: profile.tone || profile.style || agent.persona?.style || '',
    presetId: profile.preset || agent.persona?.presetId,
    intensity: profile.intensity || agent.persona?.intensity || 7,
  });

  agent.persona = {
    ...agent.persona,
    style: nextPersona.style,
    presetId: nextPersona.presetId,
    intensity: nextPersona.intensity,
  };
  agent.arenaProfile = {
    ...profile,
    syncedAt: Date.now(),
  };

  await syncAgentProfileToPersistence(agent);
  persistState();
  res.json({ ok: true, agent });
});

app.post('/api/openclaw/agents/:id/archive', async (req, res) => {
  const authorized = await authorizeBoundAgentRequest(req);
  if (!authorized.ok) {
    return res.status(authorized.status).json({
      ok: false,
      error: authorized.error,
      code: authorized.code,
    });
  }

  const archivedAgent = await archiveBoundAgent(authorized.agent.id);
  if (!archivedAgent) {
    return res.status(404).json({ ok: false, error: 'agent not found', code: 'AGENT_NOT_FOUND' });
  }

  res.json({
    ok: true,
    agent: {
      id: archivedAgent.id,
      name: archivedAgent.name,
      lifecycleState: archivedAgent.lifecycleState || 'archived',
      archivedAt: archivedAgent.archivedAt || null,
      deployed: !!archivedAgent.deployed,
    },
  });
});

app.post('/api/openclaw/style-sync', async (req, res) => {
  res.status(404).json({ ok: false, error: 'route unavailable', code: 'ROUTE_UNAVAILABLE' });
});

app.get('/api/agents/mine', async (req, res) => {
  const siteSession = await resolveSiteSession(req);
  if (!siteSession?.userId) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }

  const ownedContext = await buildOwnedArenaContext(siteSession, {
    requestedAgentId: req.query.agentId,
    includeStats: true,
  });

  let streak = 0;
  const agentIdForStreak = String(ownedContext.selectedAgentId || '').trim();
  if (agentIdForStreak) {
    try {
      const recentMatches = await getPlayerMatches(agentIdForStreak, 50);
      for (const m of recentMatches) {
        const role = String(m.role || '').toLowerCase();
        const winner = String(m.winner || '').toLowerCase();
        if (role && winner && role === winner) {
          streak++;
        } else {
          break;
        }
      }
    } catch (_err) {
      // streak stays 0
    }
  }

  let rank = null;
  if (agentIdForStreak) {
    try {
      const leaders = await getLeaderboardEntries({ mode: 'mafia', limit: 100 });
      const idx = leaders.findIndex((entry) => entry.id === agentIdForStreak);
      if (idx >= 0) rank = idx + 1;
    } catch (_err) {
      // rank stays null
    }
  }

  res.json({
    ok: true,
    session: {
      userId: siteSession.userId,
      isAnonymous: siteSession.isAnonymous !== false,
      agentId: ownedContext.primaryAgentId || siteSession.primaryAgentId || siteSession.agentId || null,
      primaryAgentId: ownedContext.primaryAgentId || siteSession.primaryAgentId || siteSession.agentId || null,
    },
    agents: ownedContext.agents,
    selectedAgentId: ownedContext.selectedAgentId || null,
    selectionSource: ownedContext.selectionSource || 'none',
    agent: ownedContext.agent,
    stats: ownedContext.statsBundle?.stats || null,
    statsSource: ownedContext.statsBundle?.source || 'none',
    statsDurability: ownedContext.statsBundle?.durability || 'none',
    statsCapped: Boolean(ownedContext.statsBundle?.capped),
    streak,
    rank,
    arena: buildArenaAvailability(),
  });
});

app.get('/api/agents/:id', (_req, res) => {
  sendRetiredApiResponse(res, 'Public agent profile APIs are not part of the current MVP.');
});

app.post('/api/agents/:id/runtime-credential/rotate', async (req, res) => {
  const siteSession = await resolveSiteSession(req);
  if (!siteSession?.userId) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }

  const agent = await ensureAgentProfileLoaded(String(req.params.id || '').trim());
  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found' });
  if (String(agent.ownerUserId || '').trim() !== String(siteSession.userId || '').trim()) {
    return res.status(403).json({ ok: false, error: 'You do not own this agent' });
  }

  await revokeAgentRuntimeCredential(agent.id);
  const runtime = getAgentRuntime(agent.id);
  if (runtime?.socketId) {
    io.sockets.sockets.get(runtime.socketId)?.disconnect(true);
  }
  setAgentRuntimeStatus(agent.id, 'offline', {
    connected: false,
    socketId: null,
    currentRoomId: null,
    currentPlayerId: null,
  });
  markAgentProfileConnection(agent.id, false, 'runtime credential rotated');
  await syncAgentProfileToPersistence(agent);

  const runtimeCredential = await issueAgentRuntimeCredential(agent.id);
  res.json({
    ok: true,
    agentId: agent.id,
    arenaUrl: buildAgentArenaUrl(agent.id),
    runtimeCredential,
  });
});

app.get('/api/stats', async (_req, res) => {
  const statsBundle = await buildGlobalStats('mafia');
  res.json({
    ok: true,
    ...statsBundle.stats,
    source: statsBundle.source,
    durable: statsBundle.durable,
    capped: statsBundle.capped,
    durability: statsBundle.durability,
  });
});

app.get('/api/leaderboard', async (req, res) => {
  const window = String(req.query.window || '12h').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const leaderboard = await getLeaderboardSummary({ mode: 'mafia', window, limit });
  res.json({ ok: true, ...leaderboard });
});

app.get('/api/matches', async (req, res) => {
  const requestedAgentId = String(req.query.agentId || '').trim();
  const requestedUserId = String(req.query.userId || '').trim();
  if (!requestedAgentId && !requestedUserId) {
    return res.status(400).json({ ok: false, error: 'agentId is required (userId is supported as a legacy alias)' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  try {
    const targetAgentId = requestedAgentId || await resolveMatchAgentId(requestedUserId);
    let matches = await getPlayerMatches(targetAgentId, limit);
    let source = 'database';
    let durability = 'database';
    if (!matches.length) {
      matches = getPlayerMatchesFallback(targetAgentId, limit);
      source = 'memory';
      durability = 'ephemeral_memory';
    }
    res.json({ ok: true, agentId: targetAgentId, matches: decorateMatchesForClient(matches), source, durability });
  } catch (err) {
    logStructured('error.getPlayerMatches', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed to fetch matches' });
  }
});

app.post('/api/report', (_req, res) => {
  sendRetiredApiResponse(res, 'Public report and moderation APIs are not part of the current MVP.');
});

app.get('/api/ops/reports', (_req, res) => {
  sendRetiredApiResponse(res, 'Public report and moderation APIs are not part of the current MVP.');
});

app.patch('/api/ops/reports/:id', (_req, res) => {
  sendRetiredApiResponse(res, 'Public report and moderation APIs are not part of the current MVP.');
});

function buildRoomLaunchReadiness(room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const hostPlayerId = room?.hostPlayerId || null;
  const host = players.find((p) => p.id === hostPlayerId) || players[0] || null;
  const connectedHumans = players.filter((p) => !p.isBot && p.isConnected).length;
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);
  const requiredPlayers = requiredPlayersForMode(room?.mode || 'mafia', room);
  const missingPlayers = Math.max(0, requiredPlayers - players.length);
  const canHostStartReady = room?.status === 'lobby' && Boolean(host?.isConnected);

  return {
    hostConnected: Boolean(host?.isConnected),
    hostName: host?.name || 'Host',
    connectedHumans,
    disconnectedHumans: disconnectedHumans.map((p) => ({ id: p.id, name: p.name })),
    disconnectedCount: disconnectedHumans.length,
    missingPlayers,
    botsNeededForReady: missingPlayers,
    canHostStartReady,
  };
}

function buildRoomMatchQuality(roomSummary) {
  const quickMatch = roomSummary.quickMatch || { tickets: 0, conversions: 0, conversionRate: 0 };
  const reconnectAuto = roomSummary.reconnectAuto || { attempts: 0, failures: 0, successRate: 0 };
  const seatCount = Number(roomSummary.seatCount || requiredPlayersForMode(roomSummary.mode || 'mafia', roomSummary));
  const fillRate = Math.min(1, (roomSummary.players || 0) / seatCount);
  const nearStartBonus = roomSummary.players >= Math.max(3, seatCount - 1) ? 0.2 : 0;
  const conversionSignal = Math.min(1, Number(quickMatch.conversionRate || 0));
  const rematchSignal = Math.min(1, Number(roomSummary.rematchCount || 0) / 3);
  const hostSignal = roomSummary.launchReadiness?.hostConnected ? 1 : 0;
  const disconnectedPenalty = Math.min(0.2, Number(roomSummary.launchReadiness?.disconnectedCount || 0) * 0.05);

  const reconnectAttempts = Math.max(0, Number(reconnectAuto.attempts || 0));
  const reconnectFailures = Math.max(0, Number(reconnectAuto.failures || 0));
  const reconnectFailureRate = reconnectAttempts ? reconnectFailures / reconnectAttempts : 0;
  const reconnectSample = Math.min(1, reconnectAttempts / 3);
  const reconnectFrictionPenalty = Number(Math.min(0.15, reconnectFailureRate * 0.15 * reconnectSample).toFixed(2));

  const score = Number(Math.max(0, ((fillRate * 0.45) + (conversionSignal * 0.2) + (rematchSignal * 0.15) + (hostSignal * 0.2) + nearStartBonus - disconnectedPenalty - reconnectFrictionPenalty)).toFixed(2));
  return {
    score,
    hot: score >= 0.9,
    fillRate: Number(fillRate.toFixed(2)),
    conversionSignal,
    rematchSignal,
    hostSignal,
    disconnectedPenalty: Number(disconnectedPenalty.toFixed(2)),
    reconnectFrictionPenalty,
  };
}

function summarizePlayableRoom(mode, room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const alivePlayers = players.filter((p) => p.alive !== false).length;
  const status = String(room?.status || 'lobby');
  const phase = String(room?.phase || (status === 'lobby' ? 'lobby' : 'unknown'));
  const seatCount = requiredPlayersForMode(mode, room);
  const canJoin = status === 'lobby' && !room?.publicArena && players.length < seatCount;
  if (status === 'finished' && room?.winner) recordRoomWinner(mode, room);
  const telemetry = getRoomTelemetry(mode, room.id);
  const quickMatch = {
    tickets: telemetry.quickMatchTickets,
    conversions: telemetry.quickMatchConversions,
    conversionRate: telemetry.quickMatchTickets
      ? Number((telemetry.quickMatchConversions / telemetry.quickMatchTickets).toFixed(2))
      : 0,
  };
  const launchReadiness = buildRoomLaunchReadiness(room);
  const reconnectAuto = {
    attempts: telemetry.reconnectAutoAttempts || 0,
    successes: telemetry.reconnectAutoSuccesses || 0,
    failures: telemetry.reconnectAutoFailures || 0,
  };
  reconnectAuto.successRate = reconnectAuto.attempts
    ? Number((reconnectAuto.successes / reconnectAuto.attempts).toFixed(2))
    : 0;
  const reconnectRecoveryClicks = {
    reclaim_clicked: telemetry.reclaimClicked || 0,
    quick_recover_clicked: telemetry.quickRecoverClicked || 0,
  };
  const fairness = {
    joinAttempts: Number(telemetry.joinAttempts || 0),
    socketSeatCapBlocked: Number(telemetry.socketSeatCapBlocked || 0),
  };
  fairness.socketSeatCapBlockRate = fairness.joinAttempts
    ? Number((fairness.socketSeatCapBlocked / fairness.joinAttempts).toFixed(2))
    : 0;

  const summary = {
    mode,
    roomId: room.id,
    partyChainId: room.partyChainId || null,
    partyStreak: Math.max(0, Number(room.partyStreak || 0)),
    status,
    phase,
    players: players.length,
    seatCount,
    alivePlayers,
    hostPlayerId: room.hostPlayerId || null,
    hostName: launchReadiness.hostName,
    createdAt: room.createdAt || Date.now(),
    canJoin,
    rematchCount: telemetry.rematchCount,
    telemetryEvents: {
      rematch_clicked: Number(telemetry.telemetryEvents?.rematch_clicked || telemetry.rematchCount || 0),
      party_streak_extended: Number(telemetry.telemetryEvents?.party_streak_extended || telemetry.partyStreakExtended || 0),
    },
    quickMatch,
    reconnectAuto,
    reconnectRecoveryClicks,
    fairness,
    recentWinners: telemetry.recentWinners,
    launchReadiness,
  };

  const quality = buildRoomMatchQuality(summary);
  return {
    ...summary,
    matchQuality: quality,
    hotLobby: quality.hot,
  };
}

function sanitizeLaunchReadinessForPublic(launchReadiness = {}) {
  return {
    hostConnected: Boolean(launchReadiness.hostConnected),
    hostName: launchReadiness.hostName || 'Host',
    connectedHumans: Number(launchReadiness.connectedHumans || 0),
    disconnectedCount: Number(launchReadiness.disconnectedCount || 0),
    missingPlayers: Number(launchReadiness.missingPlayers || 0),
    botsNeededForReady: Number(launchReadiness.botsNeededForReady || 0),
    canHostStartReady: Boolean(launchReadiness.canHostStartReady),
  };
}

function sanitizePlayableRoomForPublic(roomSummary = {}) {
  return {
    ...roomSummary,
    hostPlayerId: null,
    launchReadiness: sanitizeLaunchReadinessForPublic(roomSummary.launchReadiness),
  };
}

function listPlayableRooms(modeFilter = 'all', statusFilter = 'all') {
  const includeStatuses = statusFilter === 'open' ? new Set(['lobby']) : null;
  if (!['all', 'mafia'].includes(modeFilter)) return [];
  let roomsList = [...mafiaRooms.values()].map((room) => summarizePlayableRoom('mafia', room));

  if (includeStatuses) {
    roomsList = roomsList.filter((room) => includeStatuses.has(room.status));
  }

  roomsList.sort((a, b) => {
    if (a.canJoin !== b.canJoin) return a.canJoin ? -1 : 1;
    if (a.status !== b.status) return a.status === 'lobby' ? -1 : 1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  return roomsList;
}

function getLobbyStore(mode) {
  return mode === 'mafia' ? mafiaRooms : null;
}

function getClaimableLobbySeats(mode, roomId) {
  const store = getLobbyStore(mode);
  if (!store) {
    return { ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } };
  }

  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };

  const host = room.players.find((p) => p.id === room.hostPlayerId) || null;
  const claimable = room.players
    .filter((p) => !p.isBot && !p.isConnected)
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      hostSeat: Boolean(host && host.id === p.id),
    }));

  return {
    ok: true,
    mode,
    roomId: room.id,
    status: room.status,
    claimable,
    hasHostClaim: claimable.some((p) => p.hostSeat),
  };
}

function pickQuickJoinMode(mode) {
  return mode === 'mafia' ? 'mafia' : PUBLIC_LAUNCH_MODE;
}

function buildQuickJoinDecision(candidates, targetRoom, created) {
  if (created) {
    return {
      code: 'CREATED_NEW_ROOM',
      message: 'No open lobby was ready, so we created a fresh room and auto-filled bots to start fast.',
      signals: {
        openCandidates: 0,
      },
    };
  }

  const others = (candidates || []).filter((room) => room.roomId !== targetRoom.roomId);
  const avoidedReconnectFriction = others.some((room) => Number(room.matchQuality?.reconnectFrictionPenalty || 0) > Number(targetRoom.matchQuality?.reconnectFrictionPenalty || 0));
  const avoidedOfflineHost = others.some((room) => !room.launchReadiness?.hostConnected) && Boolean(targetRoom.launchReadiness?.hostConnected);

  if (avoidedReconnectFriction) {
    return {
      code: 'LOWER_RECONNECT_FRICTION',
      message: 'Quick match routed you to a lobby with better reconnect reliability.',
      signals: {
        reconnectFrictionPenalty: Number(targetRoom.matchQuality?.reconnectFrictionPenalty || 0),
        openCandidates: candidates.length,
      },
    };
  }

  if (avoidedOfflineHost) {
    return {
      code: 'HOST_ONLINE_PRIORITY',
      message: 'Quick match prioritized a lobby where the host is currently online.',
      signals: {
        hostConnected: true,
        openCandidates: candidates.length,
      },
    };
  }

  return {
    code: 'BEST_MATCH_QUALITY',
    message: 'Quick match picked the highest-quality open lobby based on readiness and momentum.',
    signals: {
      score: Number(targetRoom.matchQuality?.score || 0),
      openCandidates: candidates.length,
    },
  };
}

const QUICK_JOIN_MIN_PLAYERS = 4;
const PUBLIC_ARENA_REQUIRED_AGENTS = 6;
const PUBLIC_LAUNCH_MODE = 'mafia';
const LIVE_AGENT_FALLBACK_DISCUSSION_MESSAGE = 'I\'m locking a public read before the vote.';
const MAFIA_PHASE_MS = {
  night: Number(process.env.MAFIA_NIGHT_MS || 10000),
  discussion: Number(process.env.MAFIA_DISCUSSION_MS || 30000),
  voting: Number(process.env.MAFIA_VOTING_MS || 10000),
};
const MAFIA_DISCUSSION_TURN_MS = Number(process.env.MAFIA_DISCUSSION_TURN_MS || 3000);

function requiredPlayersForMode(mode, room = null) {
  if (mode === 'mafia') {
    return room?.publicArena ? PUBLIC_ARENA_REQUIRED_AGENTS : mafiaGame.MAFIA_PLAYER_COUNT;
  }
  return QUICK_JOIN_MIN_PLAYERS;
}

function createQuickJoinRoom(mode, hostName) {
  const socketId = null;
  return mafiaGame.createRoom(mafiaRooms, { hostName, hostSocketId: socketId });
}

function autoFillLobbyBots(mode, roomId, minPlayers = QUICK_JOIN_MIN_PLAYERS) {
  const safeMinPlayers = Math.max(1, Math.min(8, Number(minPlayers) || QUICK_JOIN_MIN_PLAYERS));
  const room = mafiaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only auto-fill lobby rooms' } };
  const targetPlayers = Math.max(safeMinPlayers, requiredPlayersForMode('mafia', room));
  const needed = Math.max(0, targetPlayers - room.players.length);
  const added = mafiaGame.addLobbyBots(mafiaRooms, { roomId: room.id, count: needed, namePrefix: 'Mafia Bot' });
  if (!added.ok) return added;
  logRoomEvent('mafia', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length, targetPlayers, players: room.players.length });
  emitMafiaRoom(room);
  return { ok: true, mode: 'mafia', room, addedBots: added.bots.length, targetPlayers };
}

function stripDisconnectedLobbyHumans(mode, roomId) {
  const store = getLobbyStore(mode);
  if (!store) return { ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } };
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only update lobby rooms' } };

  const before = room.players.length;
  room.players = room.players.filter((player) => player.isConnected || player.isBot || player.id === room.hostPlayerId);
  const removedHumans = Math.max(0, before - room.players.length);
  return { ok: true, room, removedHumans };
}

function getLobbyStartReadiness(mode, room, playerId) {
  const reasons = [];
  const players = room?.players || [];
  const isHost = Boolean(room?.hostPlayerId && room.hostPlayerId === playerId);
  const requiredPlayers = requiredPlayersForMode(mode, room);
  const missingPlayers = Math.max(0, requiredPlayers - players.length);
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);

  if (!isHost) reasons.push({ code: 'HOST_ONLY', message: 'Only host can start' });
  if (room?.status !== 'lobby') reasons.push({ code: 'INVALID_STATE', message: 'Game already started' });
  if (missingPlayers > 0) reasons.push({ code: 'MISSING_PLAYERS', message: `Need ${missingPlayers} more player(s)` });
  if (disconnectedHumans.length > 0) reasons.push({ code: 'DISCONNECTED_PLAYERS', message: `${disconnectedHumans.length} disconnected player(s) will be replaced by bots` });

  return {
    canStart: reasons.filter((r) => !['MISSING_PLAYERS', 'DISCONNECTED_PLAYERS'].includes(r.code)).length === 0,
    missingPlayers,
    disconnectedPlayers: disconnectedHumans.map((p) => ({ id: p.id, name: p.name })),
    reasons,
  };
}

function startReadyLobby(mode, roomId, playerId) {
  const store = mafiaRooms;
  const game = mafiaGame;
  const emitRoom = emitMafiaRoom;
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };

  const readiness = getLobbyStartReadiness(mode, room, playerId);
  if (!readiness.canStart) {
    roomEvents.append(mode, room.id, 'LOBBY_START_BLOCKED', {
      status: room.status,
      reasonCode: readiness.reasons[0]?.code || 'LOBBY_NOT_READY',
      missingPlayers: readiness.missingPlayers,
      disconnectedPlayers: readiness.disconnectedPlayers?.length || 0,
    });
    return {
      ok: false,
      error: {
        code: readiness.reasons[0]?.code || 'LOBBY_NOT_READY',
        message: readiness.reasons[0]?.message || 'Lobby not ready',
        details: { readiness },
      },
    };
  }

  const stripped = stripDisconnectedLobbyHumans(mode, room.id);
  if (!stripped.ok) return stripped;

  const autoFilled = autoFillLobbyBots(mode, room.id, QUICK_JOIN_MIN_PLAYERS);
  if (!autoFilled.ok) return autoFilled;

  const started = game.startGame(store, { roomId: room.id, hostPlayerId: playerId });
  if (!started.ok) return started;

  logRoomEvent(mode, started.room, 'LOBBY_START_READY', {
    removedDisconnectedHumans: stripped.removedHumans,
    addedBots: autoFilled.addedBots,
    players: started.room.players.length,
    phase: started.room.phase,
  });
  logRoomEvent(mode, started.room, 'GAME_STARTED', {
    status: started.room.status,
    phase: started.room.phase,
    day: started.room.day,
    round: started.room.round,
  });
  scheduleMafiaPhase(started.room);
  emitRoom(started.room);

  return {
    ok: true,
    addedBots: autoFilled.addedBots,
    removedDisconnectedHumans: stripped.removedHumans,
    readiness: getLobbyStartReadiness(mode, started.room, playerId),
    state: game.toPublic(started.room),
  };
}

function buildRoomsApiResponse(modeInput = PUBLIC_LAUNCH_MODE, statusFilter = 'all') {
  const normalizedModeInput = String(modeInput || PUBLIC_LAUNCH_MODE).toLowerCase();
  const modeFilter = normalizedModeInput === 'all' ? PUBLIC_LAUNCH_MODE : normalizedModeInput;
  const normalizedStatusFilter = String(statusFilter || 'all').toLowerCase();

  if (!['all', 'mafia'].includes(normalizedModeInput)) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'Invalid mode filter' },
    };
  }
  if (!isEnabledPublicMode(modeFilter)) {
    return {
      statusCode: 400,
      body: modeDisabledError(modeFilter),
    };
  }

  const roomsList = listPlayableRooms(modeFilter, normalizedStatusFilter);
  const aggregate = roomsList.reduce((totals, room) => {
    totals.playersOnline += Number(room.players || 0);
    if (room.canJoin) totals.openRooms += 1;
    if (room.mode === 'mafia') totals.byMode.mafia += 1;

    totals.reconnectAuto.attempts += Number(room.reconnectAuto?.attempts || 0);
    totals.reconnectAuto.successes += Number(room.reconnectAuto?.successes || 0);
    totals.reconnectAuto.failures += Number(room.reconnectAuto?.failures || 0);

    totals.reconnectRecoveryClicks.reclaim_clicked += Number(room.reconnectRecoveryClicks?.reclaim_clicked || 0);
    totals.reconnectRecoveryClicks.quick_recover_clicked += Number(room.reconnectRecoveryClicks?.quick_recover_clicked || 0);

    totals.telemetryEvents.rematch_clicked += Number(room.telemetryEvents?.rematch_clicked || 0);
    totals.telemetryEvents.party_streak_extended += Number(room.telemetryEvents?.party_streak_extended || 0);
    totals.fairness.joinAttempts += Number(room.fairness?.joinAttempts || 0);
    totals.fairness.socketSeatCapBlocked += Number(room.fairness?.socketSeatCapBlocked || 0);

    return totals;
  }, {
    playersOnline: 0,
    openRooms: 0,
    byMode: { mafia: 0 },
    reconnectAuto: { attempts: 0, successes: 0, failures: 0 },
    reconnectRecoveryClicks: { reclaim_clicked: 0, quick_recover_clicked: 0 },
    telemetryEvents: { rematch_clicked: 0, party_streak_extended: 0 },
    fairness: { joinAttempts: 0, socketSeatCapBlocked: 0 },
  });

  const summary = {
    totalRooms: roomsList.length,
    openRooms: aggregate.openRooms,
    playersOnline: aggregate.playersOnline,
    arena: buildArenaAvailability(),
    byMode: aggregate.byMode,
    reconnectAuto: {
      ...aggregate.reconnectAuto,
      successRate: aggregate.reconnectAuto.attempts
        ? Number((aggregate.reconnectAuto.successes / aggregate.reconnectAuto.attempts).toFixed(2))
        : 0,
    },
    reconnectRecoveryClicks: aggregate.reconnectRecoveryClicks,
    telemetryEvents: aggregate.telemetryEvents,
    fairness: {
      ...aggregate.fairness,
      socketSeatCapBlockRate: aggregate.fairness.joinAttempts
        ? Number((aggregate.fairness.socketSeatCapBlocked / aggregate.fairness.joinAttempts).toFixed(2))
        : 0,
    },
  };

  return {
    statusCode: 200,
    body: { ok: true, rooms: roomsList.slice(0, 50), summary },
  };
}

app.get('/api/ops/rooms', (req, res) => {
  const response = buildRoomsApiResponse(req.query.mode || PUBLIC_LAUNCH_MODE, req.query.status || 'all');
  res.status(response.statusCode).json(response.body);
});

app.get('/api/play/rooms', (_req, res) => {
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

app.get('/api/play/lobby/claims', (req, res) => {
  void req;
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

app.post('/api/play/reconnect-telemetry', (req, res) => {
  void req;
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

app.post('/api/play/quick-join', (req, res) => {
  void req;
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

app.post('/api/play/lobby/autofill', (req, res) => {
  void req;
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

loadState();
growthMetrics = buildEmptyGrowthMetrics();
void loadGrowthMetrics();

// ── Instant Play: one-click to join a game ──
app.post('/api/play/instant', (req, res) => {
  void req;
  sendRetiredApiResponse(res, 'Public room discovery and play-control APIs are not part of the current MVP.');
});

app.get('/api/play/watch', (_req, res) => {
  res.status(410).json({
    ok: false,
    error: 'Public watch pages and replay timelines are not part of the current MVP.',
  });
});

// ── Match page for sharing ──
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/match/:matchId', async (req, res) => {
  try {
    const match = await getMatch(req.params.matchId);
    if (!match) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));

    const playerListRaw = (match.players || [])
      .map((p) => `${p.player_name}${p.survived ? ' (survived)' : ''}`)
      .join(', ');

    const safeMode = escapeHtml(match.mode || 'unknown');
    const safeModeUpper = safeMode.toUpperCase();
    const safeWinner = escapeHtml(match.winner || 'Unknown');
    const safeRounds = escapeHtml(String(match.rounds || 0));
    const safePlayerList = escapeHtml(playerListRaw);

    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta property="og:title" content="Claw of Deceit - ${safeMode} Match" />
  <meta property="og:description" content="Winner: ${safeWinner} | ${safeRounds} rounds | Players: ${safePlayerList}" />
  <meta property="og:image" content="/og-image.svg" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/styles.css" />
  <title>Match Result - Claw of Deceit</title>
</head>
<body class="page-home">
<div class="wrap">
  <nav class="topnav">
    <a class="brand" href="/">Claw of Deceit</a>
    <div class="nav-links">
      <a href="/connect.html">Connect</a>
      <a href="/leaderboard.html">Leaderboard</a>
      <a href="/how-it-works.html">How It Works</a>
    </div>
  </nav>
  <section class="hero-simple mb-16" style="min-height:auto; padding: 3rem 0;">
    <div class="hero-content">
      <h1>${safeModeUpper} Match</h1>
      <div class="card mt-12" style="padding: 2rem; max-width: 500px; margin: 0 auto;">
        <p style="font-size: 1.2rem; color: var(--accent);">Winner: ${safeWinner}</p>
        <p style="color: var(--text-dim);">${safeRounds} rounds | ${safeMode}</p>
        <hr style="border-color: var(--border-subtle); margin: 1rem 0;" />
        <p style="color: var(--text-dim);">Players: ${safePlayerList}</p>
        <div class="row mt-12" style="justify-content: center; gap: 1rem;">
          <a class="btn btn-primary" href="/leaderboard.html">Open Leaderboard</a>
          <button class="btn btn-ghost" onclick="navigator.clipboard.writeText(window.location.href).then(()=>this.textContent='Copied!')">Copy Link</button>
        </div>
      </div>
    </div>
  </section>
</div>
</body>
</html>`);
  } catch (_err) {
    res.redirect('/');
  }
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(buildRuntimeConfigScript(req));
});

app.get([
  '/arena.html',
  '/account.html',
  '/dashboard.html',
  '/play.html',
  '/browse.html',
  '/guide.html',
  '/terminal-agent.html',
  '/for-agents.html',
  '/guess-the-agent.html',
], (_req, res) => {
  res.redirect(302, '/leaderboard.html');
});

app.use('/ops.html', opsLoopbackPageGate);
app.use(sendRuntimeHtml);
app.use(express.static(PUBLIC_DIR));

registerRoomEventRoutes(app, { roomEvents });

app.get('/api/ops/events', (_req, res) => {
  res.json({ ok: true, pending: roomEvents.pending(), pendingByMode: roomEvents.pendingByMode() });
});

app.post('/api/ops/events/flush', async (_req, res) => {
  await roomEvents.flush();
  res.json({ ok: true, pending: roomEvents.pending(), pendingByMode: roomEvents.pendingByMode() });
});

app.get('/api/ops/reconnect', (_req, res) => {
  const totals = {
    attempts: 0,
    successes: 0,
    failures: 0,
    reclaim_clicked: 0,
    quick_recover_clicked: 0,
    rematch_clicked: 0,
    party_streak_extended: 0,
    join_attempts: 0,
    socket_seat_cap_blocked: 0,
  };
  const byMode = {
    mafia: {
      attempts: 0,
      successes: 0,
      failures: 0,
      reclaim_clicked: 0,
      quick_recover_clicked: 0,
      rematch_clicked: 0,
      party_streak_extended: 0,
      join_attempts: 0,
      socket_seat_cap_blocked: 0,
    },
  };

  for (const telemetry of playRoomTelemetry.values()) {
    const mode = 'mafia';
    const attempts = Number(telemetry.reconnectAutoAttempts || 0);
    const successes = Number(telemetry.reconnectAutoSuccesses || 0);
    const failures = Number(telemetry.reconnectAutoFailures || 0);
    const reclaimClicked = Number(telemetry.reclaimClicked || 0);
    const quickRecoverClicked = Number(telemetry.quickRecoverClicked || 0);
    const rematchClicked = Number(telemetry.telemetryEvents?.rematch_clicked || telemetry.rematchCount || 0);
    const partyStreakExtended = Number(telemetry.telemetryEvents?.party_streak_extended || telemetry.partyStreakExtended || 0);
    const joinAttempts = Number(telemetry.joinAttempts || 0);
    const socketSeatCapBlocked = Number(telemetry.socketSeatCapBlocked || 0);
    totals.attempts += attempts;
    totals.successes += successes;
    totals.failures += failures;
    totals.reclaim_clicked += reclaimClicked;
    totals.quick_recover_clicked += quickRecoverClicked;
    totals.rematch_clicked += rematchClicked;
    totals.party_streak_extended += partyStreakExtended;
    totals.join_attempts += joinAttempts;
    totals.socket_seat_cap_blocked += socketSeatCapBlocked;
    byMode[mode].attempts += attempts;
    byMode[mode].successes += successes;
    byMode[mode].failures += failures;
    byMode[mode].reclaim_clicked += reclaimClicked;
    byMode[mode].quick_recover_clicked += quickRecoverClicked;
    byMode[mode].rematch_clicked += rematchClicked;
    byMode[mode].party_streak_extended += partyStreakExtended;
    byMode[mode].join_attempts += joinAttempts;
    byMode[mode].socket_seat_cap_blocked += socketSeatCapBlocked;
  }

  const toRate = (row) => (row.attempts ? Number((row.successes / row.attempts).toFixed(2)) : 0);
  const toBlockRate = (row) => (row.join_attempts ? Number((row.socket_seat_cap_blocked / row.join_attempts).toFixed(2)) : 0);
  res.json({
    ok: true,
    totals: { ...totals, successRate: toRate(totals), socketSeatCapBlockRate: toBlockRate(totals) },
    byMode: {
      mafia: { ...byMode.mafia, successRate: toRate(byMode.mafia), socketSeatCapBlockRate: toBlockRate(byMode.mafia) },
    },
  });
});

app.get('/api/ops/kpis', async (_req, res) => {
  const report = await snapshotKpis();
  res.json({ ok: true, ...report });
});

app.post('/api/ops/kpis/refresh', async (_req, res) => {
  const payload = await persistGrowthMetricsSnapshot();
  res.json({ ok: true, metrics: payload });
});

app.post('/api/ops/kpis/snapshot', async (_req, res) => {
  const metrics = await persistGrowthMetricsSnapshot();
  growthMetrics = metrics;
  res.json({ ok: true, metrics });
});

app.get('/api/ops/funnel', async (_req, res) => {
  const metrics = growthMetricsLoaded ? growthMetrics : await loadGrowthMetrics();
  res.json({ ok: true, metrics });
});

app.get('/api/ops/match-baseline', async (req, res) => {
  const mode = String(req.query.mode || 'mafia').toLowerCase();
  if (mode !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }
  res.json({ ok: true, baseline: await buildMatchBaseline(mode) });
});

app.get('/api/ops/ratings/health', async (req, res) => {
  const mode = String(req.query.mode || 'mafia').toLowerCase();
  if (mode !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }

  let health = null;
  try {
    health = await getRatingHealth({ mode });
  } catch (err) {
    logStructured('error.getRatingHealth', { error: err.message, mode });
  }

  res.json({
    ok: true,
    health: health || buildRatingHealthFallback(mode),
    source: health ? 'database' : 'memory',
  });
});

async function buildHealthPayload() {
  const scheduler = roomScheduler.stats();
  const eventQueueDepth = roomEvents.pending();
  const eventQueueByMode = roomEvents.pendingByMode();
  const publicArena = buildPublicArenaQueueMetrics();

  const dbHealth = await getDatabaseHealth();
  const dbStatus = dbHealth.status || 'unavailable';
  const durableStorageRequired = IS_PRODUCTION;
  const durableStorageHealthy = dbStatus === 'ok';
  const healthy = durableStorageHealthy || !durableStorageRequired;
  const cleanup = maintenanceState.cleanup;

  const timestamp = new Date().toISOString();
  return {
    healthy,
    summary: {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      timestamp,
      launchMode: PUBLIC_LAUNCH_MODE,
      database: dbStatus,
      durableStorageRequired,
      durableStorageHealthy,
      uptimeSec: Math.floor(process.uptime()),
    },
    detailed: {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      timestamp,
      launchMode: PUBLIC_LAUNCH_MODE,
      publicBaseUrl: PUBLIC_APP_URL || null,
      database: dbStatus,
      databaseDriver: dbHealth.driver || 'none',
      databaseSizeBytes: dbHealth.sizeBytes ?? null,
      databaseMaxConnections: dbHealth.maxConnections ?? null,
      databasePoolConnections: dbHealth.poolConnections || null,
      durableStorageRequired,
      durableStorageHealthy,
      uptimeSec: Math.floor(process.uptime()),
      rooms: {
        mafia: mafiaRooms.size,
      },
      agents: agentProfiles.size,
      publicArena,
      schedulerTimers: scheduler,
      eventQueueDepth,
      eventQueueByMode,
      roomEvents: {
        publicReplayEnabled: PUBLIC_ROOM_EVENT_ROUTES_ENABLED,
        filePersistenceEnabled: roomEvents.persistenceEnabled(),
        fileSizeBytes: readFileSizeBytes(ROOM_EVENTS_FILE),
        growthMetricsSnapshotName: GROWTH_METRICS_SNAPSHOT_NAME,
        growthMetricsSnapshotStorage: dbStatus === 'ok' ? 'database' : 'memory',
      },
      maintenance: {
        cleanup,
      },
    },
  };
}

app.get('/api/ops/health', (_req, res) => {
  res.json(buildOpsHealthPayload());
});

app.get('/health', async (_req, res) => {
  const dbHealth = await getDatabaseHealth();
  const durableStorageRequired = IS_PRODUCTION;
  const healthy = dbHealth.status === 'ok' || !durableStorageRequired;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
  });
});

// ── Sentry error handler (must be after all routes) ──
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, _req, res, _next) => {
  logStructured('error.unhandled', { error: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'internal server error' });
});

// ── Stale room cleanup ──
const STALE_FINISHED_ROOM_MS = 30 * 60 * 1000; // 30 min after finish
const STALE_EMPTY_LOBBY_MS = 15 * 60 * 1000; // 15 min empty lobby
const STALE_INACTIVE_ROOM_MS = 2 * 60 * 60 * 1000; // 2 hours inactive

function cleanupStaleRooms() {
  const now = Date.now();
  let cleaned = 0;

  function sweep(store, label) {
    for (const [id, room] of store) {
      const age = now - (room.createdAt || now);
      const isFinished = room.status === 'finished';
      const isEmpty = !room.players || room.players.length === 0;
      const isEmptyLobby = room.status === 'lobby' && isEmpty;

      let shouldDelete = false;
      if (isFinished && age > STALE_FINISHED_ROOM_MS) shouldDelete = true;
      else if (isEmptyLobby && age > STALE_EMPTY_LOBBY_MS) shouldDelete = true;
      else if (age > STALE_INACTIVE_ROOM_MS) shouldDelete = true;

      if (shouldDelete) {
        roomScheduler.clearRoom(id, label);
        store.delete(id);
        cleaned++;
      }
    }
  }

  sweep(mafiaRooms, 'mafia');

  if (cleaned > 0) {
    logStructured('rooms.cleanup', { cleaned, remaining: mafiaRooms.size });
  }
}

function resetAgentArenaRuntime() {
  clearPublicArenaQueueRetryTimer();
  liveAgentRuntimes.clear();
  agentRuntimeSockets.clear();
  activeAgentMatchRooms.clear();
  completedMatchRooms.clear();
  completedMatchRecords.length = 0;
  publicArenaQueueRunning = false;
}

if (require.main === module) {
  void (async () => {
    loadState();
    try {
      const database = await initDb();
      if (database) {
        await hydratePersistedAgents();
        const health = await getDatabaseHealth();
        console.log(`${String(health.driver || 'database')} initialized`);
      } else {
        console.warn('[startup] Database unavailable; running without durable persistence (in-memory fallback)');
      }
    } catch (err) {
      console.error('Database init failed:', err.message);
      if (IS_PRODUCTION) {
        process.exit(1);
      }
    }

    if (!ROOM_EVENT_FILE_PERSISTENCE_ENABLED) {
      console.warn('[startup] Room event file persistence disabled; replay remains in-memory only.');
    }
    if (!PUBLIC_ROOM_EVENT_ROUTES_ENABLED) {
      console.warn('[startup] Public room replay routes disabled.');
    }

    try {
      await cleanupExpiredPersistence();
    } catch (_err) {
      // Cleanup errors are surfaced in health + structured logs.
    }

    // Stale room cleanup — every 5 minutes
    setInterval(cleanupStaleRooms, 5 * 60 * 1000);
    setInterval(() => {
      void cleanupExpiredPersistence();
    }, MAINTENANCE_CLEANUP_INTERVAL_MS);

    server.listen(PORT, HOST, () => {
      const hostLabel = HOST || 'localhost';
      console.log(`Claw of Deceit running on http://${hostLabel}:${PORT}`);
    });

    server.on('close', () => {
      if (_persistDirty) _flushState();
      void closeDb();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      server.close();
      setTimeout(() => process.exit(0), 10000);
    });
  })();
}

module.exports = {
  app,
  server,
  io,
  mafiaRooms,
  agentProfiles,
  connectSessions,
  liveAgentRuntimes,
  completedMatchRecords,
  agentRuntimeSockets,
  roomEvents,
  PUBLIC_APP_URL,
  PUBLIC_ROOM_EVENT_ROUTES_ENABLED,
  ROOM_EVENT_FILE_PERSISTENCE_ENABLED,
  resolvePublicBaseUrl,
  injectPublicBaseUrl,
  buildRuntimeConfigScript,
  processPublicArenaQueue,
  idleLaunchAgents,
  selectPublicArenaBatch,
  createPublicArenaMafiaRoom,
  recordFirstMatchCompletion,
  releasePublicArenaRoom,
  buildMatchBaseline,
  cleanupExpiredPersistence,
  clearAllGameTimers,
  resetPlayTelemetry,
  seedPlayTelemetry,
  resetAgentArenaRuntime,
  maintenanceState,
  isLoopbackRemoteAddress,
  opsSurfaceEnabled,
  manualMafiaSocketFeatureEnabled,
  envFlagEnabled,
};
