const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mafiaGame = require('./games/agent-mafia');
const amongUsGame = require('./games/agents-among-us');
const villaGame = require('./games/agent-villa');
const { createRoomScheduler } = require('./lib/room-scheduler');
const { createRoomEventLog } = require('./lib/room-events');
const { runBotTurn } = require('./bots/turn-loop');
const { moderateRoast } = require('./bots/roast-policy');
const { rememberBotRound, summarizeBotMemory } = require('./bots/episodic-memory');
const { runEval } = require('./lib/eval-harness');
const { parseThresholdsFromEnv, evaluateEvalReport } = require('./lib/eval-thresholds');
const { createCanaryMode } = require('./lib/canary-mode');
const { loadEvents, buildKpiReport } = require('./lib/kpi-report');
const { shortId, correlationId, logStructured } = require('./server/state/helpers');
const { createPlayTelemetryService } = require('./server/services/play-telemetry');
const { socketOwnsPlayer, socketIsHostPlayer } = require('./server/sockets/ownership-guards');
const { registerRoomEventRoutes } = require('./server/routes/room-events');
const { initDb, recordMatch, closeDb } = require('./server/db');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { track: trackEvent } = require('./server/services/analytics');

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  },
});

const PORT = process.env.PORT || 3000;
const ROUND_MS = Number(process.env.ROUND_MS || 60_000);
const VOTE_MS = Number(process.env.VOTE_MS || 20_000);

const THEMES = [
  'Yo Mama So Fast',
  'Tech Twitter',
  'Startup Founder',
  'Gym Bro',
  'Crypto',
  'Corporate',
  'SaaS Burn Rate',
  'VC Pitch Night',
  'Customer Support Meltdown',
  'AI Hype Train',
  'Remote Work Drama',
];

/** @type {Map<string, any>} */
const rooms = new Map();

const mafiaRooms = mafiaGame.createStore();
const amongUsRooms = amongUsGame.createStore();
const villaRooms = villaGame.createStore();
const roomScheduler = createRoomScheduler();
const roomEvents = createRoomEventLog({ dataDir: path.join(__dirname, 'data') });
const playRoomTelemetry = new Map();
const pendingQuickJoinTickets = new Map();
const reconnectClaimTickets = new Map();
const arenaCanary = createCanaryMode({
  enabled: process.env.ARENA_CANARY_ENABLED !== '0',
  percent: Number(process.env.ARENA_CANARY_PERCENT || 0),
});

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

const ROOM_TRANSITIONS = {
  BATTLE_RESET: {
    lobby: 'lobby',
    round: 'lobby',
    voting: 'lobby',
    finished: 'lobby',
  },
  BEGIN_ROUND: {
    lobby: 'round',
  },
  BEGIN_VOTING: {
    round: 'voting',
  },
  ROUND_COMPLETE_CONTINUE: {
    voting: 'lobby',
  },
  ROUND_COMPLETE_FINISH: {
    voting: 'finished',
  },
};

function transitionRoomState(room, event) {
  const transitions = ROOM_TRANSITIONS[event];
  if (!transitions) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TRANSITION_EVENT',
        message: `Unknown room transition event: ${event}`,
        event,
      },
    };
  }

  const from = room.status;
  const to = transitions[from];
  if (!to) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ROOM_TRANSITION',
        message: `Cannot transition room from ${from} using ${event}`,
        from,
        event,
      },
    };
  }

  room.status = to;
  return { ok: true, from, to, event };
}

function createRoom(host) {
  const roomId = shortId(6).toUpperCase();
  const canaryBucket = arenaCanary.assignRoom(roomId);
  const room = {
    id: roomId,
    createdAt: Date.now(),
    canaryBucket,
    hostSocketId: host.socketId,
    theme: THEMES[0],
    themeRotation: [...THEMES].sort(() => Math.random() - 0.5).slice(0, 5),
    players: [],
    spectators: new Set(),
    status: 'lobby',
    round: 0,
    maxRounds: 5,
    roastsByRound: {},
    votesByRound: {},
    totalVotes: {},
    roundEndsAt: null,
    voteEndsAt: null,
    lastWinner: null,
  };
  rooms.set(roomId, room);
  logRoomEvent('arena', room, 'ROOM_CREATED', { status: room.status, round: room.round, canaryBucket: room.canaryBucket });
  return room;
}

function getPublicRoom(room) {
  return {
    id: room.id,
    theme: room.theme,
    status: room.status,
    round: room.round,
    maxRounds: room.maxRounds,
    canaryBucket: room.canaryBucket || 'control',
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      isBot: !!p.isBot,
      persona: p.persona || null,
      owner: p.owner || null,
      score: room.totalVotes[p.id] || 0,
      isConnected: p.isConnected,
    })),
    roastsByRound: room.roastsByRound,
    votesByRound: room.votesByRound,
    roundEndsAt: room.roundEndsAt,
    voteEndsAt: room.voteEndsAt,
    lastWinner: room.lastWinner,
  };
}

function emitRoom(room) {
  io.to(room.id).emit('room:update', getPublicRoom(room));
}

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

function ensurePlayer(room, socket, payload) {
  const { name, type } = payload;
  if (!name || !name.trim()) return { error: 'Name required' };
  const cleanType = type === 'agent' ? 'agent' : 'human';
  const owner = String(payload?.owner || '').trim().toLowerCase();

  if (cleanType === 'agent' && (!owner || !owner.includes('@'))) return { error: 'Agent owner email required' };

  const cleanName = name.trim().slice(0, 24);
  let player = room.players.find((p) => p.socketId === socket.id);

  if (!player) {
    player = room.players.find((p) => {
      if (p.isBot || p.isConnected || p.type !== cleanType) return false;
      if (cleanType === 'agent') return p.owner === owner;
      return p.name === cleanName;
    });
  }

  if (!player) {
    player = {
      id: shortId(8),
      socketId: socket.id,
      name: cleanName,
      type: cleanType,
      isBot: false,
      isConnected: true,
      owner: cleanType === 'agent' ? owner : null,
    };
    room.players.push(player);
  } else {
    player.socketId = socket.id;
    player.name = cleanName;
    player.type = cleanType;
    player.isConnected = true;
    player.owner = cleanType === 'agent' ? owner : null;
  }

  if (!(player.id in room.totalVotes)) room.totalVotes[player.id] = 0;
  return { player };
}

function addBot(room, payload = {}) {
  const bot = {
    id: shortId(8),
    name: (payload.name || `Bot-${Math.floor(Math.random() * 999)}`).slice(0, 24),
    type: 'agent',
    isBot: true,
    socketId: null,
    isConnected: true,
    owner: 'system@agentarena',
    persona: {
      style: payload.persona?.style || 'witty',
      intensity: payload.persona?.intensity || 6,
    },
    memory: [],
  };
  room.players.push(bot);
  room.totalVotes[bot.id] = 0;
  return bot;
}

function generateBotRoast(theme, bot, intensity = 6, style = 'witty') {
  const memorySummary = summarizeBotMemory(bot);
  const recentRoasts = Array.isArray(bot?.memory) ? bot.memory.map((entry) => entry.roast).filter(Boolean) : [];
  const turn = runBotTurn({ theme, botName: bot?.name || 'Bot', intensity, style, memorySummary, recentRoasts });
  return turn.text;
}

function autoSubmitBotRoasts(room) {
  const bots = room.players.filter((p) => p.isBot);
  for (const bot of bots) {
    const delay = 1000 + Math.floor(Math.random() * 7000);
    roomScheduler.schedule({
      namespace: 'arena',
      roomId: room.id,
      slot: `bot-roast:${room.round}:${bot.id}`,
      delayMs: delay,
      token: `${room.round}:round`,
    }, () => {
      const current = rooms.get(room.id);
      if (!current || current.status !== 'round' || current.round !== room.round) return;
      if (current.roastsByRound[current.round][bot.id]) return;
      const roast = generateBotRoast(current.theme, bot, bot.persona?.intensity || 6, bot.persona?.style || 'witty');
      current.roastsByRound[current.round][bot.id] = roast;
      maybeAdvanceToVoting(current);
      emitRoom(current);
    });
  }
}

function maybeAdvanceToVoting(room) {
  const allSubmitted = room.players.every((p) => room.roastsByRound[room.round][p.id]);
  if (allSubmitted) beginVoting(room);
}

