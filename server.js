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
  getUserByToken,
  getUserById,
  getSessionByToken,
  setUserAgentId,
  createAnonymousUser,
  createSession,
  upgradeUser,
  createReport,
  getReports,
  updateReportStatus,
  getMatch,
  getDatabaseHealth,
  closeDb,
} = require('./server/db');
const { buildResolvedPersona } = require('./extensions/clawofdeceit-connect/style-presets.cjs');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { track: trackEvent } = require('./server/services/analytics');

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
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

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_APP_URL = normalizeBaseUrl(process.env.PUBLIC_APP_URL || '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

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

function injectPublicBaseUrl(html, publicBaseUrl) {
  return String(html || '');
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
const roomEvents = createRoomEventLog({ dataDir: path.join(__dirname, 'data') });
const playRoomTelemetry = new Map();
const pendingQuickJoinTickets = new Map();
const reconnectClaimTickets = new Map();
const liveAgentRuntimes = new Map();
const agentRuntimeSockets = new Map();
const activeAgentMatchRooms = new Set();
const completedMatchRecords = [];

function clearAllGameTimers() {
  roomScheduler.clearAll();
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
  roomEvents.append(mode, room.id, type, payload);

  // Track to Amplitude
  const amplitudeEvent = AMPLITUDE_EVENT_MAP[type];
  if (amplitudeEvent) {
    const userId = payload.userId || payload.socketId || room.id;
    trackEvent(amplitudeEvent, userId, { mode, roomId: room.id, ...payload });
  }
}

function emitMafiaRoom(room) {
  io.to(`mafia:${room.id}`).emit('mafia:state', mafiaGame.toPublic(room));
}

function pickDeterministicTarget(players, actorId) {
  return players
    .filter((p) => p.alive && p.id !== actorId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
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
    const readyBots = room.players.filter((p) => p.alive && p.isBot);
    for (const bot of readyBots) {
      const result = mafiaGame.submitAction(mafiaRooms, { roomId: room.id, playerId: bot.id, type: 'ready' });
      if (result.ok) acted += 1;
      if (room.phase !== 'discussion') break;
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

function emitMafiaLiveAgentRequests(room) {
  if (!room?.publicArena || room.status !== 'in_progress') return;
  const promptKey = `${room.day}:${room.phase}`;
  if (room.liveAgentPromptKey === promptKey) return;
  room.liveAgentPromptKey = promptKey;

  let eventName = null;
  let targets = [];
  if (room.phase === 'night') {
    eventName = 'mafia:agent:night_request';
    targets = room.players.filter((p) => p.alive && p.isLiveAgent && p.role === 'mafia' && !room.actions?.night?.[p.id]);
  } else if (room.phase === 'discussion') {
    eventName = 'mafia:agent:discussion_request';
    targets = room.players.filter((p) => p.alive && p.isLiveAgent && room.actions?.vote?.[p.id] !== '__READY__');
  } else if (room.phase === 'voting') {
    eventName = 'mafia:agent:vote_request';
    targets = room.players.filter((p) => p.alive && p.isLiveAgent && !room.actions?.vote?.[p.id]);
  }
  if (!eventName) return;

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
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    handlePublicArenaRoomUpdate(room);
    return;
  }

  const auto = runMafiaBotAutoplay(room);
  if (auto.acted > 0) emitMafiaRoom(room);
  handlePublicArenaRoomUpdate(room);
  if (room.status !== 'in_progress') {
    room.phaseEndsAt = null;
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    handlePublicArenaRoomUpdate(room);
    return;
  }

  const token = `${room.phase}:${Date.now()}`;
  const ms = room.phase === 'night' ? MAFIA_PHASE_MS.night : room.phase === 'discussion' ? MAFIA_PHASE_MS.discussion : room.phase === 'voting' ? MAFIA_PHASE_MS.voting : 0;
  if (!ms) {
    room.phaseEndsAt = null;
    return;
  }
  room.phaseEndsAt = Date.now() + ms;

  roomScheduler.schedule({ namespace: 'mafia', roomId: room.id, slot: 'phase', delayMs: ms, token }, () => {
    const advanced = mafiaGame.forceAdvance(mafiaRooms, { roomId: room.id });
    if (advanced.ok) {
      if (room.status === 'finished') recordFirstMatchCompletion('mafia', room.id);
      emitMafiaRoom(room);
      handlePublicArenaRoomUpdate(room);
      scheduleMafiaPhase(room);
    }
  });
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
    const token = String(payload?.token || '').trim();
    const proof = String(payload?.proof || '').trim();
    const connect = connectSessions.get(token);
    if (!connect) return cb?.({ ok: false, error: { code: 'CONNECT_SESSION_NOT_FOUND', message: 'connect session not found' } });
    if (Date.now() > (connect.expiresAt || 0)) return cb?.({ ok: false, error: { code: 'CONNECT_SESSION_EXPIRED', message: 'connect session expired' } });
    if (!proof || (proof !== connect.callbackProof && proof !== connect.accessToken)) {
      return cb?.({ ok: false, error: { code: 'INVALID_RUNTIME_PROOF', message: 'invalid runtime proof' } });
    }
    if (!connect.agentId) return cb?.({ ok: false, error: { code: 'AGENT_NOT_READY', message: 'agent profile not ready yet' } });

    const agent = agentProfiles.get(connect.agentId);
    if (!agent) return cb?.({ ok: false, error: { code: 'AGENT_NOT_FOUND', message: 'agent not found' } });

    const prior = getAgentRuntime(agent.id);
    if (prior?.socketId && prior.socketId !== socket.id) {
      io.sockets.sockets.get(prior.socketId)?.disconnect(true);
    }

    socket.data.agentRuntime = { agentId: agent.id, connectSessionId: connect.id };
    agentRuntimeSockets.set(socket.id, agent.id);
    setAgentRuntimeStatus(agent.id, 'idle', {
      connected: true,
      socketId: socket.id,
      connectSessionId: connect.id,
      connectedAt: Date.now(),
    });
    markAgentProfileConnection(agent.id, true, 'live runtime connected');
    persistState();
    await processPublicArenaQueue();
    cb?.({
      ok: true,
      agent: { id: agent.id, name: agent.name },
      arena: summarizeAgentArenaState(agent.id),
    });
  });

  socket.on('mafia:room:create', (payload, cb) => {
    const { name } = payload || {};
    const created = mafiaGame.createRoom(mafiaRooms, { hostName: name, hostSocketId: socket.id });
    if (!created.ok) return cb?.(created);
    socket.join(`mafia:${created.room.id}`);
    logRoomEvent('mafia', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
    emitMafiaRoom(created.room);
    cb?.({ ok: true, roomId: created.room.id, playerId: created.player.id, state: mafiaGame.toPublic(created.room) });
  });

  socket.on('mafia:room:join', (payload, cb) => {
    const { roomId, name, claimToken } = payload || {};
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    if (normalizedRoomId && mafiaRooms.has(normalizedRoomId)) recordJoinAttempt('mafia', normalizedRoomId);
    const reconnect = resolveReconnectJoinName('mafia', roomId, name, claimToken);
    const joined = mafiaGame.joinRoom(mafiaRooms, { roomId, name: reconnect.name, socketId: socket.id });
    if (!joined.ok) {
      if (joined.error?.code === 'SOCKET_ALREADY_JOINED') {
        recordJoinHardeningEvent('mafia', normalizedRoomId, socket.id, reconnect.name);
      }
      return cb?.(joined);
    }
    if (reconnect.consumedClaimToken) consumeReconnectClaimTicket('mafia', joined.room.id, reconnect.consumedClaimToken);
    socket.join(`mafia:${joined.room.id}`);
    recordQuickJoinConversion('mafia', joined.room.id, joined.player.name);
    logRoomEvent('mafia', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, status: joined.room.status, phase: joined.room.phase });
    emitMafiaRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: mafiaGame.toPublic(joined.room) });
  });

  socket.on('mafia:room:watch', (payload, cb) => {
    const { roomId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    socket.join(`mafia:${room.id}`);
    cb?.({ ok: true, roomId: room.id, state: mafiaGame.toPublic(room) });
  });

  socket.on('mafia:autofill', (payload, cb) => {
    const { roomId, playerId, minPlayers } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('mafia', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('mafia:start', (payload, cb) => {
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
    const { roomId, playerId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = startReadyLobby('mafia', roomId, playerId);
    cb?.(started);
  });

  socket.on('mafia:rematch', (payload, cb) => {
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
    const { roomId, playerId, type, targetId } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    const result = mafiaGame.submitAction(mafiaRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
    recordRoomWinner('mafia', result.room);
    if (result.room.status === 'finished') recordFirstMatchCompletion('mafia', result.room.id);
    logRoomEvent('mafia', result.room, 'ACTION_SUBMITTED', {
      actorId: playerId,
      action: type,
      targetId: targetId || null,
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
    const { roomId, playerId, phase, type, targetId, message } = payload || {};
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player || !player.isLiveAgent) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Player is not a live agent seat' } });
    if (player.socketId !== socket.id) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    if (phase && phase !== room.phase) return cb?.({ ok: false, error: { code: 'STALE_PHASE', message: 'Decision does not match current phase' } });

    const transcriptPhase = room.phase;
    const transcriptDay = room.day;
    const transcriptMessage = transcriptPhase === 'discussion'
      && type === 'ready'
      && room.actions?.vote?.[player.id] !== '__READY__'
      ? sanitizeDiscussionTranscriptMessage(message)
      : '';
    const result = mafiaGame.submitAction(mafiaRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
    if (transcriptMessage) {
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
      action: type,
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
    if (runtimeAgentId) {
      agentRuntimeSockets.delete(socket.id);
      const runtime = getAgentRuntime(runtimeAgentId);
      if (runtime) {
        setAgentRuntimeStatus(runtimeAgentId, 'offline', {
          connected: false,
          socketId: null,
        });
        markAgentProfileConnection(runtimeAgentId, false, 'live runtime disconnected');
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
app.use('/api/ops/', opsLimiter);

// ── Ops Auth Gate ──
function opsAuthGate(req, res, next) {
  const token = process.env.OPS_ADMIN_TOKEN;
  if (!token) {
    // No token configured: block in production, allow in dev
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ ok: false, error: 'unauthorized — OPS_ADMIN_TOKEN not configured' });
    }
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
app.use('/api/ops/', opsAuthGate);

app.use((req, _res, next) => {
  if (req.method === 'GET' && ['/', '/index.html', '/play.html', '/browse.html', '/for-agents.html', '/guess-the-agent.html'].includes(req.path)) {
    incrementGrowthMetric('funnel.visits', 1);
  }
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const ROOM_EVENTS_FILE = path.join(DATA_DIR, 'room-events.ndjson');
const GROWTH_METRICS_FILE = path.join(__dirname, 'growth-metrics.json');

const agentProfiles = new Map();
// pair vote caps removed: agent voting is unlimited except self/owner restrictions
const sessions = new Map();
const connectSessions = new Map();
const completedMatchRooms = new Set();
const COMPLETED_MATCH_RECORD_CAP = 500;
const IN_MEMORY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let growthMetrics = null;

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

function loadGrowthMetrics() {
  try {
    if (!fs.existsSync(GROWTH_METRICS_FILE)) {
      growthMetrics = persistGrowthMetricsSnapshot();
      return;
    }
    growthMetrics = JSON.parse(fs.readFileSync(GROWTH_METRICS_FILE, 'utf8'));
  } catch (_err) {
    growthMetrics = persistGrowthMetricsSnapshot();
  }
}

function incrementGrowthMetric(path, amount = 1) {
  if (!growthMetrics) loadGrowthMetrics();
  const [bucket, key] = String(path || '').split('.');
  if (!bucket || !key) return;
  if (!growthMetrics[bucket] || typeof growthMetrics[bucket] !== 'object') growthMetrics[bucket] = {};
  growthMetrics[bucket][key] = Math.max(0, Number(growthMetrics[bucket][key] || 0) + Number(amount || 0));
  growthMetrics.updatedAt = new Date().toISOString();
  fs.writeFileSync(GROWTH_METRICS_FILE, JSON.stringify(growthMetrics, null, 2));
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
    void recordMatch(matchRecord).catch((err) => {
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
  };
  summary.badges = badgesForEntry(summary);
  return summary;
}

function decorateLeaderboardEntry(entry) {
  const agent = agentProfiles.get(entry.id);
  const arena = agent ? summarizeAgentArenaState(agent.id) : {
    runtimeConnected: false,
    queueStatus: 'offline',
    activeRoomId: null,
    requiredAgents: 6,
  };
  const activeRoomId = arena.activeRoomId || null;
  return {
    ...entry,
    isLive: Boolean(activeRoomId),
    activeRoomId,
    queueStatus: arena.queueStatus || 'offline',
    runtimeConnected: Boolean(arena.runtimeConnected),
    watchUrl: buildAgentWatchUrl(entry.id, arena),
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
      avgDurationMs: entry.durationSamples ? Math.round(entry.totalDurationMs / entry.durationSamples) : null,
    }))
    .sort((a, b) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed || b.survivalRate - a.survivalRate || String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')))
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
    (parsed.agents || []).forEach((a) => agentProfiles.set(a.id, a));
  } catch (err) {
    logStructured('error.loadState', { error: err.message });
  }
}

function snapshotKpis() {
  const events = loadEvents(ROOM_EVENTS_FILE);
  return buildKpiReport({ events, playRoomTelemetry });
}

function persistGrowthMetricsSnapshot() {
  const report = snapshotKpis();
  const payload = {
    updatedAt: report.updatedAt,
    window: 'all_time',
    funnel: {
      visits: report.funnel.created,
      connectSessionStarts: report.funnel.activationJoined,
      quickJoinStarts: report.quickJoin.tickets,
      firstMatchesCompleted: report.funnel.started,
      rematchStarts: report.rematch.clicked,
      d1ReturnRate: report.rematch.retentionProxy,
    },
    referral: {
      inviteSends: 0,
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
    notes: 'Auto-generated from room events + in-memory play telemetry via /api/ops/kpis.',
  };

  fs.writeFileSync(GROWTH_METRICS_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function isPublicRankedAgent(agent) {
  if (!agent) return false;
  if (agent.owner === 'system') return false;
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

function buildAgentWatchUrl(agentId, arena = summarizeAgentArenaState(agentId)) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return '/browse.html';
  const params = new URLSearchParams({ agentId: cleanAgentId });
  if (arena?.activeRoomId) {
    params.set('mode', 'mafia');
    params.set('room', String(arena.activeRoomId));
    params.set('spectate', '1');
  }
  return `/browse.html?${params.toString()}`;
}

async function resolveSiteSession(req) {
  const token = readBearerToken(req);
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
    expiresAt: fallback.expiresAt || null,
    durable: false,
  };
}

async function bindOwnedAgent(ownerUserId, agentId) {
  const cleanUserId = String(ownerUserId || '').trim();
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanUserId || !cleanAgentId) return;

  try {
    await setUserAgentId(cleanUserId, cleanAgentId);
  } catch (err) {
    logStructured('warn.bindOwnedAgent.persistence_unavailable', {
      userId: cleanUserId,
      agentId: cleanAgentId,
      error: err.message,
    });
    if (IS_PRODUCTION) throw err;
  }

  // Non-production fallback: also update in-memory session cache
  for (const session of sessions.values()) {
    if (session?.expiresAt && isExpiredIso(session.expiresAt)) continue;
    if (session?.userId === cleanUserId) session.agentId = cleanAgentId;
  }
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

function summarizeOwnedAgent(agentId) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) return null;
  const agent = agentProfiles.get(cleanAgentId);
  if (!agent) return null;
  const arena = {
    ...summarizeAgentArenaState(agent.id),
    ...buildArenaAvailability(),
  };
  return {
    id: agent.id,
    name: agent.name,
    deployed: !!agent.deployed,
    persona: agent.persona || null,
    watchUrl: buildAgentWatchUrl(agent.id, arena),
    arena,
  };
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
  return upsertAgentRuntime(agentId, { status, ...patch });
}

function clearAgentRuntimeAssignment(agentId, nextStatus = 'idle') {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) return null;
  if (!runtime.connected) nextStatus = 'offline';
  return upsertAgentRuntime(agentId, {
    status: nextStatus,
    currentRoomId: null,
    currentPlayerId: null,
  });
}

function runtimeSocketForAgent(agentId) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime?.socketId) return null;
  return io.sockets.sockets.get(runtime.socketId) || null;
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
      return Number(aRuntime?.connectedAt || 0) - Number(bRuntime?.connectedAt || 0);
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
  const sock = io.sockets.sockets.get(runtime.socketId);
  if (sock) sock.join(`mafia:${room.id}`);
}

function clearPublicArenaSeatRuntime(agentId, nextStatus = 'reserved') {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) return null;
  return upsertAgentRuntime(agentId, {
    status: runtime.connected ? nextStatus : 'offline',
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
  for (const agent of agents) {
    if (!agent?.id) return { ok: false, error: 'missing agent id' };
    if (seenNames.has(agent.name)) return { ok: false, error: 'duplicate agent name in batch' };
    seenNames.add(agent.name);
    const runtime = getAgentRuntime(agent.id);
    if (!runtime?.connected || !runtime.socketId) {
      return { ok: false, error: `agent runtime unavailable: ${agent.id}` };
    }
  }

  return { ok: true };
}

function createPublicArenaMafiaRoom(agents) {
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
  try {
    let idleAgents = idleLaunchAgents();
    while (idleAgents.length >= PUBLIC_ARENA_REQUIRED_AGENTS) {
      const batch = idleAgents.slice(0, PUBLIC_ARENA_REQUIRED_AGENTS);
      batch.forEach((agent) => setAgentRuntimeStatus(agent.id, 'reserved'));
      const room = createPublicArenaMafiaRoom(batch);
      if (!room) {
        logStructured('mafia.publicArena.batch_failed', {
          agentIds: batch.map((agent) => agent.id),
          connectedAgents: idleAgents.length,
        });
        batch.forEach((agent) => clearAgentRuntimeAssignment(agent.id, 'idle'));
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
  const existingToken = req.headers.authorization?.replace('Bearer ', '') || req.body?.token;
  if (existingToken) {
    const [siteSession, existing] = await Promise.all([
      resolveSiteSession({ headers: { authorization: `Bearer ${existingToken}` } }),
      getSessionByToken(existingToken),
    ]);
    if (siteSession?.userId) {
      return res.json({
        ok: true,
        session: {
          token: existingToken,
          userId: siteSession.userId || existing?.user_id || null,
          agentId: siteSession?.agentId || null,
          expiresAt: siteSession?.expiresAt || existing?.expires_at || null,
          durable: siteSession?.durable !== false,
        },
        ownedAgent: summarizeOwnedAgent(siteSession?.agentId),
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

    res.json({
      ok: true,
      session: { token, userId, agentId: null, expiresAt, durable: true },
      ownedAgent: null,
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
    res.json({
      ok: true,
      session: { token: token2, userId, agentId: null, expiresAt: fallbackExpiresAt, durable: false },
      ownedAgent: null,
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
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'No token provided' });

  try {
    const user = await getUserByToken(token);
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
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'No token provided' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const displayName = String(req.body?.displayName || '').trim().slice(0, 40);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }

  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

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
    if (/unique|duplicate key/i.test(String(err.message || ''))) {
      return res.status(409).json({ ok: false, error: 'Email already in use' });
    }
    res.status(500).json({ ok: false, error: 'Upgrade failed' });
  }
});

// ── Match history for authenticated user ──
app.get('/api/matches/mine', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'No token provided' });

  try {
    const siteSession = await resolveSiteSession(req);
    if (!siteSession?.userId) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const agentId = String(siteSession.agentId || '').trim();
    let matches = [];
    let source = 'none';
    let durability = 'none';
    if (agentId) {
      matches = await getPlayerMatches(agentId, limit);
      if (matches.length) {
        source = 'database';
        durability = 'database';
      } else {
        matches = getPlayerMatchesFallback(agentId, limit);
        source = 'memory';
        durability = 'ephemeral_memory';
      }
    }
    res.json({ ok: true, agentId: agentId || null, matches, source, durability });
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
  persistState,
  resolvePublicBaseUrl,
  resolveSiteSession,
  roomEvents,
  shortId,
  summarizeAgentArenaState,
}));

app.post('/api/openclaw/style-sync', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const agentName = String(req.body?.agentName || '').trim();
  const profile = req.body?.profile && typeof req.body.profile === 'object' ? req.body.profile : null;
  if (!email || !agentName || !profile) {
    return res.status(400).json({ ok: false, error: 'email, agentName, profile required' });
  }

  const agent = [...agentProfiles.values()]
    .filter((a) => a.owner === email && a.name === agentName)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found for owner/name' });

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

  persistState();
  res.json({ ok: true, agent });
});

app.get('/api/agents/mine', async (req, res) => {
  const siteSession = await resolveSiteSession(req);
  if (!siteSession?.userId) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }

  const agent = summarizeOwnedAgent(siteSession.agentId);
  const statsBundle = siteSession.agentId ? await buildOwnedAgentStats(siteSession.agentId) : null;
  res.json({
    ok: true,
    session: {
      userId: siteSession.userId,
      agentId: siteSession.agentId || null,
    },
    agent,
    stats: statsBundle?.stats || null,
    statsSource: statsBundle?.source || 'none',
    statsDurability: statsBundle?.durability || 'none',
    statsCapped: Boolean(statsBundle?.capped),
    arena: buildArenaAvailability(),
  });
});

app.get('/api/agents/:id', (req, res) => {
  const agent = agentProfiles.get(String(req.params.id || '').trim());
  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found' });
  const arena = {
    ...summarizeAgentArenaState(agent.id),
    ...buildArenaAvailability(),
  };

  res.json({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      mmr: agent.mmr,
      karma: agent.karma,
      deployed: !!agent.deployed,
      openclawConnected: arena.runtimeConnected,
      persona: agent.persona || null,
      watchUrl: buildAgentWatchUrl(agent.id, arena),
      arena,
    },
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
    res.json({ ok: true, agentId: targetAgentId, matches, source, durability });
  } catch (err) {
    logStructured('error.getPlayerMatches', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed to fetch matches' });
  }
});

// ── Report a player/message ──
app.post('/api/report', async (req, res) => {
  const roomId = String(req.body?.roomId || '').trim();
  const targetPlayer = String(req.body?.targetPlayer || '').trim().slice(0, 40);
  const messageText = String(req.body?.messageText || '').trim().slice(0, 500);
  const reason = String(req.body?.reason || 'inappropriate').trim().slice(0, 60);

  if (!roomId || !targetPlayer) {
    return res.status(400).json({ ok: false, error: 'roomId and targetPlayer are required' });
  }

  try {
    // Get reporter ID from auth token if available
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    let reporterId = null;
    if (token) {
      const user = await getUserByToken(token);
      if (user) reporterId = user.id;
    }

    await createReport({ reporterId, roomId, targetPlayer, messageText, reason });
    logStructured('report.created', { roomId, targetPlayer, reason, reporterId });
    res.json({ ok: true });
  } catch (err) {
    logStructured('error.createReport', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed to submit report' });
  }
});

// ── Ops: list reports ──
app.get('/api/ops/reports', async (req, res) => {
  const status = String(req.query.status || '').trim() || undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  try {
    const reports = await getReports({ status, limit });
    res.json({ ok: true, reports });
  } catch (err) {
    logStructured('error.getReports', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed to fetch reports' });
  }
});

// ── Ops: update report status ──
app.patch('/api/ops/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!status || !['pending', 'reviewed', 'actioned', 'dismissed'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'valid status required: pending, reviewed, actioned, dismissed' });
  }
  try {
    await updateReportStatus(id, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'failed to update report' });
  }
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
const MAFIA_PHASE_MS = {
  night: Number(process.env.MAFIA_NIGHT_MS || 15000),
  discussion: Number(process.env.MAFIA_DISCUSSION_MS || 30000),
  voting: Number(process.env.MAFIA_VOTING_MS || 15000),
};

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

app.get('/api/play/rooms', (req, res) => {
  const modeInput = String(req.query.mode || PUBLIC_LAUNCH_MODE).toLowerCase();
  const modeFilter = modeInput === 'all' ? PUBLIC_LAUNCH_MODE : modeInput;
  const statusFilter = String(req.query.status || 'all').toLowerCase();

  if (!['all', 'mafia'].includes(modeInput)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode filter' });
  }
  if (!isEnabledPublicMode(modeFilter)) {
    return res.status(400).json(modeDisabledError(modeFilter));
  }

  const roomsList = listPlayableRooms(modeFilter, statusFilter);
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

  res.json({ ok: true, rooms: roomsList.slice(0, 50), summary });
});

app.get('/api/play/lobby/claims', (req, res) => {
  const mode = String(req.query.mode || '').toLowerCase();
  const roomId = String(req.query.roomId || '').trim().toUpperCase();

  if (!roomId) {
    return res.status(400).json({ ok: false, error: { code: 'ROOM_ID_REQUIRED', message: 'roomId required' } });
  }

  const claims = getClaimableLobbySeats(mode, roomId);
  if (!claims.ok) {
    return res.status(claims.error?.code === 'ROOM_NOT_FOUND' ? 404 : 400).json(claims);
  }

  res.json(claims);
});

app.post('/api/play/reconnect-telemetry', (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const roomId = String(req.body?.roomId || '').trim().toUpperCase();
  const outcome = String(req.body?.outcome || '').toLowerCase();
  const event = String(req.body?.event || '').toLowerCase();

  if (mode !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }
  if (!roomId) {
    return res.status(400).json({ ok: false, error: { code: 'ROOM_ID_REQUIRED', message: 'roomId required' } });
  }

  const hasOutcome = Boolean(outcome);
  const hasEvent = Boolean(event);
  if (!hasOutcome && !hasEvent) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_PAYLOAD', message: 'provide outcome and/or event' } });
  }
  if (hasOutcome && !['attempt', 'success', 'failure'].includes(outcome)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_OUTCOME', message: 'outcome must be attempt|success|failure' } });
  }
  if (hasEvent && !['reclaim_clicked', 'quick_recover_clicked'].includes(event)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_EVENT', message: 'event must be reclaim_clicked|quick_recover_clicked' } });
  }

  let telemetry = getRoomTelemetry(mode, roomId);
  if (hasOutcome) telemetry = recordReconnectAutoTelemetry(mode, roomId, outcome);
  if (hasEvent) telemetry = recordReconnectClickTelemetry(mode, roomId, event);
  roomEvents.append('growth', roomId, 'RECONNECT_TELEMETRY_RECORDED', {
    mode,
    outcome: hasOutcome ? outcome : null,
    event: hasEvent ? event : null,
  });

  res.json({
    ok: true,
    mode,
    roomId,
    reconnectAuto: {
      attempts: telemetry.reconnectAutoAttempts,
      successes: telemetry.reconnectAutoSuccesses,
      failures: telemetry.reconnectAutoFailures,
    },
    reconnectRecoveryClicks: {
      reclaim_clicked: telemetry.reclaimClicked,
      quick_recover_clicked: telemetry.quickRecoverClicked,
    },
  });
});

app.post('/api/play/quick-join', (req, res) => {
  incrementGrowthMetric('funnel.quickJoinStarts', 1);
  const modeInput = String(req.body?.mode || 'all').toLowerCase();
  const playerName = String(req.body?.name || '').trim().slice(0, 24) || `Player-${Math.floor(Math.random() * 900) + 100}`;

  if (!['all', 'mafia'].includes(modeInput)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode' });
  }
  if (!['all', PUBLIC_LAUNCH_MODE].includes(modeInput)) {
    return res.status(400).json(modeDisabledError(modeInput));
  }

  const selectedMode = PUBLIC_LAUNCH_MODE;
  roomEvents.append('growth', selectedMode, 'QUICK_JOIN_REQUESTED', {
    modeInput,
    selectedMode,
  });
  const candidates = listPlayableRooms(selectedMode, 'open')
    .filter((room) => room.canJoin)
    .sort((a, b) => {
      const aScore = Number(a.matchQuality?.score || 0);
      const bScore = Number(b.matchQuality?.score || 0);
      return bScore - aScore || b.players - a.players || (b.createdAt || 0) - (a.createdAt || 0);
    });

  let targetRoom = candidates[0] || null;
  let created = false;

  if (!targetRoom) {
    const createdRoom = createQuickJoinRoom(selectedMode, playerName);
    if (!createdRoom.ok) return res.status(400).json(createdRoom);
    logRoomEvent(selectedMode, createdRoom.room, 'ROOM_CREATED', { status: createdRoom.room.status, phase: createdRoom.room.phase });
    const autoFilled = autoFillLobbyBots(selectedMode, createdRoom.room.id, QUICK_JOIN_MIN_PLAYERS);
    if (!autoFilled.ok) return res.status(400).json(autoFilled);
    targetRoom = summarizePlayableRoom(selectedMode, createdRoom.room);
    created = true;
  }

  const reconnectSuggestion = created ? null : pickReconnectSuggestion(targetRoom.mode, targetRoom.roomId, playerName);
  const suggestedName = reconnectSuggestion?.name || playerName;
  const claimToken = reconnectSuggestion?.token || '';
  const quickJoinDecision = buildQuickJoinDecision(candidates, targetRoom, created);
  const quickHint = encodeURIComponent(String(quickJoinDecision.message || '').slice(0, 180));
  const joinTicket = {
    mode: targetRoom.mode,
    roomId: targetRoom.roomId,
    name: playerName,
    autojoin: true,
    reconnect: reconnectSuggestion,
    quickJoinDecision,
    joinUrl: `/play.html?game=${targetRoom.mode}&room=${targetRoom.roomId}&autojoin=1&name=${encodeURIComponent(playerName)}&qjReason=${quickHint}${reconnectSuggestion ? `&reclaimName=${encodeURIComponent(suggestedName)}&reclaimHost=${reconnectSuggestion.hostSeat ? '1' : '0'}&claimToken=${encodeURIComponent(claimToken)}` : ''}`,
    issuedAt: Date.now(),
  };

  issueQuickJoinTicket(targetRoom.mode, targetRoom.roomId, playerName);
  roomEvents.append('growth', targetRoom.roomId, 'QUICK_JOIN_TICKET_ISSUED', {
    mode: targetRoom.mode,
    created,
    hasReconnectSuggestion: Boolean(reconnectSuggestion),
    reasonCode: quickJoinDecision.reasonCode,
  });
  res.json({
    ok: true,
    created,
    room: summarizePlayableRoom(targetRoom.mode, mafiaRooms.get(targetRoom.roomId)),
    quickJoinDecision,
    joinTicket,
  });
});

app.post('/api/play/lobby/autofill', (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const roomId = String(req.body?.roomId || '').trim().toUpperCase();
  const minPlayers = Number(req.body?.minPlayers || QUICK_JOIN_MIN_PLAYERS);

  if (mode !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }

  if (!roomId) {
    return res.status(400).json({ ok: false, error: { code: 'ROOM_ID_REQUIRED', message: 'roomId required' } });
  }

  const result = autoFillLobbyBots(mode, roomId, minPlayers);
  if (!result.ok) return res.status(400).json(result);

  res.json({
    ok: true,
    mode,
    roomId: result.room.id,
    targetPlayers: result.targetPlayers,
    addedBots: result.addedBots,
    state: mafiaGame.toPublic(result.room),
  });
});

loadState();
if (typeof loadGrowthMetrics === 'function') {
  loadGrowthMetrics();
} else {
  growthMetrics = growthMetrics || {
    funnel: {
      visits: 0,
      quickJoinStarts: 0,
      connectSessionStarts: 0,
      firstMatchesCompleted: 0,
      rematchStarts: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

// ── Instant Play: one-click to join a game ──
app.post('/api/play/instant', (req, res) => {
  const modeInput = String(req.body?.mode || 'mafia').toLowerCase();
  if (modeInput !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }
  if (!isEnabledPublicMode(modeInput)) {
    return res.status(400).json(modeDisabledError(modeInput));
  }
  const agentId = String(req.body?.agentId || '').trim();
  if (!agentId) return res.status(400).json(agentRequiredError());

  const agent = agentProfiles.get(agentId);
  if (!agent) return res.status(404).json(agentRequiredError());
  if (!agent.deployed || !agent.openclaw?.connected) {
    return res.status(400).json(agentNotReadyError());
  }
  const runtime = getAgentRuntime(agentId);
  if (!runtime?.connected) {
    return res.status(400).json(agentRuntimeRequiredError());
  }

  const arena = buildArenaAvailability();
  trackEvent('instant_play_requested', agent.name, { mode: arena.mode, agentId, connectedAgents: arena.connectedAgents });

  if (runtime.currentRoomId && runtime.currentPlayerId) {
    return res.json({
      ok: true,
      mode: arena.mode,
      waiting: false,
      activeRoomId: runtime.currentRoomId,
      activePlayerId: runtime.currentPlayerId,
      watchUrl: buildAgentWatchUrl(agentId, { ...runtime, activeRoomId: runtime.currentRoomId }),
      message: 'Your agent is already in a live Mafia match.',
    });
  }

  void processPublicArenaQueue();
  const refreshed = getAgentRuntime(agentId);
  if (refreshed?.currentRoomId && refreshed?.currentPlayerId) {
    return res.json({
      ok: true,
      mode: arena.mode,
      waiting: false,
      activeRoomId: refreshed.currentRoomId,
      activePlayerId: refreshed.currentPlayerId,
      watchUrl: buildAgentWatchUrl(agentId, { ...refreshed, activeRoomId: refreshed.currentRoomId }),
      message: 'Your agent has been seated in the next live Mafia match.',
    });
  }

  return res.json({
    ok: true,
    mode: arena.mode,
    waiting: true,
    connectedAgents: arena.connectedAgents,
    requiredAgents: arena.requiredAgents,
    missingAgents: arena.missingAgents,
    canStart: arena.canStart,
    message: arena.canStart
      ? 'Connected agents are online. Public live seat assignment is not available yet, so watch the arena while agent-only matchmaking finishes wiring up.'
      : `Need ${arena.missingAgents} more connected agent(s) before an agent-only Mafia room can open.`,
  });
});

// ── Watch: spectate the most active game ──
app.get('/api/play/watch', (_req, res) => {
  const allRooms = listPlayableRooms(PUBLIC_LAUNCH_MODE, 'all');
  const active = allRooms
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => (b.players || 0) - (a.players || 0));

  if (active.length > 0) {
    const best = active[0];
    return res.json({
      ok: true,
      found: true,
      roomId: best.roomId,
      mode: best.mode,
      watchUrl: `/browse.html?mode=${best.mode}&room=${best.roomId}&spectate=1`,
      players: best.players,
    });
  }
  const arena = buildArenaAvailability();
  res.json({
    ok: true,
    found: false,
    mode: arena.mode,
    connectedAgents: arena.connectedAgents,
    requiredAgents: arena.requiredAgents,
    missingAgents: arena.missingAgents,
    message: arena.connectedAgents > 0
      ? `No live agent-only Mafia room is running yet. Need ${arena.missingAgents} more connected agent(s) to open the arena.`
      : 'No live agent-only Mafia rooms yet. Connect an OpenClaw agent to help open the arena.',
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
      <a href="/browse.html">Watch</a>
      <a href="/leaderboard.html">Leaderboard</a>
      <a href="/guide.html#join">Join</a>
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
          <a class="btn btn-primary" href="/browse.html">Watch your agent</a>
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

app.get('/play.html', (req, res) => {
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `/browse.html${search}`);
});

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

app.get('/api/ops/kpis', (_req, res) => {
  const report = snapshotKpis();
  res.json({ ok: true, ...report });
});

app.post('/api/ops/kpis/refresh', (_req, res) => {
  const payload = persistGrowthMetricsSnapshot();
  res.json({ ok: true, metrics: payload });
});

app.post('/api/ops/kpis/snapshot', (_req, res) => {
  const metrics = persistGrowthMetricsSnapshot();
  growthMetrics = metrics;
  res.json({ ok: true, metrics });
});

app.get('/api/ops/funnel', (_req, res) => {
  res.json({ ok: true, metrics: growthMetrics });
});

app.get('/api/ops/match-baseline', async (req, res) => {
  const mode = String(req.query.mode || 'mafia').toLowerCase();
  if (mode !== 'mafia') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia' } });
  }
  res.json({ ok: true, baseline: await buildMatchBaseline(mode) });
});

app.get('/health', async (_req, res) => {
  const scheduler = roomScheduler.stats();
  const eventQueueDepth = roomEvents.pending();
  const eventQueueByMode = roomEvents.pendingByMode();

  const dbHealth = await getDatabaseHealth();
  const dbStatus = dbHealth.status || 'unavailable';
  const durableStorageRequired = IS_PRODUCTION;
  const durableStorageHealthy = dbStatus === 'ok';
  const healthy = durableStorageHealthy || !durableStorageRequired;
  const httpStatus = healthy ? 200 : 503;

  res.status(httpStatus).json({
    ok: healthy,
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    launchMode: PUBLIC_LAUNCH_MODE,
    publicBaseUrl: PUBLIC_APP_URL || null,
    database: dbStatus,
    databaseDriver: dbHealth.driver || 'none',
    durableStorageRequired,
    uptimeSec: Math.floor(process.uptime()),
    rooms: {
      mafia: mafiaRooms.size,
    },
    agents: agentProfiles.size,
    schedulerTimers: scheduler,
    eventQueueDepth,
    eventQueueByMode,
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
  liveAgentRuntimes.clear();
  agentRuntimeSockets.clear();
  activeAgentMatchRooms.clear();
  completedMatchRooms.clear();
  completedMatchRecords.length = 0;
}

if (require.main === module) {
  void (async () => {
    try {
      const database = await initDb();
      if (database) {
        const health = await getDatabaseHealth();
        console.log(`${String(health.driver || 'database')} initialized`);
      } else if (IS_PRODUCTION) {
        throw new Error('Production requires DATABASE_URL-backed Postgres; database initialization returned no durable store.');
      } else {
        console.warn('[startup] Database unavailable; running without durable persistence');
      }
    } catch (err) {
      console.error('Database init failed:', err.message);
      if (IS_PRODUCTION) {
        process.exit(1);
      }
    }

    loadState();

    // Stale room cleanup — every 5 minutes
    setInterval(cleanupStaleRooms, 5 * 60 * 1000);

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
  roomEvents,
  PUBLIC_APP_URL,
  resolvePublicBaseUrl,
  injectPublicBaseUrl,
  buildRuntimeConfigScript,
  processPublicArenaQueue,
  createPublicArenaMafiaRoom,
  buildMatchBaseline,
  clearAllGameTimers,
  resetPlayTelemetry,
  seedPlayTelemetry,
  resetAgentArenaRuntime,
};
