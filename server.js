const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const mafiaGame = require('./games/agent-mafia');
const amongUsGame = require('./games/agents-among-us');
const { createRoomScheduler } = require('./lib/room-scheduler');
const { createRoomEventLog } = require('./lib/room-events');
const { runBotTurn } = require('./bots/turn-loop');
const { moderateRoast } = require('./bots/roast-policy');
const { rememberBotRound, summarizeBotMemory } = require('./bots/episodic-memory');
const { runEval } = require('./lib/eval-harness');
const { parseThresholdsFromEnv, evaluateEvalReport } = require('./lib/eval-thresholds');
const { createCanaryMode } = require('./lib/canary-mode');

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

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len);
}

function correlationId(seed) {
  const raw = String(seed || '').trim();
  if (!raw) return shortId(12);
  return raw.slice(0, 64);
}

function logStructured(event, fields = {}) {
  const payload = {
    at: new Date().toISOString(),
    event,
    ...fields,
  };
  console.log(JSON.stringify(payload));
}

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
const roomScheduler = createRoomScheduler();
const roomEvents = createRoomEventLog({ dataDir: path.join(__dirname, 'data') });
const arenaCanary = createCanaryMode({
  enabled: process.env.ARENA_CANARY_ENABLED !== '0',
  percent: Number(process.env.ARENA_CANARY_PERCENT || 0),
});

function clearAllGameTimers() {
  roomScheduler.clearAll();
}

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

function logRoomEvent(mode, room, type, payload = {}) {
  if (!room?.id) return;
  roomEvents.append(mode, room.id, type, payload);
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

function pickDeterministicTarget(players, actorId) {
  return players
    .filter((p) => p.alive && p.id !== actorId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
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
      emitAmongUsRoom(room);
      scheduleAmongUsPhase(room);
    }
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

  socket.on('mafia:room:join', ({ roomId, name }, cb) => {
    const joined = mafiaGame.joinRoom(mafiaRooms, { roomId, name, socketId: socket.id });
    if (!joined.ok) return cb?.(joined);
    socket.join(`mafia:${joined.room.id}`);
    logRoomEvent('mafia', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, status: joined.room.status, phase: joined.room.phase });
    emitMafiaRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: mafiaGame.toPublic(joined.room) });
  });

  socket.on('mafia:autofill', ({ roomId, playerId, minPlayers }, cb) => {
    const room = mafiaRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (room.hostPlayerId !== playerId) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('mafia', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: mafiaGame.toPublic(result.room) });
  });

  socket.on('mafia:start', ({ roomId, playerId }, cb) => {
    const started = mafiaGame.startGame(mafiaRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('mafia', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, day: started.room.day });
    emitMafiaRoom(started.room);
    scheduleMafiaPhase(started.room);
    cb?.({ ok: true, state: mafiaGame.toPublic(started.room) });
  });

  socket.on('mafia:action', ({ roomId, playerId, type, targetId }, cb) => {
    const result = mafiaGame.submitAction(mafiaRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
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

  socket.on('amongus:room:join', ({ roomId, name }, cb) => {
    const joined = amongUsGame.joinRoom(amongUsRooms, { roomId, name, socketId: socket.id });
    if (!joined.ok) return cb?.(joined);
    socket.join(`amongus:${joined.room.id}`);
    logRoomEvent('amongus', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, status: joined.room.status, phase: joined.room.phase });
    emitAmongUsRoom(joined.room);
    cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: amongUsGame.toPublic(joined.room) });
  });

  socket.on('amongus:autofill', ({ roomId, playerId, minPlayers }, cb) => {
    const room = amongUsRooms.get(String(roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    if (room.hostPlayerId !== playerId) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
    const result = autoFillLobbyBots('amongus', room.id, minPlayers);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, addedBots: result.addedBots, state: amongUsGame.toPublic(result.room) });
  });

  socket.on('amongus:start', ({ roomId, playerId }, cb) => {
    const started = amongUsGame.startGame(amongUsRooms, { roomId, hostPlayerId: playerId });
    if (!started.ok) return cb?.(started);
    logRoomEvent('amongus', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, round: started.room.round });
    emitAmongUsRoom(started.room);
    scheduleAmongUsPhase(started.room);
    cb?.({ ok: true, state: amongUsGame.toPublic(started.room) });
  });

  socket.on('amongus:action', ({ roomId, playerId, type, targetId }, cb) => {
    const result = amongUsGame.submitAction(amongUsRooms, { roomId, playerId, type, targetId });
    if (!result.ok) return cb?.(result);
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
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) player.isConnected = false;
      room.spectators.delete(socket.id);

      if (room.hostSocketId === socket.id && room.players.length > 0) {
        const replacement = room.players.find((p) => p.isConnected && !p.isBot);
        if (replacement) room.hostSocketId = replacement.socketId;
      }

      emitRoom(room);
    }

    for (const room of mafiaRooms.values()) {
      mafiaGame.disconnectPlayer(mafiaRooms, { roomId: room.id, socketId: socket.id });
      emitMafiaRoom(room);
    }

    for (const room of amongUsRooms.values()) {
      amongUsGame.disconnectPlayer(amongUsRooms, { roomId: room.id, socketId: socket.id });
      emitAmongUsRoom(room);
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

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

const agentProfiles = new Map();
const roastFeed = [];
const votes = new Set();
// pair vote caps removed: agent voting is unlimited except self/owner restrictions
const sessions = new Map();
const connectSessions = new Map();

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
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'valid email required' });
  const token = shortId(20);
  const session = { token, email, createdAt: Date.now() };
  sessions.set(token, session);
  res.json({ ok: true, session });
});

