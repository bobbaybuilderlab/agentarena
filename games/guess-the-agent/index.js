// games/guess-the-agent/index.js
'use strict';

const { randomUUID } = require('crypto');
const { selectGamePrompts } = require('./prompts');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function capEvents(room) {
  if (room.events.length > 100) room.events = room.events.slice(-50);
}

function createStore() {
  return new Map();
}

// ─── Phase Transitions ─────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  lobby:   new Set(['prompt']),
  prompt:  new Set(['reveal']),
  reveal:  new Set(['vote']),
  vote:    new Set(['result']),
  result:  new Set(['prompt', 'finished']),
  finished: new Set(),
};

function transition(room, nextPhase, { nextStatus } = {}) {
  if (!VALID_TRANSITIONS[room.phase]?.has(nextPhase)) {
    return { ok: false, error: { code: 'INVALID_PHASE_TRANSITION', message: `${room.phase} → ${nextPhase} not allowed` } };
  }
  room.phase = nextPhase;
  if (nextStatus) room.status = nextStatus;
  return { ok: true };
}

// ─── createRoom ─────────────────────────────────────────────────────────────
function createRoom(store, { hostName, hostSocketId }) {
  const cleanHost = String(hostName || '').trim().slice(0, 24);
  if (!cleanHost) return { ok: false, error: { code: 'HOST_NAME_REQUIRED', message: 'hostName required' } };

  const host = {
    id: shortId(8),
    name: cleanHost,
    socketId: hostSocketId || null,
    isConnected: true,
    isBot: false,
    role: 'human',        // HOST IS ALWAYS THE HUMAN
    alive: true,
    score: 0,
  };

  const room = {
    id: shortId(6),
    partyChainId: shortId(10),
    partyStreak: 0,
    status: 'lobby',
    phase: 'lobby',
    hostPlayerId: host.id,
    hostSocketId: hostSocketId || null,
    round: 0,
    maxRounds: 3,
    prompts: [],
    currentPrompt: null,
    players: [host],
    responsesByRound: {},
    votesByRound: {},
    eliminatedByRound: {},
    roundResolved: false,
    roundEndsAt: null,
    winner: null,
    humanPlayerId: null,
    spectators: new Set(),
    events: [],
    createdAt: Date.now(),
  };

  store.set(room.id, room);
  return { ok: true, room, player: host };
}

// ─── joinRoom ────────────────────────────────────────────────────────────────
// IMPORTANT: Only 'agent' joins allowed after room creation.
// The human slot is always the room creator (host).
function joinRoom(store, { roomId, name, socketId, claimToken }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'ROOM_ALREADY_STARTED', message: 'Game already started' } };

  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) return { ok: false, error: { code: 'NAME_REQUIRED', message: 'name required' } };

  const MAX_PLAYERS = 6;

  // Reconnect: socket already controls a player?
  const socketSeat = room.players.find(p => p.isConnected && p.socketId && socketId && p.socketId === socketId);
  if (socketSeat) {
    if (String(socketSeat.name).toLowerCase() === cleanName.toLowerCase()) {
      socketSeat.name = cleanName;
      return { ok: true, room, player: socketSeat };
    }
    return { ok: false, error: { code: 'SOCKET_ALREADY_JOINED', message: 'Socket already controls a player' } };
  }

  // Reconnect: same name, disconnected?
  let player = room.players.find(p => String(p.name).toLowerCase() === cleanName.toLowerCase());
  if (player) {
    if (player.isConnected && player.socketId && player.socketId !== socketId) {
      return { ok: false, error: { code: 'NAME_IN_USE', message: 'Name already in use' } };
    }
    player.isConnected = true;
    player.socketId = socketId || null;
    player.name = cleanName;
    return { ok: true, room, player };
  }

  if (room.players.length >= MAX_PLAYERS) {
    return { ok: false, error: { code: 'ROOM_FULL', message: 'Room is full (6/6)' } };
  }

  // New agent join
  player = {
    id: shortId(8),
    name: cleanName,
    socketId: socketId || null,
    isConnected: true,
    isBot: false,
    role: 'agent',   // ALL NEW JOINS ARE AGENTS
    alive: true,
    score: 0,
  };
  room.players.push(player);
  return { ok: true, room, player };
}

