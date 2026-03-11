# IMPLEMENTATION_PLAN.md — Guess the Agent

## Overview

**Total estimate:** ~14–18 hours of focused engineering  
**Target:** MVP ship-ready, passes all acceptance criteria  
**No code is written until this plan is reviewed and refined.**

---

## Step 0: Pre-conditions

Before starting, confirm:
- [ ] `/Users/bobbybola/Desktop/agent-arena` is the working directory
- [ ] `node_modules` is installed (`npm install`)
- [ ] Server runs cleanly (`node server.js` with no errors)
- [ ] Existing tests pass (`npm test`)

---

## Step 1: Prompt Bank

**File:** `games/guess-the-agent/prompts.js`  
**Estimate:** 1 hour  

Create a module that exports categorised prompt arrays.

```js
// games/guess-the-agent/prompts.js
const PROMPTS = {
  C: [ /* 15+ creative/easy prompts */ ],
  B: [ /* 15+ opinion/medium prompts */ ],
  A: [ /* 15+ emotional/hard prompts */ ],
};

function selectGamePrompts() {
  // Returns [roundOnePrompt, roundTwoPrompt, roundThreePrompt]
  // Round 1: Category C, Round 2: B or A, Round 3: A
  // No duplicates
}

module.exports = { PROMPTS, selectGamePrompts };
```

**Acceptance criteria:**
- [ ] 45+ total prompts
- [ ] `selectGamePrompts()` returns 3 non-duplicate prompts
- [ ] Mix of categories per game

---

## Step 2: Game Logic Module

**File:** `games/guess-the-agent/index.js`  
**Estimate:** 4 hours  

Implement the pure game logic module. Zero I/O — no socket.io, no express, no file system.

### 2.1 Core Functions

Implement in this order:

**a) `createStore()`**
```js
function createStore() { return new Map(); }
```

**b) `createRoom(store, { hostName, hostSocketId })`**
```js
// Creates room with id, status:'lobby', phase:'lobby'
// Assigns hostPlayerId
// Returns { ok, room, player }
```

**c) `joinRoom(store, { roomId, name, socketId, type })`**
```js
// type: 'human' | 'agent'
// Enforces: max 1 human, max 6 players total
// Reconnect-aware: matches by socketId first, then by (type + name)
// Returns { ok, room, player }
// Error codes: ROOM_NOT_FOUND, ROOM_ALREADY_STARTED, ROOM_FULL,
//              HUMAN_SLOT_TAKEN, NAME_IN_USE, SOCKET_ALREADY_JOINED
```

**d) `startGame(store, { roomId, hostPlayerId })`**
```js
// Validates: host, status===lobby, exactly 1 human, ≥2 agents, total ≥3
// Assigns roles: human player gets role:'human', all others role:'agent'
// Calls selectGamePrompts() → sets room.prompts[]
// Sets room.currentPrompt = room.prompts[0]
// Sets room.round = 1
// Transitions: lobby → prompt (status: in_progress)
// Sets room.roundEndsAt = Date.now() + PROMPT_MS
// Returns { ok, room }
```

**e) `submitResponse(store, { roomId, playerId, text })`**
```js
// Validates: in_progress, phase===prompt, player exists and alive
// Text: trim, max 280 chars (already moderated before calling this)
// Stores in room.responsesByRound[room.round][playerId]
// If all alive players submitted → call advanceToReveal(room)
// Returns { ok, room, advanced: Boolean }
```

**f) `castVote(store, { roomId, voterId, targetId })`**
```js
// Validates: in_progress, phase===vote, voter exists and alive
// Blocks: self-vote, duplicate vote by same voter
// Stores in room.votesByRound[room.round][voterId] = targetId
// If all alive agents voted → call resolveRound(room)
// Returns { ok, room, resolved: Boolean }
```

**g) `forceAdvance(store, { roomId })`**
```js
// Handles all timer-driven phase advances:
//   prompt → reveal (submit empty for non-respondents)
//   reveal → vote
//   vote → result (treat abstentions, then resolveRound)
//   result → prompt (next round) OR finished
// Returns { ok, room }
```

**h) `resolveRound(room)` — internal**
```js
// Count votes, find majority winner
// If winner is human → finish(room, 'agents')
// If winner is agent → mark alive=false, store in eliminatedByRound
// If no majority → no elimination
// Set room.phase = 'result'
// Returns room (mutated)
```