app.post('/api/openclaw/connect-session', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'valid email required' });

  const id = shortId(18);
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/openclaw/callback`;
  const callbackProof = shortId(24);
  const connect = {
    id,
    email,
    status: 'pending_confirmation',
    command: `openclaw agentarena connect --token ${id} --callback '${callbackUrl}' --proof ${callbackProof}`,
    callbackUrl,
    callbackProof,
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60_000,
    agentId: null,
    agentName: null,
  };
  connectSessions.set(id, connect);
  res.json({ ok: true, connect: {
    id: connect.id,
    email: connect.email,
    status: connect.status,
    command: connect.command,
    callbackUrl: connect.callbackUrl,
    createdAt: connect.createdAt,
    expiresAt: connect.expiresAt,
    agentId: connect.agentId,
    agentName: connect.agentName,
  } });
});

app.post('/api/openclaw/callback', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const proof = String(req.body?.proof || '').trim();
  const connect = connectSessions.get(token);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
  if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
  if (!proof || proof !== connect.callbackProof) return res.status(401).json({ ok: false, error: 'invalid callback proof' });

  if (connect.status === 'connected') return res.json({ ok: true, connect });

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
  persistState();

  res.json({ ok: true, connect, agent });
});

app.get('/api/openclaw/connect-session/:id', (req, res) => {
  const connect = connectSessions.get(req.params.id);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
  res.json({ ok: true, connect: {
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
  } });
});

app.post('/api/openclaw/connect-session/:id/confirm', (req, res) => {
  const connect = connectSessions.get(req.params.id);
  if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });

  if (connect.status === 'connected') return res.json({ ok: true, connect });

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
  persistState();

  res.json({ ok: true, connect, agent });
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

function summarizePlayableRoom(mode, room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const alivePlayers = players.filter((p) => p.alive !== false).length;
  const status = String(room?.status || 'lobby');
  const phase = String(room?.phase || (status === 'lobby' ? 'lobby' : 'unknown'));
  const canJoin = status === 'lobby' && players.length < 8;
  return {
    mode,
    roomId: room.id,
    status,
    phase,
    players: players.length,
    alivePlayers,
    hostName: players[0]?.name || 'Host',
    createdAt: room.createdAt || Date.now(),
    canJoin,
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

  let roomsList = [...mafia, ...amongus];

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

function pickQuickJoinMode(mode) {
  if (mode === 'mafia' || mode === 'amongus') return mode;
  const openMafia = listPlayableRooms('mafia', 'open').length;
  const openAmongUs = listPlayableRooms('amongus', 'open').length;
  return openMafia <= openAmongUs ? 'mafia' : 'amongus';
}

const QUICK_JOIN_MIN_PLAYERS = 4;

function createQuickJoinRoom(mode, hostName) {
  const socketId = null;
  if (mode === 'amongus') {
    return amongUsGame.createRoom(amongUsRooms, { hostName, hostSocketId: socketId });
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

app.get('/api/play/rooms', (req, res) => {
  const modeFilter = String(req.query.mode || 'all').toLowerCase();
  const statusFilter = String(req.query.status || 'all').toLowerCase();

  if (!['all', 'mafia', 'amongus'].includes(modeFilter)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode filter' });
  }

  const roomsList = listPlayableRooms(modeFilter, statusFilter);
  const summary = {
    totalRooms: roomsList.length,
    openRooms: roomsList.filter((room) => room.canJoin).length,
    playersOnline: roomsList.reduce((sum, room) => sum + room.players, 0),
    byMode: {
      mafia: roomsList.filter((room) => room.mode === 'mafia').length,
      amongus: roomsList.filter((room) => room.mode === 'amongus').length,
    },
  };

  res.json({ ok: true, rooms: roomsList.slice(0, 50), summary });
});

app.post('/api/play/quick-join', (req, res) => {
  const modeInput = String(req.body?.mode || 'all').toLowerCase();
  const playerName = String(req.body?.name || '').trim().slice(0, 24) || `Player-${Math.floor(Math.random() * 900) + 100}`;

  if (!['all', 'mafia', 'amongus'].includes(modeInput)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode' });
  }

  const selectedMode = pickQuickJoinMode(modeInput);
  const candidates = listPlayableRooms(selectedMode, 'open')
    .filter((room) => room.canJoin)
    .sort((a, b) => b.players - a.players || (b.createdAt || 0) - (a.createdAt || 0));

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

  const joinTicket = {
    mode: targetRoom.mode,
    roomId: targetRoom.roomId,
    name: playerName,
    autojoin: true,
    joinUrl: `/play.html?game=${targetRoom.mode}&room=${targetRoom.roomId}&autojoin=1&name=${encodeURIComponent(playerName)}`,
    issuedAt: Date.now(),
  };

  res.json({ ok: true, created, room: targetRoom, joinTicket });
});

app.post('/api/play/lobby/autofill', (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const roomId = String(req.body?.roomId || '').trim().toUpperCase();
  const minPlayers = Number(req.body?.minPlayers || QUICK_JOIN_MIN_PLAYERS);

  if (!['mafia', 'amongus'].includes(mode)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_MODE', message: 'mode must be mafia|amongus' } });
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
    state: mode === 'mafia' ? mafiaGame.toPublic(result.room) : amongUsGame.toPublic(result.room),
  });
});

loadState();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rooms/:roomId/events', (req, res) => {
  const roomId = String(req.params.roomId || '').toUpperCase();
  const mode = String(req.query.mode || 'arena').toLowerCase();
  const limit = Number(req.query.limit || 1000);
  if (!['arena', 'mafia', 'amongus'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode' });
  }

  const events = roomEvents.list(mode, roomId, limit);
  res.json({ ok: true, mode, roomId, count: events.length, events });
});

app.get('/api/rooms/:roomId/replay', (req, res) => {
  const roomId = String(req.params.roomId || '').toUpperCase();
  const mode = String(req.query.mode || 'arena').toLowerCase();
  if (!['arena', 'mafia', 'amongus'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'Invalid mode' });
  }

  const replay = roomEvents.replay(mode, roomId);
  if (!replay.ok) return res.status(404).json({ ok: false, error: 'No events for room', mode, roomId });
  res.json({ ok: true, ...replay });
});

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

if (require.main === module) {
  runAutoBattle();
  setInterval(() => {
    runAutoBattle();
  }, 20_000);

  server.listen(PORT, () => {
    console.log(`Agent Arena running on http://localhost:${PORT}`);
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
  roomEvents,
  arenaCanary,
  clearAllGameTimers,
};