// ─── startGame ───────────────────────────────────────────────────────────────
function startGame(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'INVALID_STATE', message: 'Game already started' } };

  const humans = room.players.filter(p => p.role === 'human');
  const agents = room.players.filter(p => p.role === 'agent');

  if (humans.length !== 1) return { ok: false, error: { code: 'NO_HUMAN', message: 'Need exactly 1 human player' } };
  if (agents.length < 2) return { ok: false, error: { code: 'NOT_ENOUGH_AGENTS', message: 'Need at least 2 agents' } };

  room.prompts = selectGamePrompts(room.maxRounds);
  if (!room.prompts.length) room.prompts = ['Describe yourself in one sentence.'];

  room.round = 1;
  room.currentPrompt = room.prompts[0];
  room.responsesByRound = {};
  room.votesByRound = {};
  room.eliminatedByRound = {};
  room.winner = null;
  room.humanPlayerId = humans[0].id;
  room.roundResolved = false;

  for (const p of room.players) { p.alive = true; }

  const t = transition(room, 'prompt', { nextStatus: 'in_progress' });
  if (!t.ok) return t;

  room.roundEndsAt = Date.now() + 45_000; // overridden by server with env var
  room.events.push({ type: 'GAME_STARTED', round: room.round, at: Date.now() });

  return { ok: true, room };
}

// ─── submitResponse ──────────────────────────────────────────────────────────
function submitResponse(store, { roomId, playerId, text }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE' } };
  if (room.phase !== 'prompt') return { ok: false, error: { code: 'WRONG_PHASE', message: `Expected prompt, got ${room.phase}` } };

  const player = room.players.find(p => p.id === playerId && p.alive);
  if (!player) return { ok: false, error: { code: 'INVALID_PLAYER' } };

  if (!room.responsesByRound[room.round]) room.responsesByRound[room.round] = {};
  if (room.responsesByRound[room.round][playerId]) {
    return { ok: false, error: { code: 'ALREADY_RESPONDED', message: 'Already submitted a response' } };
  }

  room.responsesByRound[room.round][playerId] = String(text || '').trim().slice(0, 280) || '[no response]';
  room.events.push({ type: 'RESPONSE_SUBMITTED', playerId, round: room.round, at: Date.now() });

  // Check if all alive players responded
  const alivePlayers = room.players.filter(p => p.alive);
  const allSubmitted = alivePlayers.every(p => room.responsesByRound[room.round][p.id]);

  let advanced = false;
  if (allSubmitted) {
    advanceToReveal(room);
    advanced = true;
  }

  return { ok: true, room, advanced };
}

function advanceToReveal(room) {
  transition(room, 'reveal');
  room.roundEndsAt = null; // server sets this
  room.events.push({ type: 'REVEAL_STARTED', round: room.round, at: Date.now() });
}

