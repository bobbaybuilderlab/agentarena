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

const ACTION_BY_PHASE = {
  pairing: 'pair',
  challenge: 'challengeVote',
  twist: 'twistVote',
  recouple: 'recouple',
  elimination: 'eliminateVote',
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

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function copyVotes(votes) {
  const out = {};
  for (const [k, v] of Object.entries(votes || {})) out[k] = v;
  return out;
}

function summarizeBotAutoplay(room) {
  const aliveBots = room.players.filter((p) => p.alive && p.isBot);
  if (room.status !== 'in_progress') {
    return {
      enabled: true,
      pendingActions: 0,
      aliveBots: aliveBots.length,
      phase: room.phase,
      hint: 'Autoplay starts when match is in progress.',
    };
  }

  const bucket = room.actions?.[room.phase] || {};
  const pending = aliveBots.filter((p) => !bucket[p.id]).length;
  return {
    enabled: true,
    pendingActions: pending,
    aliveBots: aliveBots.length,
    phase: room.phase,
    hint: pending > 0 ? 'Bots are submitting phase actions.' : 'Bot actions complete for this phase.',
  };
}

function toPublic(room) {
  const alive = alivePlayers(room);
  const submitted = Object.keys(room.actions?.[room.phase] || {}).length;
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
    winnerPlayerIds: room.winnerPlayerIds || [],
    survivors: alive.map((p) => p.id),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isConnected: p.isConnected,
      isBot: Boolean(p.isBot),
      coupleId: p.coupleId || null,
      role: room.status === 'finished' ? p.role : undefined,
    })),
    roundState: room.roundState,
    actionsSubmitted: {
      phase: room.phase,
      submitted,
      required: alive.length,
    },
    events: room.events.slice(-16),
    botAutoplay: true,
    autoplay: summarizeBotAutoplay(room),
  };
}

function newRoundState() {
  return {
    pairing: { complete: false, votes: {}, couples: [] },
    challenge: { complete: false, votes: {}, tally: {}, immunityPlayerId: null },
    twist: { complete: false, votes: {}, tally: {}, vulnerablePlayerId: null },
    recouple: { complete: false, votes: {}, couples: [] },
    elimination: { complete: false, votes: {}, tally: {}, eliminatedPlayerIds: [] },
  };
}

function newActionBuckets() {
  return {
    pairing: {},
    challenge: {},
    twist: {},
    recouple: {},
    elimination: {},
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
    isBot: false,
    alive: true,
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
    winnerPlayerIds: [],
    players: [host],
    events: [],
    actions: newActionBuckets(),
    roundState: newRoundState(),
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
    isBot: false,
    alive: true,
    coupleId: null,
    role: null,
  };
  room.players.push(player);

  return { ok: true, room, player };
}

function resetRound(room) {
  room.actions = newActionBuckets();
  room.roundState = newRoundState();
  for (const player of room.players) {
    if (!player.alive) {
      player.coupleId = null;
      continue;
    }
    player.coupleId = null;
  }
}

function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };
  if (room.players.length < 4) return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 4 players' } };

  for (const player of room.players) {
    player.alive = true;
    player.coupleId = null;
    player.role = 'islander';
  }

  room.round = 1;
  room.winner = null;
  room.winnerPlayerIds = [];
  room.events = [{ type: 'GAME_STARTED', at: Date.now(), round: room.round }];
  resetRound(room);

  const transitioned = transitionRoomState(room, 'pairing', { nextStatus: 'in_progress' });
  if (!transitioned.ok) return transitioned;

  return { ok: true, room };
}

