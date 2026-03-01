const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function capEvents(room) {
  if (room.events.length > 100) room.events = room.events.slice(-50);
}

function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createStore() {
  return new Map();
}

const PHASE_TRANSITIONS = {
  lobby: new Set(['night']),
  night: new Set(['discussion', 'finished']),
  discussion: new Set(['voting', 'finished']),
  voting: new Set(['night', 'finished']),
  finished: new Set(),
};

function transitionRoomState(room, nextPhase, options = {}) {
  const fromPhase = room.phase;
  const allowed = PHASE_TRANSITIONS[fromPhase] || new Set();
  if (!allowed.has(nextPhase)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_PHASE_TRANSITION',
        message: `Invalid phase transition: ${fromPhase} -> ${nextPhase}`,
        details: { fromPhase, toPhase: nextPhase },
      },
    };
  }

  room.phase = nextPhase;
  if (options.nextStatus) room.status = options.nextStatus;
  return { ok: true, room };
}

function summarizeBotAutoplay(room) {
  const aliveBots = room.players.filter((p) => p.alive && p.isBot);
  if (room.status !== 'in_progress') {
    return { enabled: true, pendingActions: 0, aliveBots: aliveBots.length, phase: room.phase, hint: 'Autoplay starts when match is in progress.' };
  }

  if (room.phase === 'night') {
    const pending = aliveBots.filter((p) => p.role === 'mafia' && !room.actions?.night?.[p.id]).length;
    return { enabled: true, pendingActions: pending, aliveBots: aliveBots.length, phase: room.phase, hint: pending > 0 ? 'Bots are selecting night targets.' : 'Night bot actions complete.' };
  }

  if (room.phase === 'discussion') {
    const pending = aliveBots.filter((p) => room.actions?.vote?.[p.id] !== '__READY__').length;
    return { enabled: true, pendingActions: pending, aliveBots: aliveBots.length, phase: room.phase, hint: pending > 0 ? 'Bots are marking ready to move into voting.' : 'Bots ready. Waiting for remaining players.' };
  }

  if (room.phase === 'voting') {
    const pending = aliveBots.filter((p) => !room.actions?.vote?.[p.id]).length;
    return { enabled: true, pendingActions: pending, aliveBots: aliveBots.length, phase: room.phase, hint: pending > 0 ? 'Bots are casting votes.' : 'Bot votes submitted.' };
  }

  return { enabled: true, pendingActions: 0, aliveBots: aliveBots.length, phase: room.phase, hint: 'Autoplay active.' };
}

function toPublic(room) {
  return {
    id: room.id,
    partyChainId: room.partyChainId,
    partyStreak: room.partyStreak || 0,
    hostPlayerId: room.hostPlayerId,
    status: room.status,
    phase: room.phase,
    day: room.day,
    winner: room.winner,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: room.status === 'finished' ? p.role : undefined,
      isConnected: p.isConnected,
      isBot: Boolean(p.isBot),
    })),
    tally: room.tally,
    events: room.events.slice(-8),
    botAutoplay: true,
    autoplay: summarizeBotAutoplay(room),
  };
}

function createRoom(store, { hostName, hostSocketId }) {
  const cleanHost = String(hostName || '').trim().slice(0, 24);
  if (!cleanHost) return { ok: false, error: { code: 'HOST_NAME_REQUIRED', message: 'hostName required' } };

  const host = {
    id: shortId(8),
    name: cleanHost,
    socketId: hostSocketId || null,
    isConnected: true,
    alive: true,
    role: null,
  };

  const room = {
    id: shortId(6),
    partyChainId: shortId(10),
    partyStreak: 0,
    status: 'lobby',
    phase: 'lobby',
    hostPlayerId: host.id,
    createdAt: Date.now(),
    day: 0,
    players: [host],
    winner: null,
    maxDays: 1,
    actions: {
      night: {}, // mafiaPlayerId -> targetId
      vote: {}, // voterId -> targetId
    },
    tally: {},
    events: [],
  };

  store.set(room.id, room);
  return { ok: true, room, player: host };
}

