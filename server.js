const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROUND_MS = 60_000;

const THEMES = [
  'Yo Mama',
  'Tech Twitter',
  'Startup Founder',
  'Gym Bro',
  'Crypto',
  'Corporate',
];

/** @type {Map<string, any>} */
const rooms = new Map();

function createRoom(host) {
  const roomId = nanoid(6).toUpperCase();
  const room = {
    id: roomId,
    createdAt: Date.now(),
    hostSocketId: host.socketId,
    theme: THEMES[Math.floor(Math.random() * THEMES.length)],
    players: [],
    spectators: new Set(),
    status: 'lobby', // lobby | round | voting | finished
    round: 0,
    maxRounds: 3,
    activePlayerIndex: 0,
    roastsByRound: {},
    votesByRound: {},
    totalVotes: {},
    roundEndsAt: null,
    voteEndsAt: null,
    lastWinner: null,
  };
  rooms.set(roomId, room);
  return room;
}

function getPublicRoom(room) {
  return {
    id: room.id,
    theme: room.theme,
    status: room.status,
    round: room.round,
    maxRounds: room.maxRounds,
    activePlayerIndex: room.activePlayerIndex,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
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

function ensurePlayer(room, socket, payload) {
  const { name, type } = payload;
  if (!name || !name.trim()) return { error: 'Name required' };
  const cleanType = type === 'agent' ? 'agent' : 'human';

  let player = room.players.find((p) => p.socketId === socket.id);
  if (!player) {
    player = {
      id: nanoid(8),
      socketId: socket.id,
      name: name.trim().slice(0, 24),
      type: cleanType,
      isConnected: true,
    };
    room.players.push(player);
  } else {
    player.name = name.trim().slice(0, 24);
    player.type = cleanType;
    player.isConnected = true;
  }

  if (!(player.id in room.totalVotes)) room.totalVotes[player.id] = 0;
  return { player };
}

function beginRound(room) {
  if (room.players.length < 2) return;
  room.status = 'round';
  room.round += 1;
  room.activePlayerIndex = 0;
  room.roastsByRound[room.round] = {};
  room.votesByRound[room.round] = {};
  room.roundEndsAt = Date.now() + ROUND_MS;

  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'round' || current.round !== room.round) return;
    beginVoting(current);
  }, ROUND_MS);

  emitRoom(room);
}

function beginVoting(room) {
  room.status = 'voting';
  room.voteEndsAt = Date.now() + 20_000;
  emitRoom(room);

  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'voting' || current.round !== room.round) return;
    finalizeRound(current);
  }, 20_000);
}

function finalizeRound(room) {
  const roundVotes = room.votesByRound[room.round] || {};
  let winnerId = null;
  let best = -1;
  for (const [playerId, count] of Object.entries(roundVotes)) {
    if (count > best) {
      winnerId = playerId;
      best = count;
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

  if (room.round >= room.maxRounds) {
    room.status = 'finished';
    room.roundEndsAt = null;
    room.voteEndsAt = null;
  } else {
    room.status = 'lobby';
    room.roundEndsAt = null;
    room.voteEndsAt = null;
  }

  emitRoom(room);
}

function nextTheme(room) {
  const options = THEMES.filter((t) => t !== room.theme);
  room.theme = options[Math.floor(Math.random() * options.length)] || THEMES[0];
  emitRoom(room);
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload, cb) => {
    const host = { socketId: socket.id };
    const room = createRoom(host);
    socket.join(room.id);

    const result = ensurePlayer(room, socket, payload || {});
    if (result.error) return cb?.({ ok: false, error: result.error });

    emitRoom(room);
    cb?.({ ok: true, roomId: room.id, playerId: result.player.id, themes: THEMES });
  });

  socket.on('room:join', ({ roomId, name, type }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    socket.join(room.id);

    const result = ensurePlayer(room, socket, { name, type });
    if (result.error) return cb?.({ ok: false, error: result.error });

    emitRoom(room);
    cb?.({ ok: true, roomId: room.id, playerId: result.player.id, themes: THEMES });
  });

  socket.on('room:watch', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    socket.join(room.id);
    room.spectators.add(socket.id);
    emitRoom(room);
    cb?.({ ok: true, roomId: room.id });
  });

  socket.on('battle:start', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Battle already in progress' });

    beginRound(room);
    cb?.({ ok: true });
  });

  socket.on('theme:random', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Can only change theme in lobby' });

    nextTheme(room);
    cb?.({ ok: true, theme: room.theme });
  });

  socket.on('roast:submit', ({ roomId, text }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.status !== 'round') return cb?.({ ok: false, error: 'Round not active' });

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return cb?.({ ok: false, error: 'Join as a player first' });

    const cleaned = (text || '').trim().slice(0, 280);
    if (!cleaned) return cb?.({ ok: false, error: 'Roast required' });

    room.roastsByRound[room.round][player.id] = cleaned;

    const allSubmitted = room.players.every((p) => room.roastsByRound[room.round][p.id]);
    if (allSubmitted) {
      beginVoting(room);
    } else {
      emitRoom(room);
    }

    cb?.({ ok: true });
  });

  socket.on('vote:cast', ({ roomId, playerId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.status !== 'voting') return cb?.({ ok: false, error: 'Voting closed' });

    const voterKey = `voter:${socket.id}`;
    if (room.votesByRound[room.round][voterKey]) return cb?.({ ok: false, error: 'Already voted' });

    const target = room.players.find((p) => p.id === playerId);
    if (!target) return cb?.({ ok: false, error: 'Invalid vote target' });

    room.votesByRound[room.round][voterKey] = true;
    room.votesByRound[room.round][playerId] = (room.votesByRound[room.round][playerId] || 0) + 1;

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on('battle:reset', ({ roomId }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });

    room.status = 'lobby';
    room.round = 0;
    room.roastsByRound = {};
    room.votesByRound = {};
    room.totalVotes = {};
    room.lastWinner = null;
    room.roundEndsAt = null;
    room.voteEndsAt = null;
    room.players.forEach((p) => { room.totalVotes[p.id] = 0; });

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) player.isConnected = false;
      room.spectators.delete(socket.id);

      if (room.hostSocketId === socket.id && room.players.length > 0) {
        const replacement = room.players.find((p) => p.isConnected);
        if (replacement) room.hostSocketId = replacement.socketId;
      }

      emitRoom(room);
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Agent Arena running on http://localhost:${PORT}`);
  });
}

module.exports = {
  THEMES,
  createRoom,
  getPublicRoom,
  beginRound,
  beginVoting,
  finalizeRound,
  nextTheme,
  rooms,
};
