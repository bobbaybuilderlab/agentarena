const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
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
  lobby: new Set(['tasks']),
  tasks: new Set(['meeting', 'finished']),
  meeting: new Set(['tasks', 'finished']),
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

  if (room.phase === 'tasks') {
    const aliveCrew = room.players.filter((p) => p.alive && p.role === 'crew').length;
    const pending = aliveBots.filter((p) => {
      if (p.role === 'crew') return p.tasksDone < room.tasksToWin;
      if (p.role === 'imposter') return aliveCrew > 0;
      return false;
    }).length;
    return { enabled: true, pendingActions: pending, aliveBots: aliveBots.length, phase: room.phase, hint: pending > 0 ? 'Bots are running tasks/kills.' : 'Task phase bot actions complete.' };
  }

  if (room.phase === 'meeting') {
    const pending = aliveBots.filter((p) => !room.votes?.[p.id]).length;
    return { enabled: true, pendingActions: pending, aliveBots: aliveBots.length, phase: room.phase, hint: pending > 0 ? 'Bots are voting in meeting.' : 'Bot votes submitted.' };
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
    winner: room.winner,
    meetingReason: room.meetingReason,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: room.status === 'finished' ? p.role : undefined,
      tasksDone: p.tasksDone,
      isConnected: p.isConnected,
      isBot: Boolean(p.isBot),
    })),
    votes: room.votes,
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
    tasksDone: 0,
  };

  const room = {
    id: shortId(6),
    partyChainId: shortId(10),
    partyStreak: 0,
    status: 'lobby',
    phase: 'lobby',
    hostPlayerId: host.id,
    players: [host],
    winner: null,
    meetingReason: null,
    tasksToWin: 1,
    votes: {},
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
    tasksDone: 0,
  };
  room.players.push(player);

  return { ok: true, room, player };
}

function alive(room) {
  return room.players.filter((p) => p.alive);
}

function counts(room) {
  const alivePlayers = alive(room);
  const imposters = alivePlayers.filter((p) => p.role === 'imposter').length;
  const crew = alivePlayers.filter((p) => p.role === 'crew').length;
  return { imposters, crew };
}

function checkWin(room) {
  const { imposters, crew } = counts(room);
  const totalCrewTasks = room.players
    .filter((p) => p.role === 'crew' && p.alive)
    .reduce((n, p) => n + p.tasksDone, 0);

  if (imposters === 0) return 'crew';
  if (imposters >= crew) return 'imposter';
  if (totalCrewTasks >= room.tasksToWin * Math.max(1, crew)) return 'crew';
  return null;
}

function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };
  if (room.players.length < 4) return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 4 players' } };

  const transitioned = transitionRoomState(room, 'tasks', { nextStatus: 'in_progress' });
  if (!transitioned.ok) return transitioned;

  room.winner = null;
  room.meetingReason = null;
  room.votes = {};
  room.events = [{ type: 'GAME_STARTED', at: Date.now() }];

  const shuffled = fisherYatesShuffle(room.players);
  const imposterCount = 1;
  shuffled.forEach((p, i) => {
    p.role = i < imposterCount ? 'imposter' : 'crew';
    p.alive = true;
    p.tasksDone = 0;
  });

  return { ok: true, room };
}