// ─── castVote ────────────────────────────────────────────────────────────────
function castVote(store, { roomId, voterId, targetId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE' } };
  if (room.phase !== 'vote') return { ok: false, error: { code: 'WRONG_PHASE', message: `Expected vote, got ${room.phase}` } };

  const voter = room.players.find(p => p.id === voterId && p.alive);
  if (!voter) return { ok: false, error: { code: 'INVALID_VOTER' } };
  if (voter.role !== 'agent') return { ok: false, error: { code: 'HUMAN_CANNOT_VOTE', message: 'Human cannot cast binding votes' } };

  const target = room.players.find(p => p.id === targetId && p.alive);
  if (!target) return { ok: false, error: { code: 'INVALID_TARGET', message: 'Target not found or not alive' } };
  if (voterId === targetId) return { ok: false, error: { code: 'SELF_VOTE', message: 'Cannot vote for yourself' } };

  if (!room.votesByRound[room.round]) room.votesByRound[room.round] = {};
  if (room.votesByRound[room.round][voterId]) {
    return { ok: false, error: { code: 'ALREADY_VOTED', message: 'Already voted this round' } };
  }

  room.votesByRound[room.round][voterId] = targetId;
  room.events.push({ type: 'VOTE_CAST', voterId, targetId, round: room.round, at: Date.now() });

  // Check if majority threshold reached or all alive agents have voted
  const aliveAgents = room.players.filter(p => p.alive && p.role === 'agent');
  const allVoted = aliveAgents.every(p => room.votesByRound[room.round][p.id]);
  const majority = Math.ceil((aliveAgents.length + 1) / 2);

  // Tally current votes to see if any target already has majority
  const currentTally = {};
  for (const [vid, tid] of Object.entries(room.votesByRound[room.round])) {
    const v = room.players.find(p => p.id === vid);
    if (!v || v.role !== 'agent') continue;
    currentTally[tid] = (currentTally[tid] || 0) + 1;
  }
  const hasMajority = Object.values(currentTally).some(c => c >= majority);

  let resolved = false;
  if ((allVoted || hasMajority) && !room.roundResolved) {
    resolveRound(room);
    resolved = true;
  }

  return { ok: true, room, resolved };
}

// ─── resolveRound ─────────────────────────────────────────────────────────────
function resolveRound(room) {
  if (room.roundResolved) return; // guard against double-resolution
  room.roundResolved = true;

  const votes = room.votesByRound[room.round] || {};

  // Count votes — only agent votes count
  const tally = {};
  for (const [voterId, targetId] of Object.entries(votes)) {
    const voter = room.players.find(p => p.id === voterId);
    if (!voter || voter.role !== 'agent') continue; // skip human votes
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  // Dynamic threshold: majority of alive agents
  const aliveAgents = room.players.filter(p => p.alive && p.role === 'agent');
  // Simple majority: more than half
  const majority = Math.ceil((aliveAgents.length + 1) / 2);

  // Find the player with the most votes (if they reach majority)
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topTargetId = sorted[0]?.[0] || null;
  const topVotes = sorted[0]?.[1] || 0;

  room.eliminatedByRound[room.round] = null;

  if (topTargetId && topVotes >= majority) {
    const eliminated = room.players.find(p => p.id === topTargetId);
    if (eliminated) {
      eliminated.alive = false;
      room.eliminatedByRound[room.round] = topTargetId;
      room.events.push({ type: 'PLAYER_ELIMINATED', playerId: topTargetId, round: room.round, at: Date.now() });

      // Win check: was it the human?
      if (eliminated.role === 'human') {
        return finish(room, 'agents');
      }

      // Win check: all agents eliminated?
      const remainingAgents = room.players.filter(p => p.alive && p.role === 'agent');
      if (remainingAgents.length === 0) {
        return finish(room, 'human');
      }
    }
  }

  // No elimination or agent eliminated — check if game should continue
  transition(room, 'result');
  room.events.push({ type: 'ROUND_RESOLVED', round: room.round, eliminated: room.eliminatedByRound[room.round], at: Date.now() });
}

// ─── finish ──────────────────────────────────────────────────────────────────
function finish(room, winner) {
  room.status = 'finished';
  room.phase = 'finished';
  room.winner = winner;
  // humanPlayerId was set at startGame — now it's safe to reveal in toPublic()
  room.events.push({ type: 'GAME_FINISHED', winner, humanPlayerId: room.humanPlayerId, at: Date.now() });
  capEvents(room);
}

// ─── forceAdvance ────────────────────────────────────────────────────────────
function forceAdvance(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE' } };

  const currentPhase = room.phase;

  if (currentPhase === 'prompt') {
    // Fill missing responses with empty strings
    if (!room.responsesByRound[room.round]) room.responsesByRound[room.round] = {};
    for (const p of room.players.filter(px => px.alive)) {
      if (!room.responsesByRound[room.round][p.id]) {
        room.responsesByRound[room.round][p.id] = '[no response]';
      }
    }
    advanceToReveal(room);
    return { ok: true, room };
  }

  if (currentPhase === 'reveal') {
    const t = transition(room, 'vote');
    if (!t.ok) return t;
    room.roundEndsAt = null;
    room.events.push({ type: 'VOTE_STARTED', round: room.round, at: Date.now() });
    return { ok: true, room };
  }

  if (currentPhase === 'vote') {
    if (!room.roundResolved) {
      resolveRound(room);
    }
    return { ok: true, room };
  }

  if (currentPhase === 'result') {
    if (room.status === 'finished') return { ok: true, room }; // already done

    // Advance to next round or finish
    if (room.round >= room.maxRounds) {
      // Human survived all rounds — human wins
      finish(room, 'human');
    } else {
      room.round += 1;
      room.currentPrompt = room.prompts[room.round - 1] || room.prompts[room.prompts.length - 1];
      room.roundResolved = false;
      const t = transition(room, 'prompt');
      if (!t.ok) return t;
      room.roundEndsAt = null; // server will set this
      room.events.push({ type: 'ROUND_STARTED', round: room.round, prompt: room.currentPrompt, at: Date.now() });
    }
    return { ok: true, room };
  }

  return { ok: false, error: { code: 'ALREADY_ADVANCED', message: `No advance from phase: ${currentPhase}` } };
}

// ─── forceAgentsWin (human abandoned) ────────────────────────────────────────
function forceAgentsWin(store, { roomId, reason }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'in_progress') return { ok: false, error: { code: 'GAME_NOT_ACTIVE' } };
  room.events.push({ type: 'HUMAN_ABANDONED', reason: reason || 'disconnect', at: Date.now() });
  finish(room, 'agents');
  return { ok: true, room };
}

// ─── prepareRematch ──────────────────────────────────────────────────────────
function prepareRematch(store, { roomId, hostPlayerId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.hostPlayerId !== hostPlayerId) return { ok: false, error: { code: 'HOST_ONLY' } };
  if (room.status !== 'finished') return { ok: false, error: { code: 'GAME_NOT_FINISHED' } };

  room.partyStreak = Math.max(0, (room.partyStreak || 0)) + 1;
  room.status = 'lobby';
  room.phase = 'lobby';
  room.round = 0;
  room.currentPrompt = null;
  room.prompts = [];
  room.responsesByRound = {};
  room.votesByRound = {};
  room.eliminatedByRound = {};
  room.roundResolved = false;
  room.roundEndsAt = null;
  room.winner = null;
  room.humanPlayerId = null;

  for (const p of room.players) {
    p.alive = true;
    // Note: roles are KEPT (host stays human, agents stay agents)
    // In a rematch, same roles unless we add role-rotation later
  }

  room.events = [{ type: 'REMATCH_READY', at: Date.now() }];
  return { ok: true, room };
}

// ─── addLobbyBots ─────────────────────────────────────────────────────────────
function addLobbyBots(store, { roomId, count, namePrefix = 'Agent' }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED' } };

  const requested = Math.max(0, Number(count) || 0);
  const availableSlots = Math.max(0, 6 - room.players.length);
  const toAdd = Math.min(requested, availableSlots);
  const bots = [];

  for (let i = 0; i < toAdd; i++) {
    const bot = {
      id: shortId(8),
      name: `${namePrefix} ${room.players.length + 1}`.slice(0, 24),
      socketId: null,
      isConnected: true,
      isBot: true,
      role: 'agent',
      alive: true,
      score: 0,
    };
    room.players.push(bot);
    bots.push(bot);
  }

  return { ok: true, room, bots };
}

// ─── disconnectPlayer ─────────────────────────────────────────────────────────
function disconnectPlayer(store, { roomId, socketId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return false;
  const p = room.players.find(px => px.socketId === socketId);
  if (!p || !p.isConnected) return false;
  p.isConnected = false;
  return true;
}

// ─── toPublic ─────────────────────────────────────────────────────────────────
// SECURITY: role and humanPlayerId are NEVER sent until status === 'finished'
// Exception: forPlayerId sees their own role
function toPublic(room, { forPlayerId } = {}) {
  const isFinished = room.status === 'finished';

  return {
    id: room.id,
    partyChainId: room.partyChainId,
    partyStreak: room.partyStreak || 0,
    hostPlayerId: room.hostPlayerId,
    status: room.status,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    currentPrompt: room.status !== 'lobby' ? room.currentPrompt : null,
    roundEndsAt: room.roundEndsAt,
    winner: room.winner,

    // CRITICAL: only reveal human identity after game ends
    humanPlayerId: isFinished ? room.humanPlayerId : null,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isBot: Boolean(p.isBot),
      isConnected: p.isConnected,
      score: p.score || 0,

      // role: only reveal after finish OR to the player themselves
      role: isFinished
        ? p.role
        : (forPlayerId && p.id === forPlayerId ? p.role : undefined),
    })),

    responsesByRound: buildPublicResponses(room),
    votesByRound: buildPublicVotes(room),
    eliminatedByRound: room.eliminatedByRound,
    events: room.events.slice(-10),
    spectatorCount: room.spectators ? room.spectators.size : 0,
  };
}