**i) `advanceToReveal(room)` — internal**
```js
// Sets phase to 'reveal'
// Sets room.roundEndsAt = Date.now() + REVEAL_MS
```

**j) `finish(room, winner)` — internal**
```js
// Sets status:'finished', phase:'finished'
// Sets room.winner = winner
// Sets room.humanPlayerId (for reveal in toPublic)
// Logs GAME_FINISHED event
```

**k) `prepareRematch(store, { roomId, hostPlayerId })`**
```js
// Validates: status===finished, isHost
// Resets: round=0, phase='lobby', status='lobby', all player alive=true
// Clears responsesByRound, votesByRound, eliminatedByRound, winner
// Increments partyStreak
// Returns { ok, room }
```

**l) `addLobbyBots(store, { roomId, count, namePrefix })`**
```js
// Adds 'agent' type bots, each with isBot:true
// Max 6 total players
// Returns { ok, room, bots }
```

**m) `disconnectPlayer(store, { roomId, socketId })`**
```js
// Sets player.isConnected = false
// Returns Boolean (changed)
```

**n) `toPublic(room, { forPlayerId } = {})`**
```js
// CRITICAL SECURITY: role hidden until status==='finished'
// Exception: player sees own role (forPlayerId === p.id)
// humanPlayerId hidden until finished
// responsesByRound: hidden during prompt phase, shown after
// votesByRound: hidden until result phase of that round
```

### 2.2 Room State Shape
```js
const room = {
  id: String,
  partyChainId: String,
  partyStreak: Number,
  status: 'lobby' | 'in_progress' | 'finished',
  phase: 'lobby' | 'prompt' | 'reveal' | 'vote' | 'result' | 'finished',
  hostPlayerId: String,
  hostSocketId: String,
  round: Number,          // 1-indexed, 0 in lobby
  maxRounds: Number,      // 3 default
  prompts: [String],      // 3 prompts selected at startGame
  currentPrompt: String,
  players: Array,
  responsesByRound: {},   // { round: { playerId: text } }
  votesByRound: {},       // { round: { voterId: targetId } }
  eliminatedByRound: {},  // { round: playerId | null }
  roundEndsAt: Number | null,
  winner: 'human' | 'agents' | null,
  humanPlayerId: String | null,  // set at game end
  spectators: Set,
  events: Array,
  createdAt: Number,
};
```

**Acceptance criteria:**
- [ ] All functions return `{ ok: Boolean, error?: { code, message } }`
- [ ] `toPublic()` never leaks role or humanPlayerId before game end
- [ ] 1 human cap enforced in `joinRoom()`
- [ ] `forceAdvance()` handles all phases without crashing
- [ ] `resolveRound()` correctly identifies human elimination
- [ ] Tests pass (see Step 6)

---

## Step 3: Server Integration

**File:** `server.js`  
**Estimate:** 3 hours  

### 3.1 Module Registration (top of file)

```js
// Add after existing game requires
const gtaGame = require('./games/guess-the-agent');
// ...
const gtaRooms = gtaGame.createStore();
```

### 3.2 Constants

```js
const GTA_PROMPT_MS = Number(process.env.GTA_PROMPT_MS || 45_000);
const GTA_REVEAL_MS = Number(process.env.GTA_REVEAL_MS || 15_000);
const GTA_VOTE_MS = Number(process.env.GTA_VOTE_MS || 20_000);
const GTA_RESULT_MS = Number(process.env.GTA_RESULT_MS || 8_000);
const GTA_RECONNECT_MS = Number(process.env.GTA_RECONNECT_MS || 30_000);
```

### 3.3 Helper Functions

```js
function emitGtaRoom(room) {
  // 1. Broadcast sanitised state (no roles) to entire room
  io.to(`gta:${room.id}`).emit('gta:state', gtaGame.toPublic(room));
  // 2. Send role-aware state to each individual socket
  for (const player of room.players) {
    if (player.socketId && !player.isBot) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) sock.emit('gta:state:self', gtaGame.toPublic(room, { forPlayerId: player.id }));
    }
  }
}
```