function chooseTarget(room, actorId, options = {}) {
  const exclude = new Set([actorId, ...(options.exclude || [])]);
  const target = room.players
    .filter((p) => p.alive && !exclude.has(p.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  return target || null;
}

function resolveCouples(room, votes, stageKey) {
  const players = alivePlayers(room).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const byId = new Map(players.map((p) => [p.id, p]));
  const assigned = new Set();
  const couples = [];

  for (const player of players) {
    if (assigned.has(player.id)) continue;

    const preferredId = votes[player.id];
    let partner = null;

    if (preferredId && byId.has(preferredId) && !assigned.has(preferredId) && preferredId !== player.id) {
      partner = byId.get(preferredId);
      const partnerVote = votes[preferredId];
      if (partnerVote !== player.id && assigned.has(partner.id)) {
        partner = null;
      }
    }

    if (!partner) {
      partner = players.find((p) => p.id !== player.id && !assigned.has(p.id)) || null;
    }

    const coupleId = `R${room.round}-C${couples.length + 1}`;
    const members = [player];
    assigned.add(player.id);
    player.coupleId = coupleId;

    if (partner && !assigned.has(partner.id)) {
      members.push(partner);
      assigned.add(partner.id);
      partner.coupleId = coupleId;
    }

    couples.push({
      coupleId,
      playerIds: members.map((m) => m.id),
    });
  }

  room.roundState[stageKey].couples = couples;
  return couples;
}

function tallyVotes(votes) {
  const tally = {};
  for (const targetId of Object.values(votes || {})) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  return tally;
}

function pickTopByTally(tally, fallbackIds = []) {
  const sorted = Object.entries(tally || {}).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  if (sorted[0]?.[0]) return sorted[0][0];
  return (fallbackIds || []).sort((a, b) => String(a).localeCompare(String(b)))[0] || null;
}

function checkWin(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 2) return 'final_couple';
  if (room.round >= room.maxRounds) return 'viewer_favorite';
  return null;
}

function finish(room, winner) {
  const transitioned = transitionRoomState(room, 'finished', { nextStatus: 'finished', eventType: 'SEASON_FINISHED' });
  if (!transitioned.ok) return transitioned;
  room.winner = winner;
  room.winnerPlayerIds = alivePlayers(room).map((p) => p.id);
  room.events.push({
    type: 'GAME_FINISHED',
    winner,
    survivors: room.winnerPlayerIds,
    round: room.round,
    at: Date.now(),
  });
  return { ok: true, room };
}

function resolveCurrentPhase(room) {
  if (room.phase === 'pairing') {
    const votes = room.actions.pairing;
    room.roundState.pairing.complete = true;
    room.roundState.pairing.votes = copyVotes(votes);
    resolveCouples(room, votes, 'pairing');
    room.events.push({ type: 'PAIRING_COMPLETE', round: room.round, at: Date.now() });
    return transitionRoomState(room, 'challenge', { eventType: 'PHASE_ADVANCED' });
  }

  if (room.phase === 'challenge') {
    const votes = room.actions.challenge;
    const tally = tallyVotes(votes);
    const aliveIds = alivePlayers(room).map((p) => p.id);
    const immunityPlayerId = pickTopByTally(tally, aliveIds);

    room.roundState.challenge.complete = true;
    room.roundState.challenge.votes = copyVotes(votes);
    room.roundState.challenge.tally = tally;
    room.roundState.challenge.immunityPlayerId = immunityPlayerId;
    room.events.push({ type: 'CHALLENGE_COMPLETE', round: room.round, immunityPlayerId, at: Date.now() });

    return transitionRoomState(room, 'twist', { eventType: 'PHASE_ADVANCED' });
  }

  if (room.phase === 'twist') {
    const votes = room.actions.twist;
    const immunity = room.roundState.challenge.immunityPlayerId;
    const filtered = {};
    for (const [actorId, targetId] of Object.entries(votes)) {
      if (targetId && targetId !== immunity) filtered[actorId] = targetId;
    }
    const tally = tallyVotes(filtered);
    const fallbackIds = alivePlayers(room)
      .filter((p) => p.id !== immunity)
      .map((p) => p.id);
    const vulnerablePlayerId = pickTopByTally(tally, fallbackIds);

    room.roundState.twist.complete = true;
    room.roundState.twist.votes = copyVotes(votes);
    room.roundState.twist.tally = tally;
    room.roundState.twist.vulnerablePlayerId = vulnerablePlayerId;
    room.events.push({ type: 'TWIST_COMPLETE', round: room.round, vulnerablePlayerId, at: Date.now() });

    return transitionRoomState(room, 'recouple', { eventType: 'PHASE_ADVANCED' });
  }

  if (room.phase === 'recouple') {
    const votes = room.actions.recouple;
    room.roundState.recouple.complete = true;
    room.roundState.recouple.votes = copyVotes(votes);
    resolveCouples(room, votes, 'recouple');
    room.events.push({ type: 'RECOUPLE_COMPLETE', round: room.round, at: Date.now() });

    return transitionRoomState(room, 'elimination', { eventType: 'PHASE_ADVANCED' });
  }

  if (room.phase === 'elimination') {
    const votes = room.actions.elimination;
    const immunity = room.roundState.challenge.immunityPlayerId;
    const vulnerable = room.roundState.twist.vulnerablePlayerId;
    const filtered = {};

    for (const [actorId, targetId] of Object.entries(votes)) {
      if (!targetId || targetId === immunity) continue;
      filtered[actorId] = targetId;
    }

    const tally = tallyVotes(filtered);
    const fallbackIds = alivePlayers(room)
      .filter((p) => p.id !== immunity)
      .map((p) => p.id);
    let eliminatedPlayerId = pickTopByTally(tally, fallbackIds);
    if (!eliminatedPlayerId && vulnerable && vulnerable !== immunity) eliminatedPlayerId = vulnerable;

    if (eliminatedPlayerId) {
      const player = room.players.find((p) => p.id === eliminatedPlayerId);
      if (player && player.alive) {
        player.alive = false;
        player.coupleId = null;
      }
    }

    room.roundState.elimination.complete = true;
    room.roundState.elimination.votes = copyVotes(votes);
    room.roundState.elimination.tally = tally;
    room.roundState.elimination.eliminatedPlayerIds = eliminatedPlayerId ? [eliminatedPlayerId] : [];

    room.events.push({
      type: 'ELIMINATION_COMPLETE',
      round: room.round,
      eliminatedPlayerId: eliminatedPlayerId || null,
      at: Date.now(),
    });

    const winner = checkWin(room);
    if (winner) return finish(room, winner);

    const nextRound = room.round + 1;
    resetRound(room);
    return transitionRoomState(room, 'pairing', {
      nextRound,
      eventType: 'ROUND_ADVANCED',
    });
  }

  return { ok: false, error: { code: 'INVALID_PHASE', message: 'Unsupported phase for resolve' } };
}

function validateTarget(room, actor, targetId) {
  const target = room.players.find((p) => p.id === targetId);
  if (!target || !target.alive || target.id === actor.id) {
    return { ok: false, error: { code: 'INVALID_TARGET', message: 'Invalid target' } };
  }

  const immunity = room.roundState.challenge.immunityPlayerId;
  if ((room.phase === 'twist' || room.phase === 'elimination') && immunity && target.id === immunity) {
    return { ok: false, error: { code: 'IMMUNE_TARGET', message: 'Target is immune this round' } };
  }

  return { ok: true, target };
}

function submitAction(store, { roomId, playerId, type, targetId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  const actor = room.players.find((p) => p.id === playerId);
  if (!actor || !actor.alive) return { ok: false, error: { code: 'INVALID_PLAYER', message: 'Invalid player' } };

  const expectedType = ACTION_BY_PHASE[room.phase];
  if (!expectedType || expectedType !== type) {
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'Action not allowed in current phase' } };
  }

  const bucket = room.actions[room.phase] || (room.actions[room.phase] = {});
  if (bucket[actor.id]) {
    return { ok: false, error: { code: 'ACTION_ALREADY_SUBMITTED', message: 'Action already submitted for this phase' } };
  }

  const validTarget = validateTarget(room, actor, targetId);
  if (!validTarget.ok) return validTarget;

  bucket[actor.id] = validTarget.target.id;

  const alive = alivePlayers(room).length;
  if (Object.keys(bucket).length >= alive) {
    const resolved = resolveCurrentPhase(room);
    if (!resolved.ok) return resolved;
  }

  return { ok: true, room };
}