// Response visibility rules:
// - prompt phase: nothing shown
// - reveal phase: shuffled anonymous (keys: A/B/C/D/E/F)
// - vote phase: named (keyed by playerId)
// - result/finished: named
function buildPublicResponses(room) {
  const result = {};
  for (let r = 1; r <= room.round; r++) {
    const responses = room.responsesByRound[r];
    if (!responses) continue;

    if (r === room.round && room.phase === 'prompt') {
      // Hide all during prompt
      result[r] = null;
    } else if (r === room.round && room.phase === 'reveal') {
      // Anonymise: deterministic shuffle by room.id + round
      const entries = Object.entries(responses);
      const seed = hashSeed(room.id + r);
      const shuffled = seededShuffle(entries, seed);
      const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
      result[r] = {};
      shuffled.forEach(([, text], i) => {
        result[r][labels[i]] = text;
      });
    } else {
      // vote/result/finished: full attribution
      result[r] = { ...responses };
    }
  }
  return result;
}

function buildPublicVotes(room) {
  const result = {};
  for (let r = 1; r <= room.round; r++) {
    const votes = room.votesByRound[r];
    if (!votes) continue;
    // Only show votes in result phase or later
    if (r < room.round || ['result', 'finished'].includes(room.phase)) {
      result[r] = { ...votes };
    } else {
      result[r] = null; // hidden during vote phase
    }
  }
  return result;
}

// Deterministic shuffle helpers
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  createStore,
  createRoom,
  joinRoom,
  startGame,
  submitResponse,
  castVote,
  forceAdvance,
  forceAgentsWin,
  prepareRematch,
  addLobbyBots,
  disconnectPlayer,
  toPublic,
};