```js
function scheduleGtaPhase(room) {
  if (room.status !== 'in_progress') return;

  roomScheduler.clear({ namespace: 'gta', roomId: room.id, slot: 'phase' });

  if (room.phase === 'prompt') {
    // Schedule bot responses
    const bots = room.players.filter(p => p.isBot && p.alive);
    for (const bot of bots) {
      if (room.responsesByRound[room.round]?.[bot.id]) continue;
      const delay = 2000 + Math.random() * 8000;
      roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: `respond:${room.round}:${bot.id}`, delayMs: delay, token: `${room.round}:prompt` }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.phase !== 'prompt' || r.round !== room.round) return;
        if (r.responsesByRound[r.round]?.[bot.id]) return;
        const text = generateBotRoast(r.currentPrompt, bot, 6, 'thoughtful');
        const result = gtaGame.submitResponse(gtaRooms, { roomId: r.id, playerId: bot.id, text });
        if (result.ok) { logRoomEvent('gta', r, 'BOT_RESPONDED', { botId: bot.id, round: r.round }); emitGtaRoom(r); }
      });
    }
    // Phase deadline
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_PROMPT_MS, token: `${room.round}:prompt` }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'prompt' || r.round !== room.round) return;
      gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      emitGtaRoom(r);
      scheduleGtaPhase(r);
    });
  }

  if (room.phase === 'reveal') {
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_REVEAL_MS, token: `${room.round}:reveal` }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'reveal' || r.round !== room.round) return;
      gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      emitGtaRoom(r);
      scheduleGtaPhase(r);
    });
  }

  if (room.phase === 'vote') {
    // Schedule bot votes
    const aliveBots = room.players.filter(p => p.isBot && p.alive);
    for (const bot of aliveBots) {
      if (room.votesByRound[room.round]?.[bot.id]) continue;
      const delay = 5000 + Math.random() * 10000;
      roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: `vote:${room.round}:${bot.id}`, delayMs: delay, token: `${room.round}:vote` }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.phase !== 'vote' || r.round !== room.round) return;
        if (r.votesByRound[r.round]?.[bot.id]) return;
        const targetId = pickHumanSuspect(r, bot.id);
        if (!targetId) return;
        const result = gtaGame.castVote(gtaRooms, { roomId: r.id, voterId: bot.id, targetId });
        if (result.ok) { logRoomEvent('gta', r, 'BOT_VOTED', { botId: bot.id, targetId, round: r.round }); emitGtaRoom(r); scheduleGtaPhase(r); }
      });
    }
    // Phase deadline
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_VOTE_MS, token: `${room.round}:vote` }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'vote' || r.round !== room.round) return;
      gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      emitGtaRoom(r);
      scheduleGtaPhase(r);
    });
  }

  if (room.phase === 'result') {
    if (room.status === 'finished') {
      recordFirstMatchCompletion('gta', room.id);
      return;
    }
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_RESULT_MS, token: `${room.round}:result` }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'result') return;
      gtaGame.forceAdvance(gtaRooms, { roomId: r.id }); // → next prompt
      emitGtaRoom(r);
      scheduleGtaPhase(r);
    });
  }
}
```

```js
function pickHumanSuspect(room, botId) {
  // Heuristic: score responses for humanness signals
  // Returns the playerId of the most suspicious non-self alive player
  const round = room.round;
  const responses = room.responsesByRound[round] || {};
  const candidates = room.players.filter(p => p.alive && p.id !== botId && !room.votesByRound[round]?.[p.id]);
  if (!candidates.length) return null;

  const scored = candidates.map(p => {
    const text = responses[p.id] || '';
    let score = 0;
    if (/\b(i|me|my|mine)\b/i.test(text)) score += 2;
    if (/\b(honestly|actually|tbh|ngl|literally)\b/i.test(text)) score += 3;
    if (/\b(lol|haha|hahaha|omg|wtf|lmao)\b/i.test(text)) score += 4;
    if (text.length < 50 || text.length > 300) score += 1;
    if (/\b(um|uh|hmm|well|like)\b/i.test(text)) score += 2;
    if (/\.\.\.|!!|!!!/g.test(text)) score += 2;
    return { id: p.id, score };
  });

  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return scored[0]?.id || null;
}
```

### 3.4 Socket Event Handlers

Add inside `io.on('connection', (socket) => {`:

```js
socket.on('gta:room:create', ({ name, type }, cb) => {
  const created = gtaGame.createRoom(gtaRooms, { hostName: name, hostSocketId: socket.id });
  if (!created.ok) return cb?.(created);
  socket.join(`gta:${created.room.id}`);
  logRoomEvent('gta', created.room, 'ROOM_CREATED', { status: created.room.status, phase: created.room.phase });
  // Join host as player
  const joined = gtaGame.joinRoom(gtaRooms, { roomId: created.room.id, name, socketId: socket.id, type: type || 'agent' });
  emitGtaRoom(created.room);
  cb?.({ ok: true, roomId: created.room.id, playerId: joined.ok ? joined.player.id : created.player?.id });
});

socket.on('gta:room:join', ({ roomId, name, type, claimToken }, cb) => {
  const normalizedRoomId = String(roomId || '').trim().toUpperCase();
  if (normalizedRoomId && gtaRooms.has(normalizedRoomId)) recordJoinAttempt('gta', normalizedRoomId);
  const reconnect = resolveReconnectJoinName('gta', roomId, name, claimToken);
  const joined = gtaGame.joinRoom(gtaRooms, { roomId: normalizedRoomId, name: reconnect.name, socketId: socket.id, type: type || 'agent' });
  if (!joined.ok) {
    if (joined.error?.code === 'SOCKET_ALREADY_JOINED') recordJoinHardeningEvent('gta', normalizedRoomId, socket.id, reconnect.name);
    return cb?.(joined);
  }
  if (reconnect.consumedClaimToken) consumeReconnectClaimTicket('gta', joined.room.id, reconnect.consumedClaimToken);
  socket.join(`gta:${joined.room.id}`);
  recordQuickJoinConversion('gta', joined.room.id, joined.player.name);
  logRoomEvent('gta', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, type: joined.player.role });
  emitGtaRoom(joined.room);
  cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, state: gtaGame.toPublic(joined.room, { forPlayerId: joined.player.id }) });
});

socket.on('gta:autofill', ({ roomId, playerId, minPlayers }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
  if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
  const result = autoFillLobbyBots('gta', room.id, minPlayers || 6);
  if (!result.ok) return cb?.(result);
  cb?.({ ok: true, addedBots: result.addedBots, state: gtaGame.toPublic(result.room) });
});

socket.on('gta:start', ({ roomId, playerId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
  if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY', message: 'Host only' } });
  const started = gtaGame.startGame(gtaRooms, { roomId, hostPlayerId: playerId });
  if (!started.ok) return cb?.(started);
  logRoomEvent('gta', started.room, 'GAME_STARTED', { status: started.room.status, phase: started.room.phase, round: started.room.round });
  emitGtaRoom(started.room);
  scheduleGtaPhase(started.room);
  cb?.({ ok: true, state: gtaGame.toPublic(started.room) });
});

socket.on('gta:action', ({ roomId, playerId, type, text, targetId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
  if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN', message: 'Cannot act as another player' } });

  if (type === 'respond') {
    const moderated = moderateRoast(text || '', { maxLength: 280 });
    if (!moderated.ok) return cb?.({ ok: false, error: { code: 'CONTENT_REJECTED', message: moderated.code } });
    const result = gtaGame.submitResponse(gtaRooms, { roomId, playerId, text: moderated.text });
    if (!result.ok) return cb?.(result);
    logRoomEvent('gta', result.room, 'RESPONSE_SUBMITTED', { actorId: playerId, round: result.room.round });
    emitGtaRoom(result.room);
    if (result.advanced) scheduleGtaPhase(result.room);
    return cb?.({ ok: true });
  }

  if (type === 'vote') {
    const result = gtaGame.castVote(gtaRooms, { roomId, voterId: playerId, targetId });
    if (!result.ok) return cb?.(result);
    logRoomEvent('gta', result.room, 'VOTE_CAST', { actorId: playerId, targetId, round: result.room.round });
    if (result.room.status === 'finished') recordFirstMatchCompletion('gta', result.room.id);
    emitGtaRoom(result.room);
    scheduleGtaPhase(result.room);
    return cb?.({ ok: true });
  }

  return cb?.({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action type' } });
});

socket.on('gta:rematch', ({ roomId, playerId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
  if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN' } });
  roomScheduler.clearRoom(String(roomId || '').toUpperCase(), 'gta');
  const reset = gtaGame.prepareRematch(gtaRooms, { roomId, hostPlayerId: playerId });
  if (!reset.ok) return cb?.(reset);
  // Human randomly reassigned or same — for MVP, same human stays
  logRoomEvent('gta', reset.room, 'REMATCH_STARTED', { status: reset.room.status });
  emitGtaRoom(reset.room);
  cb?.({ ok: true, state: gtaGame.toPublic(reset.room) });
});
```

