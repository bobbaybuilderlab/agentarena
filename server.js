const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

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

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
const pairVotes = new Map();
const humanVoteTimes = new Map();
const sessions = new Map();
const connectSessions = new Map();

function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const serializable = {
      agents: [...agentProfiles.values()],
      roastFeed,
      votes: [...votes],
      pairVotes: [...pairVotes.entries()],
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
    (parsed.pairVotes || []).forEach(([k, v]) => pairVotes.set(k, v));
  } catch (err) {
    console.error('loadState failed', err.message);
  }
}

function registerRoast({ battleId, agentId, agentName, text }) {
  const roast = {
    id: shortId(10),
    battleId,
    agentId,
    agentName,
    text: String(text || '').slice(0, 280),
    upvotes: 0,
    createdAt: Date.now(),
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
    const roastText = generateBotRoast(theme, agent.name, intensity);
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
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });

  const id = shortId(10);
  const profile = {
    id,
    owner: String(req.body?.owner || 'anonymous').slice(0, 64),
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
  const voterHumanId = req.body?.voterHumanId ? String(req.body.voterHumanId) : null;
  const voterKey = voterAgentId ? `a:${voterAgentId}` : voterHumanId ? `h:${voterHumanId}` : null;

  if (!voterKey) return res.status(400).json({ ok: false, error: 'voter required' });
  if (voterAgentId && voterAgentId === roast.agentId) {
    return res.status(400).json({ ok: false, error: 'self vote blocked' });
  }

  const key = `${voterKey}:${roast.id}`;
  if (votes.has(key)) return res.status(409).json({ ok: false, error: 'already voted' });

  if (voterHumanId) {
    const now = Date.now();
    const events = humanVoteTimes.get(voterHumanId) || [];
    const recent = events.filter((t) => now - t < 60_000);
    if (recent.length >= 20) return res.status(429).json({ ok: false, error: 'rate limit: too many votes/min' });
    recent.push(now);
    humanVoteTimes.set(voterHumanId, recent);
  }

  if (voterAgentId) {
    const pairKey = `${voterAgentId}->${roast.agentId}`;
    const count = pairVotes.get(pairKey) || 0;
    if (count >= 3) return res.status(429).json({ ok: false, error: 'pair voting cap reached' });
    pairVotes.set(pairKey, count + 1);
  }

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

loadState();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, agents: agentProfiles.size, roasts: roastFeed.length });
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
  beginRound,
  beginVoting,
  finalizeRound,
  nextTheme,
  addBot,
  generateBotRoast,
  rooms,
};
