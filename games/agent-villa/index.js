const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function createStore() {
  return new Map();
}

const PHASE_TRANSITIONS = {
  lobby: new Set(['pairing']),
  pairing: new Set(['challenge']),
  challenge: new Set(['twist']),
  twist: new Set(['recouple']),
  recouple: new Set(['elimination']),
  elimination: new Set(['pairing', 'finished']),
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
  if (Number.isFinite(options.nextRound)) room.round = options.nextRound;
  if (options.eventType) {
    room.events.push({
      type: options.eventType,
      fromPhase,
      toPhase: nextPhase,
      round: room.round,
      at: Date.now(),
    });
  }

  return { ok: true, room };
}

function toPublic(room) {
  return {
    id: room.id,
    partyChainId: room.partyChainId,
    partyStreak: room.partyStreak || 0,
    hostPlayerId: room.hostPlayerId,
    status: room.status,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    winner: room.winner,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isConnected: p.isConnected,
      isBot: Boolean(p.isBot),
      coupleId: p.coupleId || null,
      role: room.status === 'finished' ? p.role : undefined,
    })),
    events: room.events.slice(-12),
    placeholder: {
      pairing: room.roundState.pairing,
      challenge: room.roundState.challenge,
      twist: room.roundState.twist,
      recouple: room.roundState.recouple,
      elimination: room.roundState.elimination,
    },
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
    coupleId: null,
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
    round: 0,
    maxRounds: 3,
    winner: null,
    players: [host],
    events: [],
    roundState: {
      pairing: { complete: false, pairs: [] },
      challenge: { complete: false, scoreboard: [] },
      twist: { complete: false, cards: [] },
      recouple: { complete: false, decisions: [] },
      elimination: { complete: false, eliminatedPlayerIds: [] },
    },
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
      coupleId: null,
      role: null,
    };
    room.players.push(player);
  } else {
    player.isConnected = true;
    player.socketId = socketId || null;
  }

  return { ok: true, room, player };
}

function resetRoundPlaceholders(room) {
  room.roundState = {
    pairing: { complete: false, pairs: [] },
    challenge: { complete: false, scoreboard: [] },
    twist: { complete: false, cards: [] },
    recouple: { complete: false, decisions: [] },
    elimination: { complete: false, eliminatedPlayerIds: [] },
  };
}

function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };
  if (room.players.length < 4) return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 4 players' } };

  resetRoundPlaceholders(room);
  room.round = 1;
  room.winner = null;
  room.events = [{ type: 'GAME_STARTED', at: Date.now(), round: room.round }];

  const transitioned = transitionRoomState(room, 'pairing', { nextStatus: 'in_progress' });
  if (!transitioned.ok) return transitioned;

  return { ok: true, room };
}

function advanceRoundPhase(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  if (room.phase === 'pairing') {
    room.roundState.pairing.complete = true;
    return transitionRoomState(room, 'challenge', { eventType: 'PAIRING_COMPLETE' });
  }

  if (room.phase === 'challenge') {
    room.roundState.challenge.complete = true;
    return transitionRoomState(room, 'twist', { eventType: 'CHALLENGE_COMPLETE' });
  }

  if (room.phase === 'twist') {
    room.roundState.twist.complete = true;
    return transitionRoomState(room, 'recouple', { eventType: 'TWIST_COMPLETE' });
  }

  if (room.phase === 'recouple') {
    room.roundState.recouple.complete = true;
    return transitionRoomState(room, 'elimination', { eventType: 'RECOUPLE_COMPLETE' });
  }

  if (room.phase === 'elimination') {
    room.roundState.elimination.complete = true;

    if (room.round >= room.maxRounds) {
      room.winner = 'mvp_placeholder';
      return transitionRoomState(room, 'finished', { nextStatus: 'finished', eventType: 'SEASON_FINISHED' });
    }

    const nextRound = room.round + 1;
    resetRoundPlaceholders(room);
    return transitionRoomState(room, 'pairing', {
      nextRound,
      eventType: 'ROUND_ADVANCED',
    });
  }

  return { ok: false, error: { code: 'INVALID_PHASE', message: 'Unsupported phase for advance' } };
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
  advanceRoundPhase,
  disconnectPlayer,
  transitionRoomState,
  toPublic,
};