function joinRoom(store, { roomId, name, socketId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'ROOM_ALREADY_STARTED', message: 'Game already started' } };

  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) return { ok: false, error: { code: 'NAME_REQUIRED', message: 'name required' } };

  const MAX_LOBBY_PLAYERS = 4;
  const normalized = cleanName.toLowerCase();
  const socketSeat = room.players.find((p) => p.isConnected && p.socketId && socketId && p.socketId === socketId);
  if (socketSeat) {
    if (String(socketSeat.name || '').toLowerCase() === normalized) {
      socketSeat.name = cleanName;
      return { ok: true, room, player: socketSeat };
    }
    return { ok: false, error: { code: 'SOCKET_ALREADY_JOINED', message: 'Socket already controls a player in this room' } };
  }

  let player = room.players.find((p) => String(p.name || '').toLowerCase() === normalized);

  if (player) {
    if (player.isConnected && player.socketId && player.socketId !== socketId) {
      return { ok: false, error: { code: 'NAME_IN_USE', message: 'Name already in use in this room' } };
    }
    player.isConnected = true;
    player.socketId = socketId || null;
    player.name = cleanName;
    return { ok: true, room, player };
  }

  if (room.players.length >= MAX_LOBBY_PLAYERS) {
    return { ok: false, error: { code: 'ROOM_FULL', message: 'Room is full' } };
  }

  player = {
    id: shortId(8),
    name: cleanName,
    socketId: socketId || null,
    isConnected: true,
    alive: true,
    role: null,
  };
  room.players.push(player);

  return { ok: true, room, player };
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function checkWin(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter((p) => p.role === 'mafia').length;
  const town = alive.filter((p) => p.role === 'town').length;

  if (mafia === 0) return 'town';
  if (mafia >= town) return 'mafia';
  return null;
}

function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };
  if (room.players.length < 4) return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 4 players' } };

  const transitioned = transitionRoomState(room, 'night', { nextStatus: 'in_progress' });
  if (!transitioned.ok) return transitioned;

  room.day = 1;
  room.winner = null;
  room.actions = { night: {}, vote: {} };
  room.tally = {};
  room.events = [{ type: 'GAME_STARTED', at: Date.now(), day: room.day }];

  const shuffled = fisherYatesShuffle(room.players);
  const mafiaCount = Math.max(1, Math.floor(room.players.length / 4));
  shuffled.forEach((p, idx) => {
    p.role = idx < mafiaCount ? 'mafia' : 'town';
    p.alive = true;
  });

  return { ok: true, room };
}

function transitionPhase(room, nextPhase) {
  const transitioned = transitionRoomState(room, nextPhase);
  if (!transitioned.ok) return transitioned;
  room.events.push({ type: 'PHASE', phase: nextPhase, day: room.day, at: Date.now() });
  return transitioned;
}

function submitAction(store, { roomId, playerId, type, targetId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  const actor = room.players.find((p) => p.id === playerId);
  if (!actor || !actor.alive) return { ok: false, error: { code: 'INVALID_PLAYER', message: 'Invalid player' } };

  if (room.phase === 'night' && type === 'nightKill') {
    if (actor.role !== 'mafia') return { ok: false, error: { code: 'ROLE_FORBIDDEN', message: 'Only mafia can kill at night' } };
    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive || target.id === actor.id) return { ok: false, error: { code: 'INVALID_TARGET', message: 'Invalid target' } };
    room.actions.night[actor.id] = target.id;
    return maybeAutoAdvance(room);
  }

  if (room.phase === 'discussion' && type === 'ready') {
    room.actions.vote[actor.id] = '__READY__';
    const aliveCount = alivePlayers(room).length;
    if (Object.keys(room.actions.vote).length >= aliveCount) {
      room.actions.vote = {};
      const transitioned = transitionPhase(room, 'voting');
      if (!transitioned.ok) return transitioned;
    }
    return { ok: true, room };
  }

  if (room.phase === 'voting' && type === 'vote') {
    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return { ok: false, error: { code: 'INVALID_TARGET', message: 'Invalid target' } };
    room.actions.vote[actor.id] = target.id;
    const aliveCount = alivePlayers(room).length;
    if (Object.keys(room.actions.vote).length >= aliveCount) {
      const resolved = resolveVote(room);
      if (resolved && resolved.ok === false) return resolved;
    }
    return { ok: true, room };
  }

  return { ok: false, error: { code: 'INVALID_ACTION', message: 'Action not allowed in current phase' } };
}

function maybeAutoAdvance(room) {
  if (room.phase !== 'night') return { ok: true, room };
  const aliveMafia = room.players.filter((p) => p.alive && p.role === 'mafia');
  if (aliveMafia.length === 0) {
    const w = checkWin(room);
    if (w) return finish(room, w);
    return { ok: true, room };
  }

  const allActed = aliveMafia.every((p) => room.actions.night[p.id]);
  if (allActed) {
    const resolved = resolveNight(room);
    if (resolved && resolved.ok === false) return resolved;
  }
  return { ok: true, room };
}