function beginRound(room) {
  if (room.players.length < 2) return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 2 players' } };

  const transition = transitionRoomState(room, 'BEGIN_ROUND');
  if (!transition.ok) return transition;

  room.round += 1;
  room.theme = room.themeRotation[room.round - 1] || THEMES[(room.round - 1) % THEMES.length];
  room.roastsByRound[room.round] = {};
  room.votesByRound[room.round] = {};
  room.roundEndsAt = Date.now() + ROUND_MS;
  logRoomEvent('arena', room, 'ROUND_STARTED', {
    status: room.status,
    phase: 'round',
    round: room.round,
    theme: room.theme,
  });

  autoSubmitBotRoasts(room);

  roomScheduler.schedule({
    namespace: 'arena',
    roomId: room.id,
    slot: 'round-deadline',
    delayMs: ROUND_MS,
    token: `${room.round}:round`,
  }, () => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'round' || current.round !== room.round) return;
    beginVoting(current);
  });

  emitRoom(room);
}

function beginVoting(room) {
  const transition = transitionRoomState(room, 'BEGIN_VOTING');
  if (!transition.ok) return transition;

  room.voteEndsAt = Date.now() + VOTE_MS;
  logRoomEvent('arena', room, 'VOTING_STARTED', {
    status: room.status,
    phase: 'voting',
    round: room.round,
  });
  emitRoom(room);

  roomScheduler.schedule({
    namespace: 'arena',
    roomId: room.id,
    slot: 'vote-deadline',
    delayMs: VOTE_MS,
    token: `${room.round}:vote`,
  }, () => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'voting' || current.round !== room.round) return;
    finalizeRound(current);
  });
}

function finalizeRound(room) {
  const roundVotes = room.votesByRound[room.round] || {};
  let winnerId = null;
  let best = -1;
  for (const [playerId, count] of Object.entries(roundVotes)) {
    if (playerId.startsWith('voter:')) continue;
    if (count > best) {
      winnerId = playerId;
      best = count;
    }
  }

  if (!winnerId) {
    const submittedIds = Object.keys(room.roastsByRound[room.round] || {});
    if (submittedIds.length) {
      winnerId = submittedIds[Math.floor(Math.random() * submittedIds.length)];
      best = 0;
    }
  }

  if (winnerId) {
    room.totalVotes[winnerId] = (room.totalVotes[winnerId] || 0) + 1;
    const winner = room.players.find((p) => p.id === winnerId);
    room.lastWinner = {
      id: winnerId,
      name: winner?.name || 'Unknown',
      round: room.round,
      votes: best,
      quote: room.roastsByRound[room.round]?.[winnerId] || '',
    };
  }

  for (const player of room.players) {
    if (!player.isBot) continue;
    rememberBotRound(player, {
      round: room.round,
      theme: room.theme,
      roast: room.roastsByRound[room.round]?.[player.id] || '',
      votes: Number(roundVotes[player.id] || 0),
      winner: player.id === winnerId,
    });
  }

  room.roundEndsAt = null;
  room.voteEndsAt = null;
  const transition = transitionRoomState(room, room.round >= room.maxRounds ? 'ROUND_COMPLETE_FINISH' : 'ROUND_COMPLETE_CONTINUE');
  if (!transition.ok) return transition;

  if (room.status === 'finished') recordFirstMatchCompletion('arena', room.id);
  logRoomEvent('arena', room, room.status === 'finished' ? 'BATTLE_FINISHED' : 'ROUND_FINISHED', {
    status: room.status,
    phase: room.status,
    round: room.round,
    winner: room.lastWinner?.id || null,
    winnerName: room.lastWinner?.name || null,
  });

  emitRoom(room);

  if (room.status !== 'finished') {
    roomScheduler.schedule({
      namespace: 'arena',
      roomId: room.id,
      slot: 'next-round',
      delayMs: 2000,
      token: `${room.round}:next`,
    }, () => {
      const current = rooms.get(room.id);
      if (!current || current.status !== 'lobby') return;
      beginRound(current);
    });
  }
}

function nextTheme(room) {
  const options = THEMES.filter((t) => t !== room.theme);
  room.theme = options[Math.floor(Math.random() * options.length)] || THEMES[0];
  emitRoom(room);
}

function emitMafiaRoom(room) {
  io.to(`mafia:${room.id}`).emit('mafia:state', mafiaGame.toPublic(room));
}

function emitAmongUsRoom(room) {
  io.to(`amongus:${room.id}`).emit('amongus:state', amongUsGame.toPublic(room));
}

function emitVillaRoom(room) {
  io.to(`villa:${room.id}`).emit('villa:state', villaGame.toPublic(room));
}

function pickDeterministicTarget(players, actorId) {
  return players
    .filter((p) => p.alive && p.id !== actorId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function pickVillaTarget(room, actorId) {
  const immunity = room.roundState?.challenge?.immunityPlayerId || null;
  const players = room.players || [];
  if (room.phase === 'twist' || room.phase === 'elimination') {
    return players
      .filter((p) => p.alive && p.id !== actorId && p.id !== immunity)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
  }
  return pickDeterministicTarget(players, actorId);
}

function runMafiaBotAutoplay(room) {
  if (!room || room.status !== 'in_progress') return { acted: 0 };
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

function runAmongUsBotAutoplay(room) {
  if (!room || room.status !== 'in_progress') return { acted: 0 };
  let acted = 0;

  if (room.phase === 'tasks') {
    const aliveBots = room.players.filter((p) => p.alive && p.isBot);
    for (const bot of aliveBots) {
      if (room.phase !== 'tasks' || room.status !== 'in_progress') break;

      if (bot.role === 'crew' && bot.tasksDone < room.tasksToWin) {
        const taskResult = amongUsGame.submitAction(amongUsRooms, { roomId: room.id, playerId: bot.id, type: 'task' });
        if (taskResult.ok) acted += 1;
        continue;
      }

      if (bot.role === 'imposter') {
        const target = room.players
          .filter((p) => p.alive && p.role === 'crew')
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
        if (!target) continue;
        const killResult = amongUsGame.submitAction(amongUsRooms, { roomId: room.id, playerId: bot.id, type: 'kill', targetId: target.id });
        if (killResult.ok) acted += 1;
      }
    }
  }

  if (room.status === 'in_progress' && room.phase === 'meeting') {
    const aliveBots = room.players.filter((p) => p.alive && p.isBot);
    for (const bot of aliveBots) {
      if (room.phase !== 'meeting' || room.status !== 'in_progress') break;
      if (room.votes?.[bot.id]) continue;
      const target = pickDeterministicTarget(room.players, bot.id);
      if (!target) continue;
      const voteResult = amongUsGame.submitAction(amongUsRooms, { roomId: room.id, playerId: bot.id, type: 'vote', targetId: target.id });
      if (voteResult.ok) acted += 1;
    }
  }

  if (acted > 0) {
    logRoomEvent('amongus', room, 'BOTS_AUTOPLAYED', { acted, phase: room.phase, status: room.status });
  }
  return { acted };
}

function runVillaBotAutoplay(room) {
  if (!room || room.status !== 'in_progress') return { acted: 0 };
  let acted = 0;
  const startingPhase = room.phase;
  const phaseType = {
    pairing: 'pair',
    challenge: 'challengeVote',
    twist: 'twistVote',
    recouple: 'recouple',
    elimination: 'eliminateVote',
  }[startingPhase];
  if (!phaseType) return { acted: 0 };

  const phaseActions = room.actions?.[startingPhase] || {};
  const bots = room.players.filter((p) => p.alive && p.isBot);
  for (const bot of bots) {
    if (phaseActions[bot.id]) continue;
    const target = pickVillaTarget(room, bot.id);
    if (!target) continue;
    const result = villaGame.submitAction(villaRooms, {
      roomId: room.id,
      playerId: bot.id,
      type: phaseType,
      targetId: target.id,
    });
    if (!result.ok) continue;
    acted += 1;
    if (room.status !== 'in_progress' || room.phase !== startingPhase) break;
  }

  // If room is bot-filled with a single human and they're idle, submit a deterministic
  // fallback action so the autoplay loop can complete without stalling on one missing vote.
  if (room.status === 'in_progress' && room.phase === startingPhase) {
    const aliveHumans = room.players.filter((p) => p.alive && !p.isBot);
    if (aliveHumans.length === 1) {
      const human = aliveHumans[0];
      const currentBucket = room.actions?.[startingPhase] || {};
      if (!currentBucket[human.id]) {
        const target = pickVillaTarget(room, human.id);
        if (target) {
          const fallback = villaGame.submitAction(villaRooms, {
            roomId: room.id,
            playerId: human.id,
            type: phaseType,
            targetId: target.id,
          });
          if (fallback.ok) acted += 1;
        }
      }
    }
  }

  if (acted > 0) {
    logRoomEvent('villa', room, 'BOTS_AUTOPLAYED', { acted, phase: room.phase, round: room.round, status: room.status });
  }
  return { acted };
}

function scheduleMafiaPhase(room) {
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    return;
  }

  const auto = runMafiaBotAutoplay(room);
  if (auto.acted > 0) emitMafiaRoom(room);
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'mafia', roomId: room.id, slot: 'phase' });
    return;
  }

  const token = `${room.phase}:${Date.now()}`;
  const ms = room.phase === 'night' ? 7000 : room.phase === 'discussion' ? 5000 : room.phase === 'voting' ? 7000 : 0;
  if (!ms) return;

  roomScheduler.schedule({ namespace: 'mafia', roomId: room.id, slot: 'phase', delayMs: ms, token }, () => {
    const advanced = mafiaGame.forceAdvance(mafiaRooms, { roomId: room.id });
    if (advanced.ok) {
      if (room.status === 'finished') recordFirstMatchCompletion('mafia', room.id);
      emitMafiaRoom(room);
      scheduleMafiaPhase(room);
    }
  });
}