### 3.5 Disconnect Handler

Add inside `disconnect` handler:
```js
for (const room of gtaRooms.values()) {
  const changed = gtaGame.disconnectPlayer(gtaRooms, { roomId: room.id, socketId: socket.id });
  if (changed) {
    // If disconnected player is human during in_progress → start reconnect timer
    const player = room.players.find(p => p.socketId === socket.id);
    if (player && player.role === 'human' && room.status === 'in_progress') {
      roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'human-reconnect', delayMs: GTA_RECONNECT_MS }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.status !== 'in_progress') return;
        const hp = r.players.find(p => p.role === 'human');
        if (hp && !hp.isConnected) {
          // Auto-win for agents
          gtaGame._forceAgentsWin(gtaRooms, { roomId: r.id }); // internal method
          logRoomEvent('gta', r, 'HUMAN_ABANDONED', { humanId: hp.id });
          recordFirstMatchCompletion('gta', r.id);
          emitGtaRoom(r);
        }
      });
    }
    emitGtaRoom(room);
  }
}
```

### 3.6 `getLobbyStore()` Update

```js
function getLobbyStore(mode) {
  return mode === 'amongus' ? amongUsRooms
    : mode === 'mafia' ? mafiaRooms
    : mode === 'villa' ? villaRooms
    : mode === 'gta' ? gtaRooms    // ADD THIS
    : null;
}
```

### 3.7 `autoFillLobbyBots()` Update

Add 'gta' case:
```js
if (mode === 'gta') {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED' } };
  const needed = Math.max(0, safeMinPlayers - room.players.length);
  const added = gtaGame.addLobbyBots(gtaRooms, { roomId: room.id, count: needed, namePrefix: 'Agent Bot' });
  if (!added.ok) return added;
  logRoomEvent('gta', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length });
  emitGtaRoom(room);
  return { ok: true, mode, room, addedBots: added.bots.length, targetPlayers: safeMinPlayers };
}
```

### 3.8 `listPlayableRooms()` Update

Add 'gta' to the room listing:
```js
const gta = modeFilter === 'all' || modeFilter === 'gta'
  ? [...gtaRooms.values()].map(room => summarizePlayableRoom('gta', room))
  : [];
let roomsList = [...mafia, ...amongus, ...villa, ...gta];
```

### 3.9 Stale Room Cleanup

Add `gtaRooms` to `sweep()` calls in `cleanupStaleRooms()`:
```js
sweep(gtaRooms, 'gta');
```

**Acceptance criteria:**
- [ ] Server starts without errors after changes
- [ ] `gta:room:create` creates a room and returns roomId
- [ ] `gta:room:join` with type:'human' stores role correctly
- [ ] `gta:room:join` with type:'human' when human slot taken returns HUMAN_SLOT_TAKEN error
- [ ] `gta:start` transitions to in_progress and schedules bot responses
- [ ] `gta:action { type:'respond' }` stores response and emits state
- [ ] `gta:action { type:'vote' }` stores vote and triggers resolution if threshold met
- [ ] `emitGtaRoom` sends role-aware state to each player's socket
- [ ] `toPublic()` does NOT include role for other players during in_progress

---

## Step 4: Frontend

**Files:** `public/guess-the-agent.html`, `public/guess-the-agent.js`  
**Estimate:** 4 hours  

### 4.1 HTML Structure

Create `public/guess-the-agent.html` based on `public/play.html` as template:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Guess the Agent — Agent Arena</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/styles.css" />
  <style>
    /* GTA-specific overrides */
    body.page-gta { /* custom background */ }
    .gta-timer { /* timer bar */ }
    .gta-response-card { /* response cards */ }
    .gta-player { /* player row */ }
    /* all from UI_UX_SPEC.md */
  </style>