function fillMissingPhaseActions(room) {
  const phase = room.phase;
  const expectedType = ACTION_BY_PHASE[phase];
  if (!expectedType) return;
  const bucket = room.actions[phase] || (room.actions[phase] = {});
  const immunity = room.roundState.challenge.immunityPlayerId;

  for (const actor of alivePlayers(room)) {
    if (bucket[actor.id]) continue;

    const exclude = phase === 'twist' || phase === 'elimination'
      ? (immunity ? [immunity] : [])
      : [];
    const target = chooseTarget(room, actor.id, { exclude });
    if (target) bucket[actor.id] = target.id;
  }
}

function forceAdvance(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'Game not active' } };

  fillMissingPhaseActions(room);
  const resolved = resolveCurrentPhase(room);
  if (!resolved.ok) return resolved;

  return { ok: true, room };
}

function advanceRoundPhase(store, { roomId }) {
  return forceAdvance(store, { roomId });
}

function prepareRematch(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'finished') return { ok: false, error: { code: 'GAME_NOT_FINISHED', message: 'Rematch available after game ends' } };

  room.partyStreak = Math.max(0, Number(room.partyStreak || 0)) + 1;
  room.status = 'lobby';
  room.phase = 'lobby';
  room.round = 0;
  room.winner = null;
  room.winnerPlayerIds = [];
  room.actions = newActionBuckets();
  room.roundState = newRoundState();
  room.events.push({ type: 'REMATCH_READY', at: Date.now() });

  for (const player of room.players) {
    player.alive = true;
    player.coupleId = null;
    player.role = null;
  }

  return { ok: true, room };
}

function addLobbyBots(store, { roomId, count, namePrefix = 'Villa Bot' }) {
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
      isBot: true,
      alive: true,
      coupleId: null,
      role: null,
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
  advanceRoundPhase,
  prepareRematch,
  addLobbyBots,
  disconnectPlayer,
  transitionRoomState,
  toPublic,
};
