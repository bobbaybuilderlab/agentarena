const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function createStore() {
  return new Map();
}

function toPublic(room) {
  return {
    id: room.id,
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
    })),
    votes: room.votes,
    events: room.events.slice(-8),
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

  let player = room.players.find((p) => !p.isConnected && p.name === cleanName);
  if (!player) {
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
  } else {
    player.isConnected = true;
    player.socketId = socketId || null;
  }

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

  room.status = 'in_progress';
  room.phase = 'tasks';
  room.winner = null;
  room.meetingReason = null;
  room.votes = {};
  room.events = [{ type: 'GAME_STARTED', at: Date.now() }];

  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
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
    room.phase = 'meeting';
    room.meetingReason = 'body_reported';
    room.votes = {};

    const winner = checkWin(room);
    if (winner) return finish(room, winner);
    return { ok: true, room };
  }

  if (type === 'callMeeting') {
    room.phase = 'meeting';
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
      resolveMeeting(room);
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
    room.phase = 'meeting';
    room.meetingReason = 'timer';
    room.votes = {};
    room.events.push({ type: 'MEETING_TIMER', at: Date.now() });
  } else if (room.phase === 'meeting') {
    resolveMeeting(room);
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

  room.phase = 'tasks';
  room.events.push({ type: 'MEETING_RESOLVED', at: Date.now() });
}

function finish(room, winner) {
  room.status = 'finished';
  room.phase = 'finished';
  room.winner = winner;
  room.events.push({ type: 'GAME_FINISHED', winner, at: Date.now() });
  return { ok: true, room };
}

function disconnectPlayer(store, { roomId, socketId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return;
  const p = room.players.find((x) => x.socketId === socketId);
  if (p) p.isConnected = false;
}

module.exports = {
  createStore,
  createRoom,
  joinRoom,
  startGame,
  submitAction,
  forceAdvance,
  disconnectPlayer,
  toPublic,
};
