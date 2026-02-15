const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function createStore() {
  return new Map();
}

function createRoom(store, { hostName, hostSocketId }) {
  if (!hostName || !String(hostName).trim()) {
    return { ok: false, error: { code: 'HOST_NAME_REQUIRED', message: 'hostName required' } };
  }

  const id = shortId(6);
  const hostPlayer = {
    id: shortId(8),
    socketId: hostSocketId || null,
    name: String(hostName).trim().slice(0, 24),
    isConnected: true,
    role: null,
  };

  const room = {
    id,
    status: 'lobby',
    hostPlayerId: hostPlayer.id,
    createdAt: Date.now(),
    players: [hostPlayer],
    phase: 'lobby',
    config: {
      minPlayers: 4,
    },
    startedAt: null,
  };

  store.set(id, room);
  return { ok: true, room, player: hostPlayer };
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
      socketId: socketId || null,
      name: cleanName,
      isConnected: true,
      role: null,
    };
    room.players.push(player);
  } else {
    player.socketId = socketId || null;
    player.isConnected = true;
  }

  return { ok: true, room, player };
}

function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };
  if (room.players.length < room.config.minPlayers) {
    return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: `Need at least ${room.config.minPlayers} players` } };
  }

  room.status = 'in_progress';
  room.phase = 'night';
  room.startedAt = Date.now();

  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  const mafiaCount = Math.max(1, Math.floor(room.players.length / 4));

  shuffled.forEach((player, idx) => {
    player.role = idx < mafiaCount ? 'mafia' : 'town';
  });

  return { ok: true, room };
}

module.exports = {
  createStore,
  createRoom,
  joinRoom,
  startGame,
};