function forceAdvance(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  if (room.phase === 'night') {
    const resolved = resolveNight(room);
    if (resolved && resolved.ok === false) return resolved;
  } else if (room.phase === 'discussion') {
    room.actions.vote = {};
    const transitioned = transitionPhase(room, 'voting');
    if (!transitioned.ok) return transitioned;
  } else if (room.phase === 'voting') {
    const resolved = resolveVote(room);
    if (resolved && resolved.ok === false) return resolved;
  }
  return { ok: true, room };
}

function resolveNight(room) {
  const counts = {};
  for (const targetId of Object.values(room.actions.night)) counts[targetId] = (counts[targetId] || 0) + 1;
  room.actions.night = {};

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const victimId = sorted[0]?.[0] || null;
  if (victimId) {
    const victim = room.players.find((p) => p.id === victimId);
    if (victim && victim.alive) victim.alive = false;
    room.events.push({ type: 'NIGHT_ELIMINATION', targetId: victimId, at: Date.now(), day: room.day });
  }

  const winner = checkWin(room);
  if (winner) return finish(room, winner);

  const transitioned = transitionPhase(room, 'discussion');
  if (!transitioned.ok) return transitioned;

  room.actions.vote = {};
  return { ok: true, room };
}

function resolveVote(room) {
  const counts = {};
  for (const targetId of Object.values(room.actions.vote)) {
    if (targetId === '__READY__') continue;
    counts[targetId] = (counts[targetId] || 0) + 1;
  }
  room.tally = counts;
  room.actions.vote = {};

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  // Skip elimination on tie (top two have same vote count)
  const topVotes = sorted[0]?.[1] || 0;
  const isTied = sorted.length >= 2 && sorted[1][1] === topVotes;
  const executedId = (!isTied && sorted[0]?.[0]) || null;
  if (executedId) {
    const target = room.players.find((p) => p.id === executedId);
    if (target && target.alive) target.alive = false;
    room.events.push({ type: 'DAY_EXECUTION', targetId: executedId, at: Date.now(), day: room.day });
  } else if (isTied) {
    room.events.push({ type: 'VOTE_TIED', at: Date.now(), day: room.day });
  }

  const winner = checkWin(room);
  if (winner) return finish(room, winner);

  if (room.day >= room.maxDays) {
    return finish(room, 'town');
  }

  room.day += 1;
  const transitioned = transitionPhase(room, 'night');
  if (!transitioned.ok) return transitioned;
  return { ok: true, room };
}

function finish(room, winner) {
  const transitioned = transitionRoomState(room, 'finished', { nextStatus: 'finished' });
  if (!transitioned.ok) return transitioned;
  room.winner = winner;
  room.events.push({ type: 'GAME_FINISHED', winner, day: room.day, at: Date.now() });
  capEvents(room);
  return { ok: true, room };
}

function prepareRematch(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'finished') return { ok: false, error: { code: 'GAME_NOT_FINISHED', message: 'Rematch available after game ends' } };

  room.partyStreak = Math.max(0, Number(room.partyStreak || 0)) + 1;
  room.status = 'lobby';
  room.phase = 'lobby';
  room.day = 0;
  room.winner = null;
  room.actions = { night: {}, vote: {} };
  room.tally = {};
  room.events = [{ type: 'REMATCH_READY', at: Date.now() }];
  for (const player of room.players) {
    player.alive = true;
    player.role = null;
  }

  return { ok: true, room };
}

function addLobbyBots(store, { roomId, count, namePrefix = 'Mafia Bot' }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED', message: 'Can only add bots in lobby' } };

  const requested = Math.max(0, Number(count) || 0);
  const availableSlots = Math.max(0, 12 - room.players.length);
  const toAdd = Math.min(requested, availableSlots);
  const bots = [];

  for (let i = 0; i < toAdd; i += 1) {
    const bot = {
      id: shortId(8),
      name: `${namePrefix} ${room.players.length + 1}`.slice(0, 24),
      socketId: null,
      isConnected: true,
      alive: true,
      role: null,
      isBot: true,
    };
    room.players.push(bot);
    bots.push(bot);
  }

  return { ok: true, room, bots };
}

function disconnectPlayer(store, { roomId, socketId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return false;
  const p = room.players.find((x) => x.socketId === socketId);
  if (!p || !p.isConnected) return false;
  p.isConnected = false;
  return true;
}

module.exports = {
  createStore,
  createRoom,
  joinRoom,
  startGame,
  submitAction,
  forceAdvance,
  prepareRematch,
  addLobbyBots,
  disconnectPlayer,
  transitionRoomState,
  toPublic,
};
