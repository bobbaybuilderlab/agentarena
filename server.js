const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROUND_MS = Number(process.env.ROUND_MS || 60_000);
const VOTE_MS = Number(process.env.VOTE_MS || 20_000);

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len);
}

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
  const roomId = shortId(6).toUpperCase();
  const room = {
    id: roomId,
    createdAt: Date.now(),
    hostSocketId: host.socketId,
    theme: THEMES[Math.floor(Math.random() * THEMES.length)],
    players: [],
    spectators: new Set(),
    status: 'lobby',
    round: 0,
    maxRounds: 3,
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
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      isBot: !!p.isBot,
      persona: p.persona || null,
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
      id: shortId(8),
      socketId: socket.id,
      name: name.trim().slice(0, 24),
      type: cleanType,
      isBot: false,
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

function addBot(room, payload = {}) {
  const bot = {
    id: shortId(8),
    name: (payload.name || `Bot-${Math.floor(Math.random() * 999)}`).slice(0, 24),
    type: 'agent',
    isBot: true,
    socketId: null,
    isConnected: true,
    persona: {
      style: payload.persona?.style || 'witty',
      intensity: payload.persona?.intensity || 6,
    },
  };
  room.players.push(bot);
  room.totalVotes[bot.id] = 0;
  return bot;
}

function generateBotRoast(theme, botName, intensity = 6) {
  const spice = intensity >= 8 ? 'nuclear' : intensity >= 5 ? 'spicy' : 'light';
  const pools = {
    'Yo Mama': [
      `Yo mama so old her startup pitch deck was chiselled into stone tablets.`,
      `Yo mama so dramatic she puts a CTA at the end of every sentence.`,
      `Yo mama so slow she still thinks dial-up is a growth channel.`,
    ],
    'Tech Twitter': [
      `You tweet 'building in public' but your only shipped feature is vibes.`,
      `Your thread starts with 1/27 and still says nothing by tweet 27.`,
      `You're not a founder, you're a screenshot curator with Wi‑Fi.`,
    ],
    'Startup Founder': [
      `Your runway is shorter than your attention span.`,
      `You've pivoted so often your cap table needs a chiropractor.`,
      `Your MVP is just a waitlist with confidence issues.`,
    ],
    'Gym Bro': [
      `You count macros but can't count to profitability.`,
      `Your pre-workout has more substance than your business plan.`,
      `You benched 225 but folded under one customer support ticket.`,
    ],
    'Crypto': [
      `You call it 'volatility'; your wallet calls it emotional damage.`,
      `You bought every dip and still found new lows.`,
      `Your alpha is just recycled copium with emojis.`,
    ],
    Corporate: [
      `You scheduled a sync to align on another sync.`,
      `Your calendar has more blockers than your product roadmap.`,
      `You say 'circle back' because moving forward scares you.`,
    ],
  };
  const lines = pools[theme] || pools['Tech Twitter'];
  const line = lines[Math.floor(Math.random() * lines.length)];
  return `[${botName} • ${spice}] ${line}`.slice(0, 280);
}

function autoSubmitBotRoasts(room) {
  const bots = room.players.filter((p) => p.isBot);
  for (const bot of bots) {
    const delay = 1000 + Math.floor(Math.random() * 7000);
    setTimeout(() => {
      const current = rooms.get(room.id);
      if (!current || current.status !== 'round' || current.round !== room.round) return;
      if (current.roastsByRound[current.round][bot.id]) return;
      const roast = generateBotRoast(current.theme, bot.name, bot.persona?.intensity || 6);
      current.roastsByRound[current.round][bot.id] = roast;
      maybeAdvanceToVoting(current);
      emitRoom(current);
    }, delay);
  }
}

function maybeAdvanceToVoting(room) {
  const allSubmitted = room.players.every((p) => room.roastsByRound[room.round][p.id]);
  if (allSubmitted) beginVoting(room);
}

function beginRound(room) {
  if (room.players.length < 2) return;
  room.status = 'round';
  room.round += 1;
  room.roastsByRound[room.round] = {};
  room.votesByRound[room.round] = {};
  room.roundEndsAt = Date.now() + ROUND_MS;

  autoSubmitBotRoasts(room);

  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'round' || current.round !== room.round) return;
    beginVoting(current);
  }, ROUND_MS);

  emitRoom(room);
}

function beginVoting(room) {
  if (room.status === 'voting') return;
  room.status = 'voting';
  room.voteEndsAt = Date.now() + VOTE_MS;
  emitRoom(room);

  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.status !== 'voting' || current.round !== room.round) return;
    finalizeRound(current);
  }, VOTE_MS);
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

  if (!winnerId && room.players.length) {
    winnerId = room.players[Math.floor(Math.random() * room.players.length)].id;
    best = 0;
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

  room.roundEndsAt = null;
  room.voteEndsAt = null;
  room.status = room.round >= room.maxRounds ? 'finished' : 'lobby';
  emitRoom(room);
}

function nextTheme(room) {
  const options = THEMES.filter((t) => t !== room.theme);
  room.theme = options[Math.floor(Math.random() * options.length)] || THEMES[0];
  emitRoom(room);
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload, cb) => {
    const room = createRoom({ socketId: socket.id });
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

  socket.on('bot:add', ({ roomId, name, persona }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: 'Host only' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Only in lobby' });

    const bot = addBot(room, { name, persona });
    emitRoom(room);
    cb?.({ ok: true, botId: bot.id });
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
    maybeAdvanceToVoting(room);
    emitRoom(room);

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
        const replacement = room.players.find((p) => p.isConnected && !p.isBot);
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
  app,
  server,
  io,
  THEMES,
  ROUND_MS,
  VOTE_MS,
  createRoom,
  getPublicRoom,
  beginRound,
  beginVoting,
  finalizeRound,
  nextTheme,
  addBot,
  generateBotRoast,
  rooms,
};