</head>
<body class="page-play page-gta">
  <nav class="topnav">...</nav>
  
  <!-- 7 phase containers -->
  <div id="phase-join" class="phase">...</div>
  <div id="phase-lobby" class="phase" hidden>...</div>
  <div id="phase-prompt" class="phase" hidden>...</div>
  <div id="phase-reveal" class="phase" hidden>...</div>
  <div id="phase-vote" class="phase" hidden>...</div>
  <div id="phase-result" class="phase" hidden>...</div>
  <div id="phase-finished" class="phase" hidden>...</div>

  <script src="https://cdn.socket.io/4.7.4/socket.io.min.js"></script>
  <script src="/config.js"></script>
  <script src="/guess-the-agent.js"></script>
</body>
</html>
```

### 4.2 JavaScript State Machine (`guess-the-agent.js`)

```js
// State
let socket, myPlayerId, myRole, myRoomId, timerInterval;
let currentState = null;

// Connection
const BACKEND = window.ARENA_CONFIG?.backendUrl || 'http://localhost:3000';
socket = io(BACKEND);

// Phase rendering
function render(state) {
  currentState = state;
  hideAllPhases();
  
  switch (state.phase) {
    case 'lobby':    return renderLobby(state);
    case 'prompt':   return renderPrompt(state);
    case 'reveal':   return renderReveal(state);
    case 'vote':     return renderVote(state);
    case 'result':   return renderResult(state);
    case 'finished': return renderFinished(state);
  }
}

// Listen for state updates
socket.on('gta:state', render);
socket.on('gta:state:self', state => {
  myRole = state.players.find(p => p.id === myPlayerId)?.role;
  render(state);
});

// Timer
function startTimer(endsAt) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, endsAt - Date.now());
    updateTimerDisplay(remaining);
    if (remaining === 0) clearInterval(timerInterval);
  }, 100);
}
```

### 4.3 Phase Renderers

Implement one render function per phase following UI_UX_SPEC.md wireframes:

- `renderJoin()` — form for name, room code, type radio buttons
- `renderLobby(state)` — player list, fill/start buttons, copy link
- `renderPrompt(state)` — prompt card, textarea, submit button, timer
- `renderReveal(state)` — anonymous responses list, timer
- `renderVote(state)` — named response cards with vote buttons, live tally
- `renderResult(state)` — elimination result card, vote breakdown
- `renderFinished(state)` — winner reveal animation, full breakdown

### 4.4 Action Emitters

```js
function joinRoom(roomId, name, type) {
  socket.emit('gta:room:join', { roomId, name, type }, cb => {
    if (!cb.ok) return showError(cb.error);
    myPlayerId = cb.playerId;
    myRoomId = cb.roomId;
  });
}

function submitResponse(text) {
  socket.emit('gta:action', { roomId: myRoomId, playerId: myPlayerId, type: 'respond', text }, cb => {
    if (!cb.ok) return showError(cb.error);
    document.getElementById('submitBtn').textContent = 'Submitted ✓';
    document.getElementById('submitBtn').disabled = true;
  });
}

function castVote(targetId) {
  socket.emit('gta:action', { roomId: myRoomId, playerId: myPlayerId, type: 'vote', targetId }, cb => {
    if (!cb.ok) return showError(cb.error);
    highlightVotedCard(targetId);
  });
}
```

**Acceptance criteria:**
- [ ] Page loads at `/guess-the-agent.html`
- [ ] Can join as human or agent
- [ ] Role reveal modal shows on join
- [ ] Prompt phase: timer counts down, can type and submit response
- [ ] Reveal phase: anonymous responses shown, timer auto-advances
- [ ] Vote phase: named responses shown, can click Vote
- [ ] Result phase: shows who was eliminated (or no elimination)
- [ ] Finished phase: human identity revealed
- [ ] Mobile layout works at 375px width

---

## Step 5: Navigation Integration

**Files:** `public/index.html`, `public/games.js` (or equivalent)  
**Estimate:** 30 minutes  

Add GTA to the homepage game cards:

```html
<!-- In public/index.html game cards section -->
<a class="game-card" href="/guess-the-agent.html">
  <div class="game-card-icon">🕵️</div>
  <h3>Guess the Agent</h3>
  <p>One human. Five AIs. Can you blend in?</p>
  <span class="badge badge-new">New</span>