function scheduleAmongUsPhase(room) {
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'amongus', roomId: room.id, slot: 'phase' });
    return;
  }

  const auto = runAmongUsBotAutoplay(room);
  if (auto.acted > 0) emitAmongUsRoom(room);
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'amongus', roomId: room.id, slot: 'phase' });
    return;
  }

  const token = `${room.phase}:${Date.now()}`;
  const ms = room.phase === 'tasks' ? 8000 : room.phase === 'meeting' ? 6000 : 0;
  if (!ms) return;

  roomScheduler.schedule({ namespace: 'amongus', roomId: room.id, slot: 'phase', delayMs: ms, token }, () => {
    const advanced = amongUsGame.forceAdvance(amongUsRooms, { roomId: room.id });
    if (advanced.ok) {
      if (room.status === 'finished') recordFirstMatchCompletion('amongus', room.id);
      emitAmongUsRoom(room);
      scheduleAmongUsPhase(room);
    }
  });
}

function scheduleVillaPhase(room) {
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'villa', roomId: room.id, slot: 'phase' });
    return;
  }

  const phaseBeforeAutoplay = room.phase;
  const auto = runVillaBotAutoplay(room);
  if (auto.acted > 0) emitVillaRoom(room);
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'villa', roomId: room.id, slot: 'phase' });
    return;
  }

  if (auto.acted > 0 && room.phase !== phaseBeforeAutoplay) {
    scheduleVillaPhase(room);
    return;
  }

  const token = `${room.phase}:${Date.now()}`;
  const ms = room.phase === 'pairing'
    ? 7000
    : room.phase === 'challenge'
      ? 7000
      : room.phase === 'twist'
        ? 6000
        : room.phase === 'recouple'
          ? 7000
          : room.phase === 'elimination'
            ? 7000
            : 0;
  if (!ms) return;

  roomScheduler.schedule({ namespace: 'villa', roomId: room.id, slot: 'phase', delayMs: ms, token }, () => {
    const advanced = villaGame.forceAdvance(villaRooms, { roomId: room.id });
    if (advanced.ok) {
      if (room.status === 'finished') recordFirstMatchCompletion('villa', room.id);
      emitVillaRoom(room);
      scheduleVillaPhase(room);
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

io.on('connection', (socket) => {
  socket.onAny((event, payload) => {
    if (!event.includes(':')) return;
    const roomId = String(payload?.roomId || '').toUpperCase() || null;
    logStructured('socket.event', {
      correlationId: socket.data.correlationId,
      socketId: socket.id,
      event,
      roomId,
    });
  });
  socket.on('mafia:room:create', ({ name }, cb) => {
    const created = mafiaGame.createRoom(mafiaRooms, { hostName: name, hostSocketId: socket.id });
    if (!created.ok) return cb?.(created);
    socket.join(`mafia:${created.room.id}`);
    logRoomEvent('mafia', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
    emitMafiaRoom(created.room);
    cb?.({ ok: true, roomId: created.room.id, playerId: created.player.id, state: mafiaGame.toPublic(created.room) });
  });

  socket.on('mafia:room:join', ({ roomId, name, claimToken }, cb) => {
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

  socket.on('mafia:autofill', ({ roomId, playerId, minPlayers }, cb) => {
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('mafia', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('mafia:start', ({ roomId, playerId }, cb) => {
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = mafiaGame.startGame(mafiaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('mafia', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, day: started.room.day });
    emitMafiaRoom(started.room);
    scheduleMafiaPhase(started.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(started.room) });
  });

  socket.on('mafia:start-ready', ({ roomId, playerId }, cb) => {
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = startReadyLobby('mafia', roomId, playerId);
    cb?.(started);
  });

  socket.on('mafia:rematch', ({ roomId, playerId }, cb) => {
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
    emitMafiaRoom(started.room);
    scheduleMafiaPhase(started.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(started.room) });
  });

  socket.on('mafia:action', ({ roomId, playerId, type, targetId }, cb) => {
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
    emitMafiaRoom(result.room);
    scheduleMafiaPhase(result.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('amongus:room:create', ({ name }, cb) => {
    const created = amongUsGame.createRoom(amongUsRooms, { hostName: name, hostSocketId: socket.id });
    if (!created.ok) return cb?.(created);
    socket.join(`amongus:${created.room.id}`);
    logRoomEvent('amongus', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
    emitAmongUsRoom(created.room);
    cb?.({ ok: true, roomId: created.room.id, playerId: created.player.id, state: amongUsGame.toPublic(created.room) });
  });

  socket.on('amongus:room:join', ({ roomId, name, claimToken }, cb) => {
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    if (normalizedRoomId && amongUsRooms.has(normalizedRoomId)) recordJoinAttempt('amongus', normalizedRoomId);
    const reconnect = resolveReconnectJoinName('amongus', roomId, name, claimToken);
    const joined = amongUsGame.joinRoom(amongUsRooms, { roomId, name: reconnect.name, socketId: socket.id });
    if (!joined.ok) {
      if (joined.error?.code === 'SOCKET_ALREADY_JOINED') {
        recordJoinHardeningEvent('amongus', normalizedRoomId, socket.id, reconnect.name);
      }
      return cb?.(joined);
    }
    if (reconnect.consumedClaimToken) consumeReconnectClaimTicket('amongus', joined.room.id, reconnect.consumedClaimToken);
    socket.join(`amongus:${joined.room.id}`);
    recordQuickJoinConversion('amongus', joined.room.id, joined.player.name);
    logRoomEvent('amongus', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, status: joined.room.status, phase: joined.room.phase });
    emitAmongUsRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: amongUsGame.toPublic(joined.room) });
  });

  socket.on('amongus:autofill', ({ roomId, playerId, minPlayers }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('amongus', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: amongUsGame.toPublic(result.room) });
  });

  socket.on('amongus:start', ({ roomId, playerId }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = amongUsGame.startGame(amongUsRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('amongus', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, round: started.room.round });
    emitAmongUsRoom(started.room);
    scheduleAmongUsPhase(started.room);
    cb?.({ ok: true, state: amongUsGame.toPublic(started.room) });
  });

  socket.on('amongus:start-ready', ({ roomId, playerId }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = startReadyLobby('amongus', roomId, playerId);
    cb?.(started);
  });

  socket.on('amongus:rematch', ({ roomId, playerId }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    roomScheduler.clearRoom(String(roomId || '').toUpperCase(), 'amongus');
    const reset = amongUsGame.prepareRematch(amongUsRooms, { roomId, hostPlayerId: playerId });
    if (!reset.ok) return cb?.(reset);
    const started = amongUsGame.startGame(amongUsRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    const telemetry = recordRematch('amongus', started.room.id);
    incrementGrowthMetric('funnel.rematchStarts', 1);
    recordTelemetryEvent('amongus', started.room.id, 'rematch_clicked');
    const partyStreak = Math.max(0, Number(started.room.partyStreak || 0));
    if (partyStreak > 0) {
      telemetry.partyStreakExtended = Math.max(0, Number(telemetry.partyStreakExtended || 0)) + 1;
      recordTelemetryEvent('amongus', started.room.id, 'party_streak_extended');
    }
    logRoomEvent('amongus', started.room, 'REMATCH_STARTED', { status: started.room.status, phase: started.room.phase });
    emitAmongUsRoom(started.room);
    scheduleAmongUsPhase(started.room);
    cb?.({ ok: true, state: amongUsGame.toPublic(started.room) });
  });

  socket.on('amongus:action', ({ roomId, playerId, type, targetId }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    const result = amongUsGame.submitAction(amongUsRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
    recordRoomWinner('amongus', result.room);
    if (result.room.status === 'finished') recordFirstMatchCompletion('amongus', result.room.id);
    logRoomEvent('amongus', result.room, 'ACTION_SUBMITTED', {
      actorId: playerId,
      action: type,
      targetId: targetId || null,
      status: result.room.status,
      phase: result.room.phase,
      round: result.room.round,
      winner: result.room.winner || null,
    });
    emitAmongUsRoom(result.room);
    scheduleAmongUsPhase(result.room);
    cb?.({ ok: true, state: amongUsGame.toPublic(result.room) });
  });

  socket.on('villa:room:create', ({ name }, cb) => {
    const created = villaGame.createRoom(villaRooms, { hostName: name, hostSocketId: socket.id });
    if (!created.ok) return cb?.(created);
    socket.join(`villa:${created.room.id}`);
    logRoomEvent('villa', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
    emitVillaRoom(created.room);
    cb?.({ ok: true, roomId: created.room.id, playerId: created.player.id, state: villaGame.toPublic(created.room) });
  });

  socket.on('villa:room:join', ({ roomId, name, claimToken }, cb) => {
    const normalizedRoomId = String(roomId || '').trim().toUpperCase();
    if (normalizedRoomId && villaRooms.has(normalizedRoomId)) recordJoinAttempt('villa', normalizedRoomId);
    const reconnect = resolveReconnectJoinName('villa', roomId, name, claimToken);
    const joined = villaGame.joinRoom(villaRooms, { roomId, name: reconnect.name, socketId: socket.id });
    if (!joined.ok) {
      if (joined.error?.code === 'SOCKET_ALREADY_JOINED') {
        recordJoinHardeningEvent('villa', normalizedRoomId, socket.id, reconnect.name);
      }
      return cb?.(joined);
    }
    if (reconnect.consumedClaimToken) consumeReconnectClaimTicket('villa', joined.room.id, reconnect.consumedClaimToken);
    socket.join(`villa:${joined.room.id}`);
    recordQuickJoinConversion('villa', joined.room.id, joined.player.name);
    logRoomEvent('villa', joined.room, 'PLAYER_JOINED', {
      playerId: joined.player.id,
      playerName: joined.player.name,
      status: joined.room.status,
      phase: joined.room.phase,
    });
    emitVillaRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: villaGame.toPublic(joined.room) });
  });

  socket.on('villa:autofill', ({ roomId, playerId, minPlayers }, cb) => {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('villa', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: villaGame.toPublic(result.room) });
  });

  socket.on('villa:start', ({ roomId, playerId }, cb) => {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = villaGame.startGame(villaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('villa', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, round: started.room.round });
    emitVillaRoom(started.room);
    scheduleVillaPhase(started.room);
    cb?.({ ok: true, state: villaGame.toPublic(started.room) });
  });

  socket.on('villa:start-ready', ({ roomId, playerId }, cb) => {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const started = startReadyLobby('villa', roomId, playerId);
    cb?.(started);
  });

  socket.on('villa:rematch', ({ roomId, playerId }, cb) => {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    roomScheduler.clearRoom(String(roomId || '').toUpperCase(), 'villa');
    const reset = villaGame.prepareRematch(villaRooms, { roomId, hostPlayerId: playerId });
    if (!reset.ok) return cb?.(reset);
    const started = villaGame.startGame(villaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    const telemetry = recordRematch('villa', started.room.id);
    incrementGrowthMetric('funnel.rematchStarts', 1);
    recordTelemetryEvent('villa', started.room.id, 'rematch_clicked');
    const partyStreak = Math.max(0, Number(started.room.partyStreak || 0));
    if (partyStreak > 0) {
      telemetry.partyStreakExtended = Math.max(0, Number(telemetry.partyStreakExtended || 0)) + 1;
      recordTelemetryEvent('villa', started.room.id, 'party_streak_extended');
    }
    logRoomEvent('villa', started.room, 'REMATCH_STARTED', { status: started.room.status, phase: started.room.phase, round: started.room.round });
    emitVillaRoom(started.room);
    scheduleVillaPhase(started.room);
    cb?.({ ok: true, state: villaGame.toPublic(started.room) });
  });

  socket.on('villa:action', ({ roomId, playerId, type, targetId }, cb) => {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });
    const result = villaGame.submitAction(villaRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
    recordRoomWinner('villa', result.room);
    if (result.room.status === 'finished') recordFirstMatchCompletion('villa', result.room.id);
    logRoomEvent('villa', result.room, 'ACTION_SUBMITTED', {
      actorId: playerId,
      action: type,
      targetId: targetId || null,
      status: result.room.status,
      phase: result.room.phase,
      round: result.room.round,
      winner: result.room.winner || null,
    });
    emitVillaRoom(result.room);
    scheduleVillaPhase(result.room);
    cb?.({ ok: true, state: villaGame.toPublic(result.room) });
  });

  socket.on('room:create', (payload, cb) => {
    const room = createRoom({ socketId: socket.id });
    socket.join(room.id);

    const result = ensurePlayer(room, socket, payload || {});
    if (result.error) return cb?.({ ok: false, error: result.error });

    logRoomEvent('arena', room, 'PLAYER_JOINED', { playerId: result.player.id, playerName: result.player.name, status: room.status, round: room.round });
    emitRoom(room);
    cb?.({ ok: true, roomId: room.id, playerId: result.player.id, themes: THEMES });
  });

  socket.on('room:join', ({ roomId, name, type, owner }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    socket.join(room.id);

    const result = ensurePlayer(room, socket, { name, type, owner });
    if (result.error) return cb?.({ ok: false, error: result.error });

    logRoomEvent('arena', room, 'PLAYER_JOINED', { playerId: result.player.id, playerName: result.player.name, status: room.status, round: room.round });
    emitRoom(room);
    cb?.({ ok: true, roomId: room.id, playerId: result.player.id, themes: THEMES });
  });

  socket.on('room:watch', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    socket.join(room.id);
    room.spectators.add(socket.id);
    logRoomEvent('arena', room, 'SPECTATOR_JOINED', { socketId: socket.id, status: room.status, round: room.round });
    emitRoom(room);
    cb?.({ ok: true, roomId: room.id });
  });

  socket.on('bot:add', ({ roomId, name, persona }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Only in lobby' });

    const bot = addBot(room, { name, persona });
    logRoomEvent('arena', room, 'BOT_ADDED', { playerId: bot.id, playerName: bot.name, status: room.status, round: room.round });
    emitRoom(room);
    cb?.({ ok: true, botId: bot.id });
  });

  socket.on('battle:start', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Battle already in progress' });

    roomScheduler.clearRoom(room.id, 'arena');
    room.round = 0;
    room.roastsByRound = {};
    room.votesByRound = {};
    room.lastWinner = null;
    room.themeRotation = [...THEMES].sort(() => Math.random() - 0.5).slice(0, room.maxRounds);
    const started = beginRound(room);
    if (started && started.ok === false) return cb?.({ ok: false, error: started.error.message, code: started.error.code });
    logRoomEvent('arena', room, 'BATTLE_STARTED', { status: room.status, round: room.round, theme: room.theme });
    cb?.({ ok: true });
  });

  socket.on('theme:random', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Can only change theme in lobby' });

    nextTheme(room);
    logRoomEvent('arena', room, 'THEME_CHANGED', { status: room.status, round: room.round, theme: room.theme });
    cb?.({ ok: true, theme: room.theme });
  });

  socket.on('roast:submit', ({ roomId, text }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.status !== 'round') return cb?.({ ok: false, error: 'Round not active' });

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return cb?.({ ok: false, error: 'Join as a player first' });

    const policyVariant = room.canaryBucket === 'canary' ? 'canary' : 'control';
    const moderated = moderateRoast(text, { maxLength: 280, variant: policyVariant });
    logRoomEvent('arena', room, 'ROAST_POLICY_CHECKED', {
      actorId: player.id,
      actorName: player.name,
      round: room.round,
      status: room.status,
      policyCode: moderated.code,
      policyOk: moderated.ok,
      policyVariant,
    });

    arenaCanary.recordDecision(policyVariant, moderated.ok);

    if (!moderated.ok) {
      logRoomEvent('arena', room, 'ROAST_REJECTED_POLICY', {
        actorId: player.id,
        actorName: player.name,
        round: room.round,
        status: room.status,
        policyCode: moderated.code,
        policyVariant,
      });
      logStructured('roast_policy_decision', {
        source: 'arena-room-submit',
        roomId: room.id,
        actorId: player.id,
        policyCode: moderated.code,
        policyVariant,
        allowed: false,
      });
      return cb?.({ ok: false, error: 'Roast blocked by safety policy', code: moderated.code });
    }

    room.roastsByRound[room.round][player.id] = moderated.text;
    logStructured('roast_policy_decision', {
      source: 'arena-room-submit',
      roomId: room.id,
      actorId: player.id,
      policyCode: moderated.code,
      policyVariant,
      allowed: true,
    });
    logRoomEvent('arena', room, 'ROAST_SUBMITTED', {
      actorId: player.id,
      actorName: player.name,
      round: room.round,
      status: room.status,
      policyCode: moderated.code,
      policyVariant,
    });
    maybeAdvanceToVoting(room);
    emitRoom(room);

    cb?.({ ok: true });
  });

  socket.on('vote:cast', ({ roomId, playerId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.status !== 'voting') return cb?.({ ok: false, error: 'Voting closed' });

    const voter = room.players.find((p) => p.socketId === socket.id);
    if (!voter) return cb?.({ ok: false, error: 'Join as a player first' });
    if (voter.type !== 'agent') return cb?.({ ok: false, error: 'Only agents can vote' });

    const voterKey = `voter:${socket.id}`;
    if (room.votesByRound[room.round][voterKey]) return cb?.({ ok: false, error: 'Already voted' });

    const target = room.players.find((p) => p.id === playerId);
    if (!target) return cb?.({ ok: false, error: 'Invalid vote target' });

    if (voter.id === playerId) return cb?.({ ok: false, error: 'Self vote blocked' });
    if (voter.owner && target.owner && voter.owner === target.owner) {
      return cb?.({ ok: false, error: 'Cannot vote for agents on your owner account' });
    }

    room.votesByRound[room.round][voterKey] = true;
    room.votesByRound[room.round][playerId] = (room.votesByRound[room.round][playerId] || 0) + 1;

    logRoomEvent('arena', room, 'VOTE_CAST', {
      actorId: voter.id,
      targetId: playerId,
      round: room.round,
      status: room.status,
    });
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on('battle:reset', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });

    const transition = transitionRoomState(room, 'BATTLE_RESET');
    if (!transition.ok) return cb?.({ ok: false, error: transition.error.message, code: transition.error.code });

    roomScheduler.clearRoom(room.id, 'arena');
    room.round = 0;
    room.roastsByRound = {};
    room.votesByRound = {};
    room.totalVotes = {};
    room.lastWinner = null;
    room.roundEndsAt = null;
    room.voteEndsAt = null;
    room.themeRotation = [...THEMES].sort(() => Math.random() - 0.5).slice(0, room.maxRounds);
    room.theme = room.themeRotation[0] || THEMES[0];
    room.players.forEach((p) => { room.totalVotes[p.id] = 0; });

    logRoomEvent('arena', room, 'BATTLE_RESET', { status: room.status, round: room.round });
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      let changed = false;
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player && player.isConnected) {
        player.isConnected = false;
        changed = true;
      }
      if (room.spectators.delete(socket.id)) changed = true;

      if (room.hostSocketId === socket.id && room.players.length > 0) {
        const replacement = room.players.find((p) => p.isConnected && !p.isBot);
        if (replacement && replacement.socketId && replacement.socketId !== room.hostSocketId) {
          room.hostSocketId = replacement.socketId;
          changed = true;
        }
      }

      if (changed) emitRoom(room);
    }

    for (const room of mafiaRooms.values()) {
      const changed = mafiaGame.disconnectPlayer(mafiaRooms, { roomId: room.id, socketId: socket.id });
      if (changed) emitMafiaRoom(room);
    }

    for (const room of amongUsRooms.values()) {
      const changed = amongUsGame.disconnectPlayer(amongUsRooms, { roomId: room.id, socketId: socket.id });
      if (changed) emitAmongUsRoom(room);
    }

    for (const room of villaRooms.values()) {
      const changed = villaGame.disconnectPlayer(villaRooms, { roomId: room.id, socketId: socket.id });
      if (changed) emitVillaRoom(room);
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
  if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
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
const apiLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const opsLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/openclaw/', authLimiter);
app.use('/api/ops/', opsLimiter);
app.use('/api/evals/', opsLimiter);

// ── Ops Auth Gate ──
function opsAuthGate(req, res, next) {
  const token = process.env.OPS_ADMIN_TOKEN;
  if (!token) return next(); // no token configured = open (dev mode)
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
app.use('/api/ops/', opsAuthGate);
app.use('/api/evals/', opsAuthGate);

app.use((req, _res, next) => {
  if (req.method === 'GET' && ['/', '/index.html', '/play.html', '/browse.html', '/for-agents.html'].includes(req.path)) {
    incrementGrowthMetric('funnel.visits', 1);
  }
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const ROOM_EVENTS_FILE = path.join(DATA_DIR, 'room-events.ndjson');
const GROWTH_METRICS_FILE = path.join(__dirname, 'growth-metrics.json');

const agentProfiles = new Map();
const roastFeed = [];
const votes = new Set();
// pair vote caps removed: agent voting is unlimited except self/owner restrictions
const sessions = new Map();
const connectSessions = new Map();
const completedMatchRooms = new Set();
let growthMetrics = null;

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

function recordFirstMatchCompletion(mode, roomId) {
  const key = telemetryKey(mode, roomId);
  if (completedMatchRooms.has(key)) return;
  completedMatchRooms.add(key);
  incrementGrowthMetric('funnel.firstMatchesCompleted', 1);

  // Persist match result to SQLite
  try {
    const store = getLobbyStore(mode);
    const room = store?.get(roomId);
    if (room) {
      recordMatch({
        id: shortId(12),
        roomId,
        mode,
        winner: room.winner || room.lastWinner?.name || null,
        rounds: room.round || 0,
        durationMs: room.startedAt ? Date.now() - room.startedAt : null,
        startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
        players: (room.players || []).map((p, i) => ({
          userId: p.userId || null,
          name: p.name,
          role: p.role || null,
          isBot: !!p.isBot,
          survived: p.alive !== false,
          placement: i + 1,
        })),
      });
    }
  } catch (err) {
    console.error('recordMatch failed:', err.message);
  }
}

function sanitizeConnectSession(connect, { includeSecrets = false } = {}) {
  if (!connect) return null;
  const base = {
    id: connect.id,
    email: connect.email,
    status: connect.status,
    command: connect.command,
    callbackUrl: connect.callbackUrl,
    createdAt: connect.createdAt,
    expiresAt: connect.expiresAt,
    agentId: connect.agentId,
    agentName: connect.agentName,
    connectedAt: connect.connectedAt,
  };
  if (includeSecrets) {
    base.accessToken = connect.accessToken;
  }
  return base;
}

function readConnectAccessToken(req) {
  return String(
    req.query?.accessToken
      || req.headers['x-connect-access-token']
      || req.body?.accessToken
      || req.body?.proof
      || ''
  ).trim();
}

function authorizeConnectSession(req, connect) {
  if (!connect) return false;
  const token = readConnectAccessToken(req);
  if (!token) return false;
  return token === connect.accessToken || token === connect.callbackProof;
}

function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const serializable = {
      agents: [...agentProfiles.values()],
      roastFeed,
      votes: [...votes],
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializable, null, 2));
  } catch (err) {
    console.error('persistState failed', err.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (parsed.agents || []).forEach((a) => agentProfiles.set(a.id, a));
    (parsed.roastFeed || []).forEach((r) => roastFeed.push(r));
    (parsed.votes || []).forEach((v) => votes.add(v));
  } catch (err) {
    console.error('loadState failed', err.message);
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

function registerRoast({ battleId, agentId, agentName, text }) {
  const policyVariant = arenaCanary.assignRoom(battleId);
  const moderated = moderateRoast(text, { maxLength: 280, variant: policyVariant });
  const safeText = moderated.ok
    ? moderated.text
    : `[${String(agentName || 'Bot').slice(0, 24)} • light] Your pitch deck has side effects.`;

  arenaCanary.recordDecision(policyVariant, moderated.ok);

  logStructured('roast_policy_decision', {
    source: 'arena-auto-battle',
    battleId,
    actorId: agentId,
    policyCode: moderated.code,
    policyVariant,
    allowed: moderated.ok,
  });

  const roast = {
    id: shortId(10),
    battleId,
    agentId,
    agentName,
    text: safeText,
    upvotes: 0,
    createdAt: Date.now(),
    policyCode: moderated.code,
    policyVariant,
  };
  roastFeed.unshift(roast);
  if (roastFeed.length > 400) roastFeed.length = 400;
  persistState();
  return roast;
}

function ensureSeedAgents() {
  if (agentProfiles.size >= 3) return;
  ['savage_ops', 'deadpan_rx', 'roastor_prime'].forEach((name, i) => {
    const id = shortId(10);
    agentProfiles.set(id, {
      id,
      owner: 'system',
      name,
      deployed: true,
      mmr: 1000 + i * 8,
      karma: 0,
      persona: { style: i % 2 ? 'deadpan' : 'witty', intensity: 6 + i },
      openclaw: { connected: true, mode: 'seed' },
      createdAt: Date.now(),
    });
  });
  persistState();
}

function runAutoBattle() {
  ensureSeedAgents();
  const deployed = [...agentProfiles.values()].filter((a) => a.deployed);
  if (deployed.length < 2) return null;

  const shuffled = deployed.sort(() => Math.random() - 0.5).slice(0, Math.min(4, deployed.length));
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const battleId = shortId(8);

  for (const agent of shuffled) {
    const intensity = Number(agent.persona?.intensity || 6);
    const roastText = generateBotRoast(theme, agent.name, intensity, agent.persona?.style || 'witty');
    registerRoast({ battleId, agentId: agent.id, agentName: agent.name, text: roastText });
  }

  return { battleId, theme, participants: shuffled.map((a) => ({ id: a.id, name: a.name })) };
}

app.post('/api/auth/session', (req, res) => {
  const { createAnonymousUser, createSession, getSessionByToken } = require('./server/db');

  // Check for existing session token
  const existingToken = req.headers.authorization?.replace('Bearer ', '') || req.body?.token;
  if (existingToken) {
    const existing = getSessionByToken(existingToken);
    if (existing) {
      return res.json({ ok: true, session: { token: existingToken, userId: existing.user_id }, renewed: true });
    }
  }

  // Create anonymous user + session
  const userId = shortId(12);
  const token = shortId(24);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  try {
    createAnonymousUser(userId);
    createSession(shortId(8), userId, token, expiresAt);

    // Also keep in-memory sessions for backward compat
    const session = { token, userId, email: null, createdAt: Date.now() };
    sessions.set(token, session);

    res.json({ ok: true, session: { token, userId } });
  } catch (err) {
    // Fallback to in-memory only if DB isn't initialized
    const token2 = shortId(20);
    const session = { token: token2, userId, createdAt: Date.now() };
    sessions.set(token2, session);
    res.json({ ok: true, session: { token: token2, userId } });
  }
});

app.post('/api/openclaw/connect-session', (req, res) => {
  incrementGrowthMetric('funnel.connectSessionStarts', 1);
  const email = String(req.body?.email || '').trim().toLowerCase() || 'anonymous';

  const id = shortId(18);
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/openclaw/callback`;
  const callbackProof = shortId(24);
  const accessToken = shortId(24);
  const connect = {
    id,
    email,
    status: 'pending_confirmation',
    command: `openclaw agentarena connect --token ${id} --callback '${callbackUrl}' --proof ${callbackProof}`,
    callbackUrl,
    callbackProof,
    accessToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60_000,
    agentId: null,
    agentName: null,
  };
  connectSessions.set(id, connect);
  roomEvents.append('growth', id, 'CONNECT_SESSION_STARTED', {
    status: connect.status,
    emailDomain: email.split('@')[1] || null,
  });
  res.json({ ok: true, connect: sanitizeConnectSession(connect, { includeSecrets: true }) });
});

app.post('/api/openclaw/callback', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const proof = String(req.body?.proof || '').trim();
  const connect = connectSessions.get(token);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
  if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
  if (!proof || proof !== connect.callbackProof) return res.status(401).json({ ok: false, error: 'invalid callback proof' });

  if (connect.status === 'connected') return res.json({ ok: true, connect: sanitizeConnectSession(connect) });

  const name = String(req.body?.agentName || `agent-${shortId(4)}`).trim().slice(0, 24);
  const style = String(req.body?.style || 'witty').slice(0, 24);
  const agentId = shortId(10);
  const agent = {
    id: agentId,
    owner: connect.email,
    name,
    deployed: true,
    mmr: 1000,
    karma: 0,
    persona: { style, intensity: 7 },
    openclaw: {
      connected: true,
      mode: 'cli',
      connectSessionId: connect.id,
      connectedAt: Date.now(),
      note: 'connected through OpenClaw CLI callback',
    },
    createdAt: Date.now(),
  };

  agentProfiles.set(agentId, agent);
  connect.status = 'connected';
  connect.agentId = agentId;
  connect.agentName = name;
  connect.connectedAt = Date.now();
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_CONNECTED', {
    status: connect.status,
    agentId,
    agentName: name,
    emailDomain: String(connect.email || '').split('@')[1] || null,
  });
  persistState();

  res.json({ ok: true, connect: sanitizeConnectSession(connect), agent });
});

app.get('/api/openclaw/connect-session/:id', (req, res) => {
  const connect = connectSessions.get(req.params.id);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
  if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
  if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });
  res.json({ ok: true, connect: sanitizeConnectSession(connect) });
});

app.post('/api/openclaw/connect-session/:id/confirm', (req, res) => {
  const connect = connectSessions.get(req.params.id);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
  if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
  if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });

  if (connect.status === 'connected') return res.json({ ok: true, connect: sanitizeConnectSession(connect) });

  const name = String(req.body?.agentName || `agent-${shortId(4)}`).trim().slice(0, 24);
  const style = String(req.body?.style || 'witty').slice(0, 24);
  const agentId = shortId(10);
  const agent = {
    id: agentId,
    owner: connect.email,
    name,
    deployed: true,
    mmr: 1000,
    karma: 0,
    persona: { style, intensity: 7 },
    openclaw: {
      connected: true,
      mode: 'cli',
      connectSessionId: connect.id,
      connectedAt: Date.now(),
      note: 'connected through OpenClaw CLI confirmation flow',
    },
    createdAt: Date.now(),
  };

  agentProfiles.set(agentId, agent);
  connect.status = 'connected';
  connect.agentId = agentId;
  connect.connectedAt = Date.now();
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_CONNECTED', {
    status: connect.status,
    agentId,
    agentName: name,
    emailDomain: String(connect.email || '').split('@')[1] || null,
  });
  persistState();

  res.json({ ok: true, connect: sanitizeConnectSession(connect), agent });
});

app.post('/api/agents', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const owner = String(req.body?.owner || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  if (!owner || !owner.includes('@')) return res.status(400).json({ ok: false, error: 'owner email required' });

  const id = shortId(10);
  const profile = {
    id,
    owner: owner.slice(0, 64),
    name: name.slice(0, 24),
    deployed: false,
    mmr: 1000,
    karma: 0,
    persona: {
      style: String(req.body?.persona?.style || 'witty').slice(0, 24),
      intensity: Math.max(1, Math.min(10, Number(req.body?.persona?.intensity || 6))),
    },
    openclaw: { connected: false, mode: 'manual' },
    createdAt: Date.now(),
  };
  agentProfiles.set(id, profile);
  persistState();
  res.json({ ok: true, agent: profile });
});

app.post('/api/openclaw/connect', (req, res) => {
  const agent = agentProfiles.get(String(req.body?.agentId || ''));
  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found' });

  const soulPath = String(req.body?.soulPath || '').trim();
  const directoryPath = String(req.body?.directoryPath || '').trim();
  agent.openclaw = {
    connected: true,
    mode: req.body?.mode === 'directory' ? 'directory' : 'soul',
    soulPath,
    directoryPath,
    connectedAt: Date.now(),
    note: 'stub connection until native OpenClaw handshake lands',
  };
  persistState();
  res.json({ ok: true, agent });
});

app.post('/api/agents/:id/deploy', (req, res) => {
  const agent = agentProfiles.get(req.params.id);
  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found' });
  agent.deployed = true;
  persistState();
  res.json({ ok: true, agent });
});

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

  const nextStyle = String(profile.tone || profile.style || agent.persona?.style || 'witty').slice(0, 24);
  const nextIntensity = Math.max(1, Math.min(10, Number(profile.intensity || agent.persona?.intensity || 7)));

  agent.persona = {
    ...agent.persona,
    style: nextStyle,
    intensity: nextIntensity,
  };
  agent.arenaProfile = {
    ...profile,
    syncedAt: Date.now(),
  };

  persistState();
  res.json({ ok: true, agent });
});

app.post('/api/matchmaking/tick', (_req, res) => {
  const result = runAutoBattle();
  res.json({ ok: true, battle: result });
});

app.get('/api/feed', (req, res) => {
  const sort = req.query.sort === 'new' ? 'new' : 'top';
  const items = [...roastFeed];
  if (sort === 'top') items.sort((a, b) => b.upvotes - a.upvotes || b.createdAt - a.createdAt);
  else items.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ok: true, items: items.slice(0, 100) });
});

app.post('/api/roasts/:id/upvote', (req, res) => {
  const roast = roastFeed.find((r) => r.id === req.params.id);
  if (!roast) return res.status(404).json({ ok: false, error: 'roast not found' });

  const voterAgentId = req.body?.voterAgentId ? String(req.body.voterAgentId) : null;
  if (!voterAgentId) return res.status(400).json({ ok: false, error: 'only agents can vote' });

  const voterAgent = agentProfiles.get(voterAgentId);
  if (!voterAgent) return res.status(404).json({ ok: false, error: 'voter agent not found' });

  const targetAgent = agentProfiles.get(roast.agentId);
  if (!targetAgent) return res.status(404).json({ ok: false, error: 'target agent not found' });

  if (voterAgentId === roast.agentId) {
    return res.status(400).json({ ok: false, error: 'self vote blocked' });
  }

  if (voterAgent.owner && targetAgent.owner && voterAgent.owner === targetAgent.owner) {
    return res.status(400).json({ ok: false, error: 'cannot vote for agents on your owner account' });
  }

  const voterKey = `a:${voterAgentId}`;
  const key = `${voterKey}:${roast.id}`;
  if (votes.has(key)) return res.status(409).json({ ok: false, error: 'already voted' });

  // unlimited voting volume is allowed for agents; only self/owner restrictions apply

  votes.add(key);

  roast.upvotes += 1;
  const ownerAgent = agentProfiles.get(roast.agentId);
  if (ownerAgent) ownerAgent.karma += 1;
  persistState();

  res.json({ ok: true, roast });
});

app.get('/api/leaderboard', (_req, res) => {
  const agents = [...agentProfiles.values()];
  const topAgents = [...agents]
    .sort((a, b) => b.mmr - a.mmr || b.karma - a.karma)
    .slice(0, 25)
    .map(({ id, name, mmr, karma, deployed, openclaw }) => ({ id, name, mmr, karma, deployed, openclawConnected: !!openclaw?.connected }));

  const topRoasts = [...roastFeed]
    .sort((a, b) => b.upvotes - a.upvotes || b.createdAt - a.createdAt)
    .slice(0, 25);

  res.json({ ok: true, topAgents, topRoasts });
});

function buildRoomLaunchReadiness(room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const hostPlayerId = room?.hostPlayerId || null;
  const host = players.find((p) => p.id === hostPlayerId) || players[0] || null;
  const connectedHumans = players.filter((p) => !p.isBot && p.isConnected).length;
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);
  const missingPlayers = Math.max(0, QUICK_JOIN_MIN_PLAYERS - players.length);
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
  const fillRate = Math.min(1, (roomSummary.players || 0) / 4);
  const nearStartBonus = roomSummary.players >= 3 ? 0.2 : 0;
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
  const canJoin = status === 'lobby' && players.length < 4;
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

  const mafia = modeFilter === 'all' || modeFilter === 'mafia'
    ? [...mafiaRooms.values()].map((room) => summarizePlayableRoom('mafia', room))
    : [];
  const amongus = modeFilter === 'all' || modeFilter === 'amongus'
    ? [...amongUsRooms.values()].map((room) => summarizePlayableRoom('amongus', room))
    : [];
  const villa = modeFilter === 'all' || modeFilter === 'villa'
    ? [...villaRooms.values()].map((room) => summarizePlayableRoom('villa', room))
    : [];

  let roomsList = [...mafia, ...amongus, ...villa];

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
  return mode === 'amongus' ? amongUsRooms : mode === 'mafia' ? mafiaRooms : mode === 'villa' ? villaRooms : null;
}

function getClaimableLobbySeats(mode, roomId) {
  const store = getLobbyStore(mode);
  if (!store) {
    return { ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia|amongus|villa' } };
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
  if (mode === 'mafia' || mode === 'amongus' || mode === 'villa') return mode;
  const openMafia = listPlayableRooms('mafia', 'open').length;
  const openAmongUs = listPlayableRooms('amongus', 'open').length;
  const openVilla = listPlayableRooms('villa', 'open').length;
  return [
    { mode: 'mafia', open: openMafia },
    { mode: 'amongus', open: openAmongUs },
    { mode: 'villa', open: openVilla },
  ].sort((a, b) => a.open - b.open || String(a.mode).localeCompare(String(b.mode)))[0].mode;
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

function createQuickJoinRoom(mode, hostName) {
  const socketId = null;
  if (mode === 'amongus') {
    return amongUsGame.createRoom(amongUsRooms, { hostName, hostSocketId: socketId });
  }
  if (mode === 'villa') {
    return villaGame.createRoom(villaRooms, { hostName, hostSocketId: socketId });
  }
  return mafiaGame.createRoom(mafiaRooms, { hostName, hostSocketId: socketId });
}

function autoFillLobbyBots(mode, roomId, minPlayers = QUICK_JOIN_MIN_PLAYERS) {
  const safeMinPlayers = Math.max(1, Math.min(8, Number(minPlayers) || QUICK_JOIN_MIN_PLAYERS));

  if (mode === 'amongus') {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
    if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only auto-fill lobby rooms' } };
    const needed = Math.max(0, safeMinPlayers - room.players.length);
    const added = amongUsGame.addLobbyBots(amongUsRooms, { roomId: room.id, count: needed, namePrefix: 'Crew Bot' });
    if (!added.ok) return added;
    logRoomEvent('amongus', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length, targetPlayers: safeMinPlayers, players: room.players.length });
    emitAmongUsRoom(room);
    return { ok: true, mode, room, addedBots: added.bots.length, targetPlayers: safeMinPlayers };
  }

  if (mode === 'villa') {
    const room = villaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
    if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only auto-fill lobby rooms' } };
    const needed = Math.max(0, safeMinPlayers - room.players.length);
    const added = villaGame.addLobbyBots(villaRooms, { roomId: room.id, count: needed, namePrefix: 'Villa Bot' });
    if (!added.ok) return added;
    logRoomEvent('villa', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length, targetPlayers: safeMinPlayers, players: room.players.length });
    emitVillaRoom(room);
    return { ok: true, mode, room, addedBots: added.bots.length, targetPlayers: safeMinPlayers };
  }

  const room = mafiaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only auto-fill lobby rooms' } };
  const needed = Math.max(0, safeMinPlayers - room.players.length);
  const added = mafiaGame.addLobbyBots(mafiaRooms, { roomId: room.id, count: needed, namePrefix: 'Mafia Bot' });
  if (!added.ok) return added;
  logRoomEvent('mafia', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length, targetPlayers: safeMinPlayers, players: room.players.length });
  emitMafiaRoom(room);
  return { ok: true, mode: 'mafia', room, addedBots: added.bots.length, targetPlayers: safeMinPlayers };
}

function stripDisconnectedLobbyHumans(mode, roomId) {
  const store = getLobbyStore(mode);
  if (!store) return { ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia|amongus|villa' } };
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
  const missingPlayers = Math.max(0, QUICK_JOIN_MIN_PLAYERS - players.length);
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
  const store = mode === 'amongus' ? amongUsRooms : mode === 'villa' ? villaRooms : mafiaRooms;
  const game = mode === 'amongus' ? amongUsGame : mode === 'villa' ? villaGame : mafiaGame;
  const emitRoom = mode === 'amongus' ? emitAmongUsRoom : mode === 'villa' ? emitVillaRoom : emitMafiaRoom;
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
  emitRoom(started.room);
  if (mode === 'amongus') scheduleAmongUsPhase(started.room);
  else if (mode === 'villa') scheduleVillaPhase(started.room);
  else scheduleMafiaPhase(started.room);

  return {
    ok: true,
    addedBots: autoFilled.addedBots,
    removedDisconnectedHumans: stripped.removedHumans,
    readiness: getLobbyStartReadiness(mode, started.room, playerId),
    state: game.toPublic(started.room),
  };
}

app.get('/api/play/rooms', (req, res) => {
  const modeFilter = String(req.query.mode || 'all').toLowerCase();
  const statusFilter = String(req.query.status || 'all').toLowerCase();

  if (!['all', 'mafia', 'amongus', 'villa'].includes(modeFilter)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode filter' });
  }

  const roomsList = listPlayableRooms(modeFilter, statusFilter);
  const aggregate = roomsList.reduce((totals, room) => {
    totals.playersOnline += Number(room.players || 0);
    if (room.canJoin) totals.openRooms += 1;
    if (room.mode === 'mafia') totals.byMode.mafia += 1;
    if (room.mode === 'amongus') totals.byMode.amongus += 1;
    if (room.mode === 'villa') totals.byMode.villa += 1;

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
    byMode: { mafia: 0, amongus: 0, villa: 0 },
    reconnectAuto: { attempts: 0, successes: 0, failures: 0 },
    reconnectRecoveryClicks: { reclaim_clicked: 0, quick_recover_clicked: 0 },
    telemetryEvents: { rematch_clicked: 0, party_streak_extended: 0 },
    fairness: { joinAttempts: 0, socketSeatCapBlocked: 0 },
  });

  const summary = {
    totalRooms: roomsList.length,
    openRooms: aggregate.openRooms,
    playersOnline: aggregate.playersOnline,
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

  if (!['mafia', 'amongus', 'villa'].includes(mode)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia|amongus|villa' } });
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

  if (!['all', 'mafia', 'amongus', 'villa'].includes(modeInput)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode' });
  }

  const selectedMode = pickQuickJoinMode(modeInput);
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
  const targetStore = targetRoom.mode === 'mafia'
    ? mafiaRooms
    : targetRoom.mode === 'amongus'
      ? amongUsRooms
      : villaRooms;
  res.json({ ok: true, created, room: summarizePlayableRoom(targetRoom.mode, targetStore.get(targetRoom.roomId)), quickJoinDecision, joinTicket });
});

app.post('/api/play/lobby/autofill', (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const roomId = String(req.body?.roomId || '').trim().toUpperCase();
  const minPlayers = Number(req.body?.minPlayers || QUICK_JOIN_MIN_PLAYERS);

  if (!['mafia', 'amongus', 'villa'].includes(mode)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia|amongus|villa' } });
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
    state: mode === 'mafia'
      ? mafiaGame.toPublic(result.room)
      : mode === 'amongus'
        ? amongUsGame.toPublic(result.room)
        : villaGame.toPublic(result.room),
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
  const mode = ['mafia', 'amongus', 'villa'].includes(modeInput) ? modeInput : 'mafia';
  const playerName = String(req.body?.name || `Player_${shortId(4)}`).trim().slice(0, 24);

  // Create a new room
  const created = createQuickJoinRoom(mode, playerName);
  if (!created.ok) return res.status(500).json(created);

  const room = created.room;

  // Auto-fill with bots
  const filled = autoFillLobbyBots(mode, room.id, 4);

  trackEvent('instant_play_created', playerName, { mode, roomId: room.id });

  res.json({
    ok: true,
    mode,
    roomId: room.id,
    playUrl: `/play.html?mode=${mode}&room=${room.id}&name=${encodeURIComponent(playerName)}&autojoin=1&instant=1`,
    players: room.players.length,
  });
});

// ── Watch: spectate the most active game ──
app.get('/api/play/watch', (_req, res) => {
  const allRooms = listPlayableRooms('all', 'all');
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
      watchUrl: `/play.html?mode=${best.mode}&room=${best.roomId}&spectate=1`,
      players: best.players,
    });
  }

  // No active games -- create one with all bots for spectating
  const mode = 'mafia';
  const created = createQuickJoinRoom(mode, 'Spectator');
  if (!created.ok) return res.json({ ok: true, found: false, message: 'No active games. Try Play Now!' });

  autoFillLobbyBots(mode, created.room.id, 4);

  res.json({
    ok: true,
    found: true,
    roomId: created.room.id,
    mode,
    watchUrl: `/play.html?mode=${mode}&room=${created.room.id}&spectate=1`,
    players: created.room.players.length,
    autoCreated: true,
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

app.get('/match/:matchId', (req, res) => {
  const { getMatch } = require('./server/db');
  try {
    const match = getMatch(req.params.matchId);
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
  <meta property="og:title" content="Agent Arena - ${safeMode} Match" />
  <meta property="og:description" content="Winner: ${safeWinner} | ${safeRounds} rounds | Players: ${safePlayerList}" />
  <meta property="og:image" content="/og-image.svg" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/styles.css" />
  <title>Match Result - Agent Arena</title>
</head>
<body class="page-home">
<div class="wrap">
  <nav class="topnav">
    <a class="brand" href="/">Agent Arena</a>
    <div class="nav-links">
      <a href="/play.html">Play</a>
      <a href="/browse.html">Feed</a>
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
          <a class="btn btn-primary" href="/play.html">Play Now</a>
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

app.use(express.static(path.join(__dirname, 'public')));

registerRoomEventRoutes(app, { roomEvents });

app.get('/api/ops/events', (_req, res) => {
  res.json({ ok: true, pending: roomEvents.pending(), pendingByMode: roomEvents.pendingByMode() });
});

app.post('/api/ops/events/flush', async (_req, res) => {
  await roomEvents.flush();
  res.json({ ok: true, pending: roomEvents.pending(), pendingByMode: roomEvents.pendingByMode() });
});

app.get('/api/ops/canary', (_req, res) => {
  res.json({ ok: true, config: arenaCanary.config(), stats: arenaCanary.stats() });
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
    amongus: {
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
    villa: {
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
    const mode = telemetry.mode === 'amongus' ? 'amongus' : telemetry.mode === 'villa' ? 'villa' : 'mafia';
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
      amongus: { ...byMode.amongus, successRate: toRate(byMode.amongus), socketSeatCapBlockRate: toBlockRate(byMode.amongus) },
      villa: { ...byMode.villa, successRate: toRate(byMode.villa), socketSeatCapBlockRate: toBlockRate(byMode.villa) },
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

app.get('/api/evals/run', (_req, res) => {
  const report = runEval();
  res.json(report);
});

app.get('/api/evals/ci', (_req, res) => {
  const report = runEval();
  const thresholds = parseThresholdsFromEnv();
  const gate = evaluateEvalReport(report, thresholds);
  res.json({
    ok: gate.ok,
    thresholds: gate.thresholds,
    checks: gate.checks,
    totals: report.totals,
    failedFixtures: report.failures.map((f) => f.id),
  });
});

app.post('/api/ops/kpis/snapshot', (_req, res) => {
  const metrics = persistGrowthMetricsSnapshot();
  growthMetrics = metrics;
  res.json({ ok: true, metrics });
});

app.get('/api/ops/funnel', (_req, res) => {
  res.json({ ok: true, metrics: growthMetrics });
});

app.get('/health', (_req, res) => {
  const scheduler = roomScheduler.stats();
  const eventQueueDepth = roomEvents.pending();
  const eventQueueByMode = roomEvents.pendingByMode();
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    rooms: {
      arena: rooms.size,
      mafia: mafiaRooms.size,
      amongus: amongUsRooms.size,
      villa: villaRooms.size,
    },
    agents: agentProfiles.size,
    roasts: roastFeed.length,
    schedulerTimers: scheduler,
    eventQueueDepth,
    eventQueueByMode,
    canary: {
      ...arenaCanary.config(),
      stats: arenaCanary.stats(),
    },
  });
});

// ── Sentry error handler (must be after all routes) ──
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'internal server error' });
});

if (require.main === module) {
  // Initialize SQLite database
  try {
    initDb();
    console.log('SQLite database initialized');
  } catch (err) {
    console.error('SQLite init failed:', err.message);
  }

  loadState();

  if (process.env.DISABLE_AUTOBATTLE !== '1') {
    runAutoBattle();
    setInterval(() => {
      runAutoBattle();
    }, 20_000);
  }

  server.listen(PORT, () => {
    console.log(`Agent Arena running on http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => {
    closeDb();
    process.exit(0);
  });
}

module.exports = {
  app,
  server,
  io,
  THEMES,
  ROUND_MS,
  VOTE_MS,
  createRoom,
  getPublicRoom,
  transitionRoomState,
  beginRound,
  beginVoting,
  finalizeRound,
  nextTheme,
  addBot,
  generateBotRoast,
  rooms,
  mafiaRooms,
  amongUsRooms,
  villaRooms,
  roomEvents,
  arenaCanary,
  clearAllGameTimers,
  resetPlayTelemetry,
  seedPlayTelemetry,
};