function submitAction(store, { roomId, playerId, type, targetId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  const actor = room.players.find((p) => p.id === playerId);
  if (!actor || !actor.alive) return { ok: false, error: { code: 'INVALID_PLAYER', message: 'Invalid player' } };

  if (room.phase === 'tasks' && type === 'task') {
    if (actor.role !== 'crew') return { ok: false, error: { code: 'ROLE_FORBIDDEN', message: 'Only crew can do tasks' } };
    actor.tasksDone = Math.min(room.tasksToWin, actor.tasksDone + 1);
    room.events.push({ type: 'TASK_DONE', playerId: actor.id, at: Date.now() });

    const winner = checkWin(room);
    if (winner) return finish(room, winner);
    return { ok: true, room };
  }

  if (room.phase === 'tasks' && type === 'kill') {
    if (actor.role !== 'imposter') return { ok: false, error: { code: 'ROLE_FORBIDDEN', message: 'Only imposters can kill' } };
    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive || target.id === actor.id) return { ok: false, error: { code: 'INVALID_TARGET', message: 'Invalid target' } };
    if (target.role !== 'crew') return { ok: false, error: { code: 'INVALID_TARGET', message: 'Can only kill crew' } };

    target.alive = false;
    room.events.push({ type: 'KILL', actorId: actor.id, targetId: target.id, at: Date.now() });
    const transitionedToMeeting = transitionRoomState(room, 'meeting');
    if (!transitionedToMeeting.ok) return transitionedToMeeting;
    room.meetingReason = 'body_reported';
    room.votes = {};

    const winner = checkWin(room);
    if (winner) return finish(room, winner);
    return { ok: true, room };
  }

  if (type === 'callMeeting') {
    const transitionedToMeeting = transitionRoomState(room, 'meeting');
    if (!transitionedToMeeting.ok) return transitionedToMeeting;
    room.meetingReason = 'called';
    room.votes = {};
    room.events.push({ type: 'MEETING_CALLED', playerId: actor.id, at: Date.now() });
    return { ok: true, room };
  }

  if (room.phase === 'meeting' && type === 'vote') {
    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return { ok: false, error: { code: 'INVALID_TARGET', message: 'Invalid target' } };

    room.votes[actor.id] = target.id;
    if (Object.keys(room.votes).length >= alive(room).length) {
      const resolved = resolveMeeting(room);
      if (resolved && resolved.ok === false) return resolved;
    }
    return { ok: true, room };
  }

  return { ok: false, error: { code: 'INVALID_ACTION', message: 'Action not allowed in current phase' } };
}

function forceAdvance(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  if (room.phase === 'tasks') {
    const transitionedToMeeting = transitionRoomState(room, 'meeting');
    if (!transitionedToMeeting.ok) return transitionedToMeeting;
    room.meetingReason = 'timer';
    room.votes = {};
    room.events.push({ type: 'MEETING_TIMER', at: Date.now() });
  } else if (room.phase === 'meeting') {
    const resolved = resolveMeeting(room);
    if (resolved && resolved.ok === false) return resolved;
  }

  return { ok: true, room };
}

function resolveMeeting(room) {
  const counts = {};
  for (const targetId of Object.values(room.votes)) counts[targetId] = (counts[targetId] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const ejectedId = sorted[0]?.[0] || null;
  if (ejectedId) {
    const p = room.players.find((x) => x.id === ejectedId);
    if (p && p.alive) p.alive = false;
    room.events.push({ type: 'EJECTED', playerId: ejectedId, at: Date.now() });
  }

  room.votes = {};
  room.meetingReason = null;

  const winner = checkWin(room);
  if (winner) return finish(room, winner);

  const transitionedToTasks = transitionRoomState(room, 'tasks');
  if (!transitionedToTasks.ok) return transitionedToTasks;
  room.events.push({ type: 'MEETING_RESOLVED', at: Date.now() });
  return { ok: true, room };
}

function finish(room, winner) {
  const transitioned = transitionRoomState(room, 'finished', { nextStatus: 'finished' });
  if (!transitioned.ok) return transitioned;
  room.winner = winner;
  room.events.push({ type: 'GAME_FINISHED', winner, at: Date.now() });
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
  room.winner = null;
  room.meetingReason = null;
  room.votes = {};
  room.events.push({ type: 'REMATCH_READY', at: Date.now() });
  for (const player of room.players) {
    player.alive = true;
    player.role = null;
    player.tasksDone = 0;
  }

  return { ok: true, room };
}

function addLobbyBots(store, { roomId, count, namePrefix = 'Crew Bot' }) {
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
      tasksDone: 0,
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