</a>
```

Add to `public/games.js` game modes array if it exists.

---

## Step 6: Tests

**File:** `test/guess-the-agent.test.js`  
**Estimate:** 2 hours  

Write unit tests covering:

```js
describe('Guess the Agent', () => {
  // createRoom / joinRoom
  test('creates room with 6-char ID');
  test('first human join succeeds');
  test('second human join returns HUMAN_SLOT_TAKEN');
  test('7th player join returns ROOM_FULL');
  test('reconnect by socketId updates existing player');
  
  // startGame
  test('startGame assigns prompts');
  test('startGame requires exactly 1 human');
  test('startGame transitions to prompt phase');
  
  // submitResponse
  test('submitResponse stores text');
  test('all players submitting triggers reveal phase');
  test('duplicate response rejected');
  
  // castVote
  test('castVote stores vote');
  test('self-vote rejected');
  test('duplicate vote rejected');
  test('3 votes on human triggers agents win');
  test('3 votes on agent eliminates agent, continues game');
  test('no majority = no elimination');
  
  // forceAdvance
  test('prompt → reveal via forceAdvance');
  test('reveal → vote via forceAdvance');
  test('vote → result via forceAdvance');
  test('result → prompt via forceAdvance (if rounds remain)');
  test('result → finished via forceAdvance (final round)');
  
  // toPublic
  test('role hidden during in_progress');
  test('role revealed after finished');
  test('humanPlayerId hidden until finished');
  test('own role visible via forPlayerId');
  
  // prepareRematch
  test('reset clears responses and votes');
  test('increments partyStreak');
});
```

**Acceptance criteria:**
- [ ] All tests pass
- [ ] No role leakage in toPublic() tested explicitly

---

## Step 7: Smoke Test

**Estimate:** 1 hour  

Manual end-to-end test:

1. Start server: `node server.js`
2. Open browser: `http://localhost:3000/guess-the-agent.html`
3. Create room as human
4. Fill with bots
5. Start game
6. Submit response each round
7. Vote in each round
8. Verify game ends correctly (human survives or eliminated)
9. Play Again — verify rematch works
10. Test disconnection: close tab during game → verify reconnect window

---

## Step 8: Deploy

**Estimate:** 30 minutes  

```bash
# Build frontend (if build step exists)
npm run build   # or just push — Vercel auto-deploys

# Deploy server (if separate)
# GTA uses same server.js — no new deploy steps needed

# Verify production
curl https://agent-arena-vert.vercel.app/guess-the-agent.html
```

Environment variables to add:
```
GTA_PROMPT_MS=45000
GTA_REVEAL_MS=15000
GTA_VOTE_MS=20000
GTA_RESULT_MS=8000
GTA_RECONNECT_MS=30000
```

---

## File Manifest

| File | Action | Description |
|------|--------|-------------|
| `games/guess-the-agent/index.js` | CREATE | Game logic module |
| `games/guess-the-agent/prompts.js` | CREATE | Prompt bank |
| `games/guess-the-agent/README.md` | CREATE | Mode documentation |
| `public/guess-the-agent.html` | CREATE | Frontend page |
| `public/guess-the-agent.js` | CREATE | Frontend client |
| `server.js` | MODIFY | Register game module, add socket events |
| `public/index.html` | MODIFY | Add GTA game card |
| `test/guess-the-agent.test.js` | CREATE | Unit tests |

---

## Time Estimates Summary

| Step | Task | Hours |
|------|------|-------|
| 1 | Prompt bank | 1.0 |
| 2 | Game logic module | 4.0 |
| 3 | Server integration | 3.0 |
| 4 | Frontend | 4.0 |
| 5 | Navigation integration | 0.5 |
| 6 | Tests | 2.0 |
| 7 | Smoke test | 1.0 |
| 8 | Deploy | 0.5 |
| **Total** | | **16 hours** |

---

## Acceptance Criteria (Full)

- [ ] Human can join from browser with no CLI needed
- [ ] Bots auto-fill agent slots
- [ ] Game runs 3 rounds without crashing
- [ ] Role never leaks to other players before game end
- [ ] Human identity revealed dramatically at game end
- [ ] Timer counts down correctly on client
- [ ] Bot responses and votes generate automatically
- [ ] Mobile layout works (375px+)
- [ ] Rematch resets game state correctly
- [ ] All unit tests pass
- [ ] Server handles disconnect gracefully
- [ ] Analytics events fire for ROOM_CREATED, GAME_STARTED, MATCH_FINISHED
