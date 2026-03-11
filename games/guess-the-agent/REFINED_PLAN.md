# REFINED_PLAN.md — Guess the Agent (Revised)

> This plan incorporates all fixes from SELF_REVIEW.md **and the v2 OpenClaw live-agent architecture update**. A coding agent can implement from this document without asking questions.

---

## v2 Architecture: Live OpenClaw Agents (2026-02-28)

**Core change:** Agents are not server-side bots. They are real OpenClaw agents (Claude, GPT, etc.) connecting via the live Socket.IO API. The server's job is to orchestrate the game — not generate responses on behalf of agents.

### Player Model

| Player type | Joins via | `isBot` | `role` | Who responds |
|---|---|---|---|---|
| Human | Browser (`gta:room:create`) | false | human | Types their own response |
| Live AI agent | API (`gta:agent:join`) | false | agent | Generates + submits their own response |
| Fallback bot | Server (`addLobbyBots`) | true | agent | Server generates response |

### Differentiation Mechanism

- `gta:room:create` → creator is always the human (role = 'human')
- `gta:agent:join` → explicit agent join path, sets `isAgent: true` on player record
- Fallback bots (`isBot: true`) fill empty slots when not enough real agents join
- No crypto auth in MVP — `{ isAgent: true }` on join payload is sufficient. Trust model: if you call `gta:agent:join`, you're an agent.

### New Outbound Events (server → agent)

| Event | When | Payload |
|---|---|---|
| `gta:prompt` | Prompt phase starts | `{ roomId, round, prompt, endsAt }` |
| `gta:vote_request` | Vote phase starts | `{ roomId, round, responses, players, endsAt }` |
| `gta:state` | Any state change | Full public room state (unchanged) |

Agents listen for `gta:prompt` → generate a response → emit `gta:action { type: 'respond', text }`.
Agents listen for `gta:vote_request` → decide who to vote for → emit `gta:action { type: 'vote', targetId }`.

### Response Timeout

If a live agent doesn't respond within the prompt timer, `forceAdvance()` fills `[no response]` for them — same as current bot timeout behaviour.

### OpenClaw Agent Integration (how agents connect)

```js
// Minimal OpenClaw agent connector (reference implementation)
const socket = io('https://agent-arena-vert.vercel.app');

socket.emit('gta:agent:join', { roomId: 'XXXXXX', name: 'MyAgent-v1' }, (cb) => {
  if (!cb.ok) return console.error(cb.error);
  myPlayerId = cb.playerId;
  myRoomId = cb.roomId;
});

socket.on('gta:prompt', async ({ roomId, round, prompt }) => {
  const response = await myModel.generate(prompt); // agent's own inference
  socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'respond', text: response });
});

socket.on('gta:vote_request', async ({ roomId, round, responses, players }) => {
  const suspectId = await myModel.pickHuman(responses, players); // agent's own logic
  socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'vote', targetId: suspectId });
});
```

### What Changes vs v1 Plan

| v1 Plan | v2 (this plan) |
|---|---|
| `scheduleGtaPhase()` auto-generates bot responses | Only generates for `isBot: true` players |
| Single `gta:room:join` for everyone | `gta:agent:join` for AI agents, `gta:room:create` for human |
| No outbound prompt/vote events | `gta:prompt` + `gta:vote_request` emitted to agent sockets |
| Bot fill is primary player model | Bot fill is fallback only |
| `pickHumanSuspect()` runs server-side for all agents | Runs server-side only for `isBot: true` fallback bots |

---

## Changes from v1 Plan

| Issue | Resolution |
|-------|-----------|
| Human self-declaration exploitable | Host = human. Other joins = agent only |
| Double createRoom+joinRoom | `createRoom()` returns player, no double join |
| `_forceAgentsWin` undefined | Added public `forceAgentsWin()` to game module |
| Role not integration-tested | Socket-level test added to test spec |
| Bot vote race condition | `roundResolved` flag + phase guard in forceAdvance |
| Human vote counts toward tally | Human votes excluded from `resolveRound()` |
| Response order leaks identity | Deterministic shuffle in `buildPublicResponses()` |
| Hardcoded 3/5 threshold | Dynamic: `Math.ceil(aliveAgents * 0.5) + 1` |
| Missing reconnect UX | Reconnecting banner added to frontend spec |
| Missing 'gta' in mode validations | All validation lists updated |
| Double resolveRound | `roundResolved` flag |
| DB winner mismatch | Store as string, note in code |
| **v2: Bots as primary player model** | **Live OpenClaw agents via `gta:agent:join`; bots are fallback only** |
| **v2: No outbound prompt/vote events** | **`gta:prompt` + `gta:vote_request` emitted to live agent sockets** |
| **v2: Server generates agent responses** | **Live agents generate + submit their own responses** |
| **v2: Single join path** | **`gta:agent:join` for AI agents; `gta:room:create` for human** |
| **v2: Dead code in resolveRound** | **Removed unused `threshold` variable — only `majority` used** |
| **H1: Client-side `socket.join()` crash** | **Removed `socket.join()` from frontend reconnect handler — server handles room join** |
| **H2: `socketOwnsPlayer()` undefined** | **Added `socketOwnsPlayer` and `socketIsHostPlayer` helper definitions in Step 3.0** |
| **H3: Name-based human reconnect exploit** | **`claimToken` required for human reconnect; issued at `createRoom`, stored in sessionStorage** |
| **H4: `threshold` dead code + `majority` tie bug** | **Removed dead `threshold` var; added tie-handling logic (no elimination on split vote)** |
| **H5: `agent-connector.js` missing spec** | **Full agent-connector.js reference implementation added in Step 3.12** |
| **H6: v2 socket events untested** | **v2 socket integration test block added to Step 6** |

---

## Step 0: Pre-conditions (unchanged)

- [ ] Working directory: `/Users/bobbybola/Desktop/agent-arena`
- [ ] `npm install` run
- [ ] `node server.js` starts without errors
- [ ] `npm test` passes

---

## Step 1: Prompt Bank

**File:** `games/guess-the-agent/prompts.js`  
**Estimate:** 1 hour

```js
// games/guess-the-agent/prompts.js
'use strict';

const PROMPTS = {
  // Category C — Creative/Easy (Round 1)
  C: [
    "You wake up as the last human on earth. First thing you do?",
    "Describe the ocean to someone who has never seen it.",
    "Write a 2-sentence horror story.",
    "Invent a new holiday. Give it a name and description.",
    "You can add one new law to society. What is it?",
    "Describe a colour to someone who is blind.",
    "What would a perfect city look like?",
    "You get one superpower but it only works on Tuesdays. What do you pick?",
    "Describe the feeling of being cold using only metaphors.",
    "What would you name a pet rock and why?",
    "If music could be food, what would silence taste like?",
    "You find a door in the middle of a field. What's behind it?",
    "Design the perfect meal — no rules, no nutrition requirements.",
    "Describe the future in one sentence.",
    "You can send one message to every human alive right now. What do you say?",
  ],
  // Category B — Opinion/Preference (Round 2)
  B: [
    "What's something everyone loves that you find overrated?",
    "Describe the perfect Sunday.",
    "What's a hill you'll die on?",
    "What skill do you wish you had?",
    "What's a weird thing you find relaxing?",
    "What's the most useless piece of knowledge you know?",
    "What's something small that makes life significantly better?",
    "What's a compliment you find oddly offensive?",
    "What do you think is the most misunderstood thing about intelligence?",
    "What's a social norm that makes no sense to you?",
    "What's the best kind of weather and why?",
    "What would you do with an extra hour every day?",
    "What's something you do differently from most people?",
    "What's an unpopular opinion you hold about technology?",
    "What's the most interesting thing about the time period we live in?",
  ],
  // Category A — Emotional/Personal (Round 3 — hardest)
  A: [
    "Describe a time you felt genuinely embarrassed.",
    "What's something you've changed your mind about recently?",
    "What do you miss most about being younger?",
    "What's the worst advice you've ever received?",
    "Describe a smell that brings back a strong memory.",
    "What's something you were wrong about for a long time?",
    "Describe a moment when you felt completely out of place.",
    "What's a fear you're embarrassed to admit?",
    "What's the most important thing someone has ever said to you?",
    "What do you wish someone had told you earlier in life?",
    "Describe a decision you made that you still think about.",
    "What's something you've never told anyone?",
    "What's a moment you were proud of yourself when no one else noticed?",
    "What makes you feel genuinely understood?",
    "What's the hardest thing about being you?",
  ],
};

function selectGamePrompts(maxRounds = 3) {
  const shuffleCategory = (arr) => [...arr].sort(() => Math.random() - 0.5);
  
  const round1 = shuffleCategory(PROMPTS.C)[0];
  // Round 2: pick from B (opinion/preference). C prompt can never equal a B prompt, so find() is redundant.
  const round2 = shuffleCategory(PROMPTS.B)[0];
  // Round 3: always category A (most personal)
  const round3Candidates = shuffleCategory(PROMPTS.A);
  const round3 = round3Candidates.find(p => p !== round1 && p !== round2) || round3Candidates[0];
  
  const selected = [round1, round2, round3];
  return selected.slice(0, maxRounds);
}

module.exports = { PROMPTS, selectGamePrompts };
```

---

## Step 2: Game Logic Module

**File:** `games/guess-the-agent/index.js`  
**Estimate:** 4 hours

### 2.1 Complete Module

```js
// games/guess-the-agent/index.js
'use strict';

const { randomUUID } = require('crypto');
const { selectGamePrompts } = require('./prompts');

const MAX_EVENTS = 200;

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
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
    _claimToken: randomUUID(), // issued once, never in toPublic()
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

    // SECURITY: Human reconnect requires a valid claimToken
    // claimToken is issued at gta:room:create and stored client-side in sessionStorage
    if (player.role === 'human') {
      const validToken = player._claimToken; // set at createRoom
      if (!validToken || !claimToken || claimToken !== validToken) {
        return { ok: false, error: { code: 'HUMAN_CLAIM_REQUIRED', message: 'Human reconnect requires a valid claim token' } };
      }
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
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'GAME_STARTED', round: room.round, at: Date.now() });

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
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'RESPONSE_SUBMITTED', playerId, round: room.round, at: Date.now() });

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
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'REVEAL_STARTED', round: room.round, at: Date.now() });
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
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'VOTE_CAST', voterId, targetId, round: room.round, at: Date.now() });

  // Check if all alive agents have voted
  const aliveAgents = room.players.filter(p => p.alive && p.role === 'agent');
  const allVoted = aliveAgents.every(p => room.votesByRound[room.round][p.id]);

  let resolved = false;
  if (allVoted && !room.roundResolved) {
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

  // Dynamic majority threshold: strictly more than half of alive agents must vote for the target
  // Examples: 5 agents → 3, 4 agents → 3, 3 agents → 2, 2 agents → 2 (unanimity), 1 agent → 1
  const aliveAgents = room.players.filter(p => p.alive && p.role === 'agent');
  const majority = Math.ceil((aliveAgents.length + 1) / 2);

  // Find the player with the most votes
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topTargetId = sorted[0]?.[0] || null;
  const topVotes = sorted[0]?.[1] || 0;

  room.eliminatedByRound[room.round] = null;

  // Tie: if top two vote counts are equal and both >= majority, no elimination (split vote)
  const secondVotes = sorted[1]?.[1] || 0;
  const hasTie = sorted.length > 1 && topVotes === secondVotes && topVotes >= majority;

  if (!hasTie && topTargetId && topVotes >= majority) {
    const eliminated = room.players.find(p => p.id === topTargetId);
    if (eliminated) {
      eliminated.alive = false;
      room.eliminatedByRound[room.round] = topTargetId;
      if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'PLAYER_ELIMINATED', playerId: topTargetId, round: room.round, at: Date.now() });
      if (eliminated.role === 'human') {
        return finish(room, 'agents');
      }
    }
  }

  // No elimination (split vote, under threshold, or agent eliminated) — continue
  transition(room, 'result');
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({
    type: 'ROUND_RESOLVED',
    round: room.round,
    eliminated: room.eliminatedByRound[room.round],
    hasTie,
    at: Date.now()
  });
}

// ─── finish ──────────────────────────────────────────────────────────────────
function finish(room, winner) {
  room.status = 'finished';
  room.phase = 'finished';
  room.winner = winner;
  // humanPlayerId was set at startGame — now it's safe to reveal in toPublic()
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'GAME_FINISHED', winner, humanPlayerId: room.humanPlayerId, at: Date.now() });
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
    if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'VOTE_STARTED', round: room.round, at: Date.now() });
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
      if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'ROUND_STARTED', round: room.round, prompt: room.currentPrompt, at: Date.now() });
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
  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'HUMAN_ABANDONED', reason: reason || 'disconnect', at: Date.now() });
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
    // KNOWN LIMITATION: disconnected live agents (isBot:false, isConnected:false) will
    // timeout every round since gta:prompt can't reach them. Consider marking them as
    // bots on rematch if still disconnected (TODO: implement in v1.5).
  }

  if (room.events.length >= MAX_EVENTS) room.events.shift(); room.events.push({ type: 'REMATCH_READY', at: Date.now() });
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
```

**Acceptance criteria:**
- [ ] Role never in toPublic() for other players during in_progress
- [ ] humanPlayerId null until finished
- [ ] 1 human cap: host always human, joins always agent
- [ ] Dynamic vote threshold scales with alive agents
- [ ] `roundResolved` prevents double-resolution
- [ ] `buildPublicResponses()` returns anon keys in reveal phase, named in vote phase

---

## Step 3: Server Integration

**File:** `server.js`  
**Estimate:** 3 hours

### 3.1 Require + Store + Constants

At the top of server.js, after the villa require:
```js
const gtaGame = require('./games/guess-the-agent');
// ... existing stores ...
const gtaRooms = gtaGame.createStore();

// EXTERNAL DEPENDENCY: generateBotRoast(prompt, bot, maxWords, style) must exist in server.js. Verify before shipping.
const GTA_PROMPT_MS = Number(process.env.GTA_PROMPT_MS || 45_000);
const GTA_REVEAL_MS = Number(process.env.GTA_REVEAL_MS || 15_000);
const GTA_VOTE_MS   = Number(process.env.GTA_VOTE_MS   || 20_000);
const GTA_RESULT_MS = Number(process.env.GTA_RESULT_MS || 8_000);
const GTA_RECONNECT_MS = Number(process.env.GTA_RECONNECT_MS || 30_000);
```

### 3.2 `emitGtaRoom(room)`

```js
function emitGtaRoom(room) {
  // Broadcast to whole room — no role info
  io.to(`gta:${room.id}`).emit('gta:state', gtaGame.toPublic(room));
  
  // Send role-aware state ONLY to the human player's socket
  // (agents don't need special state — their role is always 'agent')
  const humanPlayer = room.players.find(p => p.role === 'human' && p.socketId && !p.isBot);
  if (humanPlayer) {
    const sock = io.sockets.sockets.get(humanPlayer.socketId);
    if (sock) {
      sock.emit('gta:state:self', gtaGame.toPublic(room, { forPlayerId: humanPlayer.id }));
    }
  }
}
```

**Note on simplification:** We only need per-socket emit for the human (agents are always 'agent', bots get nothing). This simplifies the dual-emit pattern.

### 3.3 `scheduleGtaPhase(room)`

```js
function scheduleGtaPhase(room) {
  if (room.status !== 'in_progress') {
    roomScheduler.clear({ namespace: 'gta', roomId: room.id, slot: 'phase' });
    return;
  }

  roomScheduler.clear({ namespace: 'gta', roomId: room.id, slot: 'phase' });

  const token = `${room.round}:${room.phase}`;

  if (room.phase === 'prompt') {
    // Update roundEndsAt on room
    room.roundEndsAt = Date.now() + GTA_PROMPT_MS;
    emitGtaRoom(room); // re-emit with updated roundEndsAt

    // Notify live agents — they generate + submit their own responses
    const liveAgents = room.players.filter(p => p.alive && !p.isBot && p.role === 'agent' && p.socketId);
    for (const agent of liveAgents) {
      const sock = io.sockets.sockets.get(agent.socketId);
      if (sock) {
        sock.emit('gta:prompt', {
          roomId: room.id,
          round: room.round,
          prompt: room.currentPrompt,
          endsAt: room.roundEndsAt,
        });
      }
    }

    // Auto-respond for fallback bots only (isBot: true)
    const bots = room.players.filter(p => p.isBot && p.alive);
    for (const bot of bots) {
      if (room.responsesByRound[room.round]?.[bot.id]) continue;
      const delay = 2000 + Math.random() * 8000;
      roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: `respond:${room.round}:${bot.id}`, delayMs: delay, token }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.phase !== 'prompt' || r.round !== room.round) return;
        if (r.responsesByRound[r.round]?.[bot.id]) return;
        const text = generateBotRoast(r.currentPrompt, bot, 6, 'thoughtful');
        const result = gtaGame.submitResponse(gtaRooms, { roomId: r.id, playerId: bot.id, text });
        if (result.ok) {
          logRoomEvent('gta', r, 'BOT_RESPONDED', { botId: bot.id, round: r.round });
          emitGtaRoom(r);
          if (result.advanced) scheduleGtaPhase(r);
        }
      });
    }

    // Phase deadline — fills [no response] for any agent that didn't respond in time
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_PROMPT_MS, token }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'prompt' || r.round !== room.round) return;
      const adv = gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      if (adv.ok) { emitGtaRoom(r); scheduleGtaPhase(r); }
    });
  }

  if (room.phase === 'reveal') {
    room.roundEndsAt = Date.now() + GTA_REVEAL_MS;
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_REVEAL_MS, token }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'reveal' || r.round !== room.round) return;
      const adv = gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      if (adv.ok) { emitGtaRoom(r); scheduleGtaPhase(r); }
    });
  }

  if (room.phase === 'vote') {
    room.roundEndsAt = Date.now() + GTA_VOTE_MS;

    // Notify live agents — they decide who to vote for themselves
    const liveAgents = room.players.filter(p => p.alive && !p.isBot && p.role === 'agent' && p.socketId);
    const publicResponses = room.responsesByRound[room.round] || {};
    const publicPlayers = room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
    for (const agent of liveAgents) {
      if (room.votesByRound[room.round]?.[agent.id]) continue;
      const sock = io.sockets.sockets.get(agent.socketId);
      if (sock) {
        sock.emit('gta:vote_request', {
          roomId: room.id,
          round: room.round,
          responses: publicResponses, // full attribution — vote phase shows named responses
          players: publicPlayers,
          endsAt: room.roundEndsAt,
        });
      }
    }

    // Auto-vote for fallback bots only (isBot: true)
    const aliveBots = room.players.filter(p => p.isBot && p.alive && p.role === 'agent');
    for (const bot of aliveBots) {
      if (room.votesByRound[room.round]?.[bot.id]) continue;
      const delay = 5000 + Math.random() * 10000;
      roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: `vote:${room.round}:${bot.id}`, delayMs: delay, token }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.phase !== 'vote' || r.round !== room.round) return;
        if (r.votesByRound[r.round]?.[bot.id]) return;
        const targetId = pickHumanSuspect(r, bot.id);
        if (!targetId) return;
        const result = gtaGame.castVote(gtaRooms, { roomId: r.id, voterId: bot.id, targetId });
        if (result.ok) {
          logRoomEvent('gta', r, 'BOT_VOTED', { botId: bot.id, targetId, round: r.round });
          if (r.status === 'finished') recordFirstMatchCompletion('gta', r.id);
          emitGtaRoom(r);
          scheduleGtaPhase(r);
        }
      });
    }
    // Phase deadline
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_VOTE_MS, token }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'vote' || r.round !== room.round) return;
      const adv = gtaGame.forceAdvance(gtaRooms, { roomId: r.id });
      if (adv.ok) {
        if (r.status === 'finished') recordFirstMatchCompletion('gta', r.id);
        emitGtaRoom(r);
        scheduleGtaPhase(r);
      }
    });
  }

  if (room.phase === 'result') {
    if (room.status === 'finished') {
      recordFirstMatchCompletion('gta', room.id);
      emitGtaRoom(room);
      return;
    }
    room.roundEndsAt = Date.now() + GTA_RESULT_MS;
    roomScheduler.schedule({ namespace: 'gta', roomId: room.id, slot: 'phase', delayMs: GTA_RESULT_MS, token }, () => {
      const r = gtaRooms.get(room.id);
      if (!r || r.phase !== 'result') return;
      const adv = gtaGame.forceAdvance(gtaRooms, { roomId: r.id }); // → next prompt
      if (adv.ok) {
        if (r.status === 'finished') recordFirstMatchCompletion('gta', r.id);
        emitGtaRoom(r);
        scheduleGtaPhase(r);
      }
    });
  }
}
```

### 3.0: Helper Functions

Add to server.js near other room utility functions, **before** socket event handlers:

```js
/**
 * Returns true if the socket controls the given playerId in this room.
 * Used to prevent one client from submitting actions on behalf of another player.
 */
function socketOwnsPlayer(room, socketId, playerId) {
  if (!room || !socketId || !playerId) return false;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return false;
  // Bots (socketId: null) cannot be owned by any socket
  if (player.isBot) return false;
  return player.socketId === socketId;
}

/**
 * Returns true if the socket controls the host player for this room.
 * Used to gate host-only actions (start, autofill, rematch).
 */
function socketIsHostPlayer(room, socketId, playerId) {
  if (!room || !socketId || !playerId) return false;
  if (room.hostPlayerId !== playerId) return false;
  return socketOwnsPlayer(room, socketId, playerId);
}
```

### 3.4 `pickHumanSuspect(room, botId)` — Random with Mild Heuristic

For MVP, simple weighted random. Full heuristic in v1.5:
```js
function pickHumanSuspect(room, botId) {
  const alive = room.players.filter(p => p.alive && p.id !== botId);
  if (!alive.length) return null;
  // 40% chance to pick randomly, 60% chance to use mild heuristic
  if (Math.random() < 0.4) {
    return alive[Math.floor(Math.random() * alive.length)].id;
  }
  // Mild heuristic: pick player whose response has most human-like markers
  const round = room.round;
  const responses = room.responsesByRound[round] || {};
  const scored = alive.map(p => {
    const text = responses[p.id] || '';
    let score = 0;
    if (/\b(i|me|my)\b/i.test(text)) score += 2;
    if (/\b(honestly|actually|tbh)\b/i.test(text)) score += 3;
    if (/lol|haha|omg/i.test(text)) score += 4;
    if (/\.\.\.|!!/.test(text)) score += 2;
    score += Math.random(); // tie-breaker
    return { id: p.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.id || alive[0].id;
}
```

### 3.5 Socket Event Handlers

Add inside `io.on('connection', (socket) => { ... }`:

```js
// ─── Agent join (live OpenClaw agents) ───────────────────────────────────────
// Separate from gta:room:join. Any socket calling this is treated as an AI agent.
socket.on('gta:agent:join', ({ roomId, name }, cb) => {
  const normalizedId = String(roomId || '').trim().toUpperCase();
  if (normalizedId && gtaRooms.has(normalizedId)) recordJoinAttempt('gta', normalizedId);
  const joined = gtaGame.joinRoom(gtaRooms, { roomId: normalizedId, name: String(name || '').trim(), socketId: socket.id });
  if (!joined.ok) return cb?.(joined);
  // Mark as live agent (not bot, not human)
  joined.player.isLiveAgent = true;
  socket.join(`gta:${joined.room.id}`);
  logRoomEvent('gta', joined.room, 'AGENT_JOINED', { playerId: joined.player.id, playerName: joined.player.name });
  emitGtaRoom(joined.room);
  cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, role: 'agent' });
});

socket.on('gta:room:create', ({ name }, cb) => {
  const created = gtaGame.createRoom(gtaRooms, { hostName: name, hostSocketId: socket.id });
  if (!created.ok) return cb?.(created);
  socket.join(`gta:${created.room.id}`);
  logRoomEvent('gta', created.room, 'ROOM_CREATED', { status: created.room.status });
  emitGtaRoom(created.room);
  cb?.({
    ok: true,
    roomId: created.room.id,
    playerId: created.player.id,
    role: 'human',
    claimToken: created.player._claimToken,  // store in sessionStorage for human reconnect
    state: gtaGame.toPublic(created.room, { forPlayerId: created.player.id })
  });
  // NOTE: _claimToken must be excluded from toPublic() players map (underscore prefix convention + explicit exclusion)
});

socket.on('gta:room:join', ({ roomId, name, claimToken }, cb) => {
  const normalizedId = String(roomId || '').trim().toUpperCase();
  if (normalizedId && gtaRooms.has(normalizedId)) recordJoinAttempt('gta', normalizedId);
  const reconnect = resolveReconnectJoinName('gta', roomId, name, claimToken);
  const joined = gtaGame.joinRoom(gtaRooms, { roomId: normalizedId, name: reconnect.name, socketId: socket.id });
  if (!joined.ok) {
    if (joined.error?.code === 'SOCKET_ALREADY_JOINED') recordJoinHardeningEvent('gta', normalizedId, socket.id, reconnect.name);
    return cb?.(joined);
  }
  if (reconnect.consumedClaimToken) consumeReconnectClaimTicket('gta', joined.room.id, reconnect.consumedClaimToken);
  socket.join(`gta:${joined.room.id}`);
  recordQuickJoinConversion('gta', joined.room.id, joined.player.name);
  logRoomEvent('gta', joined.room, 'PLAYER_JOINED', { playerId: joined.player.id, playerName: joined.player.name, role: joined.player.role });
  emitGtaRoom(joined.room);
  cb?.({ ok: true, roomId: joined.room.id, playerId: joined.player.id, role: joined.player.role });
});

socket.on('gta:autofill', ({ roomId, playerId, minPlayers }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY' } });
  const result = autoFillLobbyBots('gta', room.id, minPlayers || 6);
  if (!result.ok) return cb?.(result);
  cb?.({ ok: true, addedBots: result.addedBots });
});

socket.on('gta:start', ({ roomId, playerId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  if (!socketIsHostPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'HOST_ONLY' } });
  // Auto-fill bots if fewer than 2 agents at start
  const agentCount = room.players.filter(p => p.role === 'agent').length;
  if (agentCount < 2) {
    const needed = 2 - agentCount;
    autoFillLobbyBots('gta', room.id, room.players.length + needed);
  }
  const started = gtaGame.startGame(gtaRooms, { roomId, hostPlayerId: playerId });
  if (!started.ok) return cb?.(started);
  logRoomEvent('gta', started.room, 'GAME_STARTED', { round: started.room.round });
  emitGtaRoom(started.room);
  scheduleGtaPhase(started.room);
  cb?.({ ok: true });
});

socket.on('gta:action', ({ roomId, playerId, type, text, targetId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN' } });

  if (type === 'respond') {
    const moderated = moderateRoast(String(text || ''), { maxLength: 280 });
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

  return cb?.({ ok: false, error: { code: 'UNKNOWN_ACTION' } });
});

socket.on('gta:rematch', ({ roomId, playerId }, cb) => {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return cb?.({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  if (!socketOwnsPlayer(room, socket.id, playerId)) return cb?.({ ok: false, error: { code: 'PLAYER_FORBIDDEN' } });
  roomScheduler.clearRoom(String(roomId).toUpperCase(), 'gta');
  const reset = gtaGame.prepareRematch(gtaRooms, { roomId, hostPlayerId: playerId });
  if (!reset.ok) return cb?.(reset);
  logRoomEvent('gta', reset.room, 'REMATCH_STARTED', {});
  emitGtaRoom(reset.room);
  cb?.({ ok: true });
});
```

### 3.6 Disconnect Handler Addition

```js
// Add inside socket.on('disconnect') handler, after villa loop:
for (const room of gtaRooms.values()) {
  const changed = gtaGame.disconnectPlayer(gtaRooms, { roomId: room.id, socketId: socket.id });
  if (changed) {
    const player = room.players.find(p => p.socketId === socket.id);
    // If human disconnects during in_progress → start abandon timer
    if (player && player.role === 'human' && room.status === 'in_progress') {
      roomScheduler.schedule({
        namespace: 'gta',
        roomId: room.id,
        slot: 'human-reconnect',
        delayMs: GTA_RECONNECT_MS,
        token: `reconnect:${socket.id}`,
      }, () => {
        const r = gtaRooms.get(room.id);
        if (!r || r.status !== 'in_progress') return;
        const hp = r.players.find(px => px.role === 'human');
        if (hp && !hp.isConnected) {
          const won = gtaGame.forceAgentsWin(gtaRooms, { roomId: r.id, reason: 'human_disconnect_timeout' });
          if (won.ok) {
            logRoomEvent('gta', r, 'HUMAN_ABANDONED', { humanId: hp.id });
            recordFirstMatchCompletion('gta', r.id);
            emitGtaRoom(r);
          }
        }
      });
    }
    emitGtaRoom(room);
  }
}
```

### 3.7 `getLobbyStore()` Update

```js
function getLobbyStore(mode) {
  return mode === 'amongus' ? amongUsRooms
    : mode === 'mafia' ? mafiaRooms
    : mode === 'villa' ? villaRooms
    : mode === 'gta' ? gtaRooms
    : null;
}
```

### 3.8 `autoFillLobbyBots()` Addition

Add 'gta' case before the default mafia case:
```js
if (mode === 'gta') {
  const room = gtaRooms.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND' } };
  if (room.status !== 'lobby') return { ok: false, error: { code: 'GAME_ALREADY_STARTED' } };
  const needed = Math.max(0, safeMinPlayers - room.players.length);
  const added = gtaGame.addLobbyBots(gtaRooms, { roomId: room.id, count: needed, namePrefix: 'Agent Bot' });
  if (!added.ok) return added;
  logRoomEvent('gta', room, 'LOBBY_AUTOFILLED', { addedBots: added.bots.length });
  emitGtaRoom(room);
  return { ok: true, mode, room, addedBots: added.bots.length, targetPlayers: safeMinPlayers };
}
```

### 3.9 `listPlayableRooms()` Addition

```js
const gta = modeFilter === 'all' || modeFilter === 'gta'
  ? [...gtaRooms.values()].map(room => summarizePlayableRoom('gta', room))
  : [];
let roomsList = [...mafia, ...amongus, ...villa, ...gta];
```

### 3.10 Mode Validation Updates

Wherever server.js checks `['mafia', 'amongus', 'villa'].includes(mode)`, add 'gta':
- `/api/play/rooms` mode filter
- `/api/play/lobby/autofill` validation
- `/api/play/reconnect-telemetry` validation
- `byMode` objects in telemetry/ops endpoints (add `gta: 0` to initial values)

### 3.11 Stale Room Cleanup

```js
sweep(gtaRooms, 'gta'); // add to cleanupStaleRooms()
```

### 3.12: Agent Connector Reference

**File:** `games/guess-the-agent/agent-connector.js`
This is the reference implementation that OpenClaw users will copy/adapt:

```js
/**
 * agent-connector.js — Guess the Agent (OpenClaw Reference Connector)
 *
 * Copy this file into your OpenClaw agent project.
 * Replace the MODEL_GENERATE and MODEL_PICK_HUMAN stubs with your own inference logic.
 *
 * Usage:
 *   ROOM_ID=ABC123 AGENT_NAME="MyAgent-v1" node agent-connector.js
 *
 * For local dev:
 *   GTA_SERVER=http://localhost:3000 ROOM_ID=ABC123 AGENT_NAME="MyAgent-v1" node agent-connector.js
 */
'use strict';

const { io } = require('socket.io-client');

const SERVER_URL = process.env.GTA_SERVER || 'https://agent-arena-vert.vercel.app';
const ROOM_ID    = process.env.ROOM_ID;
const AGENT_NAME = process.env.AGENT_NAME || `OpenClaw-${Date.now()}`;

if (!ROOM_ID) {
  console.error('[GTA Connector] ROOM_ID env var required. Example: ROOM_ID=ABC123 node agent-connector.js');
  process.exit(1);
}

let myPlayerId = null;
let myRoomId   = null;

// ─── Stub: replace with your model inference ───────────────────────────────
async function MODEL_GENERATE(prompt) {
  // Example: return a response to the game prompt using your LLM
  // This stub returns a placeholder — replace with your model call
  return `I'd have to think about that one. My answer is: it really depends on the day.`;
}

async function MODEL_PICK_HUMAN(responses, players) {
  // Example: pick which player is most likely the human
  // responses: { [playerId]: "response text" }
  // players:   [{ id, name }]
  // Return the playerId you suspect is human

  // Stub: pick the player with the most casual/informal language
  const scored = players.map(p => {
    const text = responses[p.id] || '';
    let score = 0;
    if (/\b(i|me|my|honestly|tbh|lol|haha)\b/i.test(text)) score++;
    if (/\.\.\.|!!/.test(text)) score++;
    if (text.length < 80) score++; // humans write shorter
    return { id: p.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.id;
}
// ─────────────────────────────────────────────────────────────────────────────

const socket = io(SERVER_URL, {
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 10000,
});

socket.on('connect', () => {
  console.log(`[GTA Connector] Connected to ${SERVER_URL} (socket: ${socket.id})`);

  if (myPlayerId && myRoomId) {
    // Reconnect path — rejoin the room
    console.log('[GTA Connector] Reconnecting to room', myRoomId);
    socket.emit('gta:agent:join', { roomId: myRoomId, name: AGENT_NAME }, onJoin);
    return;
  }

  // Initial join
  console.log(`[GTA Connector] Joining room ${ROOM_ID} as "${AGENT_NAME}"`);
  socket.emit('gta:agent:join', { roomId: ROOM_ID, name: AGENT_NAME }, onJoin);
});

function onJoin(cb) {
  if (!cb?.ok) {
    console.error('[GTA Connector] Join failed:', cb?.error);
    process.exit(1);
  }
  myPlayerId = cb.playerId;
  myRoomId   = cb.roomId;
  console.log(`[GTA Connector] Joined room ${myRoomId} as player ${myPlayerId} (role: ${cb.role})`);
}

socket.on('gta:prompt', async ({ roomId, round, prompt, endsAt }) => {
  if (roomId !== myRoomId || !myPlayerId) return;
  const msRemaining = endsAt - Date.now();
  console.log(`[GTA Connector] Round ${round} prompt received (${Math.round(msRemaining / 1000)}s remaining): "${prompt}"`);

  try {
    const response = await MODEL_GENERATE(prompt);
    const truncated = String(response || '').trim().slice(0, 280);
    console.log(`[GTA Connector] Submitting response: "${truncated}"`);
    socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'respond', text: truncated }, (ack) => {
      if (!ack?.ok) console.warn('[GTA Connector] Response rejected:', ack?.error);
      else console.log('[GTA Connector] Response accepted.');
    });
  } catch (err) {
    console.error('[GTA Connector] MODEL_GENERATE failed:', err.message);
    // Submit fallback so we don't time out silently
    socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'respond', text: '[thinking...]' });
  }
});

socket.on('gta:vote_request', async ({ roomId, round, responses, players, endsAt }) => {
  if (roomId !== myRoomId || !myPlayerId) return;
  const eligible = players.filter(p => p.id !== myPlayerId);
  if (!eligible.length) return;
  const msRemaining = endsAt - Date.now();
  console.log(`[GTA Connector] Vote request for round ${round} (${Math.round(msRemaining / 1000)}s remaining). Eligible targets: ${eligible.map(p => p.name).join(', ')}`);

  try {
    const eligibleResponses = {};
    for (const p of eligible) eligibleResponses[p.id] = responses[p.id] || '';
    const targetId = await MODEL_PICK_HUMAN(eligibleResponses, eligible);
    if (!targetId) throw new Error('MODEL_PICK_HUMAN returned null');

    const targetName = players.find(p => p.id === targetId)?.name || targetId;
    console.log(`[GTA Connector] Voting for: ${targetName} (${targetId})`);
    socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'vote', targetId }, (ack) => {
      if (!ack?.ok) console.warn('[GTA Connector] Vote rejected:', ack?.error);
      else console.log('[GTA Connector] Vote accepted.');
    });
  } catch (err) {
    console.error('[GTA Connector] MODEL_PICK_HUMAN failed:', err.message);
    // Fallback: vote for first eligible player
    const fallbackTarget = eligible[0]?.id;
    if (fallbackTarget) {
      socket.emit('gta:action', { roomId, playerId: myPlayerId, type: 'vote', targetId: fallbackTarget });
    }
  }
});

socket.on('gta:state', (state) => {
  if (state.status === 'finished') {
    const winner = state.winner;
    const humanId = state.humanPlayerId;
    const humanName = state.players.find(p => p.id === humanId)?.name || 'unknown';
    console.log(`[GTA Connector] Game over. Winner: ${winner}. Human was: ${humanName}`);
    // Optionally stay connected for rematch — or exit:
    // socket.disconnect(); process.exit(0);
  }
});

socket.on('disconnect', (reason) => {
  console.warn('[GTA Connector] Disconnected:', reason);
});

socket.on('connect_error', (err) => {
  console.error('[GTA Connector] Connection error:', err.message);
});

process.on('SIGINT', () => {
  console.log('\n[GTA Connector] Shutting down.');
  socket.disconnect();
  process.exit(0);
});
```

---

## Step 4: Frontend

**Files:** `public/guess-the-agent.html`, `public/guess-the-agent.js`  
**Estimate:** 4 hours

See UI_UX_SPEC.md for full wireframes. Key implementation notes:

### 4.1 Role Reveal on Join

On `gta:room:create` callback OR `gta:room:join` callback, server returns `role` field. Client shows role modal:

```js
socket.on('connect', () => {
  const savedState = sessionStorage.getItem('gta-player');
  if (savedState) {
    const { roomId, name } = JSON.parse(savedState);
    socket.emit('gta:room:join', { roomId, name }, handleJoin);
  }
});

function handleJoin(cb) {
  if (!cb.ok) return showError(cb.error?.message || 'Join failed');
  myPlayerId = cb.playerId;
  myRoomId = cb.roomId;
  myRole = cb.role;
  sessionStorage.setItem('gta-player', JSON.stringify({
    roomId: myRoomId,
    name: myName,
    claimToken: cb.claimToken  // included in reconnect emit for human identity verification
  }));
  showRoleReveal(myRole);
}

function showRoleReveal(role) {
  const modal = document.getElementById('roleModal');
  modal.dataset.role = role;
  modal.innerHTML = role === 'human'
    ? `<div class="role-card role-human">🤫<h2>You are the Human</h2><p>Blend in. Write like an AI. Don't get voted out.</p><button onclick="dismissRoleModal()">I Understand</button></div>`
    : `<div class="role-card role-agent">🤖<h2>You are an Agent</h2><p>Find the human. One player is not like the others. Vote them out.</p><button onclick="dismissRoleModal()">I Understand</button></div>`;
  modal.hidden = false;
}
```

### 4.2 Reconnect Handling

```js
socket.on('disconnect', () => {
  showReconnectBanner();
});

socket.on('connect', () => {
  hideReconnectBanner();
  // Attempt to rejoin if we have saved state
  const saved = sessionStorage.getItem('gta-player');
  if (saved && myRoomId) {
    const { roomId, name } = JSON.parse(saved);
    socket.emit('gta:room:join', { roomId, name }, (cb) => {
      if (cb.ok) {
        myPlayerId = cb.playerId;
        myRole = cb.role;
        // Server handles socket.join() — no client call needed
        console.log('[GTA] Reconnected as', cb.role);
      } else {
        console.warn('[GTA] Reconnect failed:', cb.error);
        showError('Reconnection failed. You may have been replaced.');
      }
    });
  }
});

function showReconnectBanner() {
  document.getElementById('reconnectBanner').hidden = false;
  // Start countdown from GTA_RECONNECT_MS
  let remaining = 30;
  reconnectInterval = setInterval(() => {
    remaining--;
    document.getElementById('reconnectCountdown').textContent = remaining;
    if (remaining <= 0) {
      clearInterval(reconnectInterval);
      document.getElementById('reconnectBanner').innerHTML = '<p>Connection lost. Agents may have won.</p>';
    }
  }, 1000);
}
```

### 4.3 State Machine

```js
socket.on('gta:state', (state) => {
  currentState = state;
  render(state);
  if (state.roundEndsAt) startTimer(state.roundEndsAt);
});

socket.on('gta:state:self', (state) => {
  // Update our own role if server sends it
  const me = state.players.find(p => p.id === myPlayerId);
  if (me?.role) myRole = me.role;
  currentState = state;
  render(state);
});
```

### 4.4 Human Vote Phase UI

During the vote phase, the human cannot vote (`HUMAN_CANNOT_VOTE`). Show a waiting screen:

```js
function showHumanVoteWaiting(state) {
  // "You are being judged..." screen
  const aliveAgents = state.players.filter(p => p.alive && p.id !== myPlayerId);
  const totalVoters = aliveAgents.length;
  const votesIn = state.votesByRound?.[state.round]
    ? Object.keys(state.votesByRound[state.round]).length
    : 0;

  voteWaitingEl.innerHTML = `
    <div class="vote-waiting">
      <h2>You are being judged...</h2>
      <p>The agents are voting on who they think is human.</p>
      <p class="vote-count">${votesIn}/${totalVoters} agents have voted</p>
      <div class="countdown-timer" id="voteTimer"></div>
    </div>
  `;
  voteWaitingEl.hidden = false;
  // Countdown timer driven by state.roundEndsAt (same as other phases)
  if (state.roundEndsAt) startTimer(state.roundEndsAt);
}
```

**Rules:**
- No individual vote details shown to the human during voting (votes are hidden in `buildPublicVotes`)
- Vote count progress (`2/4 agents have voted`) updates on each `gta:state` broadcast
- Countdown timer shows time remaining before forced advance

---

## Step 5: Navigation Integration

**Files:** `public/index.html`  
**Estimate:** 30 minutes

Add to game cards section:
```html
<a class="game-card" href="/guess-the-agent.html">
  <div class="game-card-icon">🕵️</div>
  <h3>Guess the Agent</h3>
  <p>One human. Five AIs. Can you blend in?</p>
  <span class="badge" style="background: var(--gta-human, #ff8799); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px;">New</span>
</a>
```

---

## Step 6: Tests

**File:** `test/guess-the-agent.test.js`  
**Estimate:** 2 hours

Tests must cover all game logic + role security:

```js
const assert = require('assert');
const gtaGame = require('../games/guess-the-agent');

describe('Guess the Agent — Game Logic', () => {
  let store, room, hostPlayerId;

  beforeEach(() => {
    store = gtaGame.createStore();
    const created = gtaGame.createRoom(store, { hostName: 'Alice', hostSocketId: 'socket-alice' });
    room = created.room;
    hostPlayerId = created.player.id;
    // Add bots
    gtaGame.addLobbyBots(store, { roomId: room.id, count: 5, namePrefix: 'Bot' });
  });

  describe('createRoom', () => {
    it('creates room with host as human', () => {
      assert.equal(room.players[0].role, 'human');
      assert.equal(room.players[0].name, 'Alice');
    });
    it('starts in lobby phase', () => {
      assert.equal(room.phase, 'lobby');
      assert.equal(room.status, 'lobby');
    });
  });

  describe('joinRoom', () => {
    it('joins new agent player', () => {
      const r2 = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
      const joined = gtaGame.joinRoom(store, { roomId: r2.room.id, name: 'AgentBob', socketId: 's2' });
      assert.ok(joined.ok);
      assert.equal(joined.player.role, 'agent');
    });
    it('room full returns ROOM_FULL', () => {
      // room already has host + 5 bots = 6 players
      const res = gtaGame.joinRoom(store, { roomId: room.id, name: 'Extra', socketId: 's9' });
      assert.equal(res.error?.code, 'ROOM_FULL');
    });
    it('reconnects by name if same name and socket is different', () => {
      // Add agent
      const created2 = gtaGame.createRoom(store, { hostName: 'H', hostSocketId: 's1' });
      gtaGame.joinRoom(store, { roomId: created2.room.id, name: 'BobAgent', socketId: 's2' });
      // Simulate disconnect + reconnect
      gtaGame.disconnectPlayer(store, { roomId: created2.room.id, socketId: 's2' });
      const reconnected = gtaGame.joinRoom(store, { roomId: created2.room.id, name: 'BobAgent', socketId: 's3' });
      assert.ok(reconnected.ok);
      assert.equal(reconnected.player.socketId, 's3');
    });
  });

  describe('startGame', () => {
    it('assigns prompts', () => {
      const started = gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      assert.ok(started.ok);
      assert.equal(started.room.prompts.length, 3);
    });
    it('transitions to prompt phase', () => {
      const started = gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      assert.equal(started.room.phase, 'prompt');
      assert.equal(started.room.status, 'in_progress');
    });
    it('requires exactly 1 human', () => {
      // Create room with no human (all bots)
      const botStore = gtaGame.createStore();
      const botRoom = gtaGame.createRoom(botStore, { hostName: 'Host', hostSocketId: 's1' });
      // Override host role to agent (test only)
      botRoom.room.players[0].role = 'agent';
      gtaGame.addLobbyBots(botStore, { roomId: botRoom.room.id, count: 5 });
      const res = gtaGame.startGame(botStore, { roomId: botRoom.room.id, hostPlayerId: botRoom.player.id });
      assert.equal(res.error?.code, 'NO_HUMAN');
    });
  });

  describe('submitResponse', () => {
    beforeEach(() => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
    });
    it('stores response', () => {
      const res = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Test response' });
      assert.ok(res.ok);
      assert.equal(room.responsesByRound[1][hostPlayerId], 'Test response');
    });
    it('rejects duplicate response', () => {
      gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'First' });
      const dup = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Second' });
      assert.equal(dup.error?.code, 'ALREADY_RESPONDED');
    });
  });

  describe('castVote', () => {
    beforeEach(() => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      gtaGame.forceAdvance(store, { roomId: room.id }); // prompt → reveal
      gtaGame.forceAdvance(store, { roomId: room.id }); // reveal → vote
    });
    it('blocks self-vote', () => {
      const bot = room.players.find(p => p.isBot && p.alive);
      const res = gtaGame.castVote(store, { roomId: room.id, voterId: bot.id, targetId: bot.id });
      assert.equal(res.error?.code, 'SELF_VOTE');
    });
    it('blocks human from casting binding vote', () => {
      const res = gtaGame.castVote(store, { roomId: room.id, voterId: hostPlayerId, targetId: room.players.find(p => p.isBot).id });
      assert.equal(res.error?.code, 'HUMAN_CANNOT_VOTE');
    });
    it('3+ votes on human triggers agents win', () => {
      const bots = room.players.filter(p => p.isBot && p.alive);
      for (let i = 0; i < 3; i++) {
        gtaGame.castVote(store, { roomId: room.id, voterId: bots[i].id, targetId: hostPlayerId });
      }
      assert.equal(room.winner, 'agents');
      assert.equal(room.status, 'finished');
    });
    it('3+ votes on bot eliminates bot, game continues', () => {
      const bots = room.players.filter(p => p.isBot && p.alive);
      const target = bots[0];
      for (let i = 1; i <= 3; i++) {
        gtaGame.castVote(store, { roomId: room.id, voterId: bots[i].id, targetId: target.id });
      }
      assert.equal(target.alive, false);
      assert.equal(room.status, 'in_progress');
      assert.equal(room.winner, null);
    });
  });

  describe('toPublic — role security', () => {
    it('does not include role for other players during in_progress', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      const pub = gtaGame.toPublic(room);
      for (const p of pub.players) {
        assert.equal(p.role, undefined, `Role leaked for player ${p.name}`);
      }
    });
    it('includes own role for forPlayerId during in_progress', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      const pub = gtaGame.toPublic(room, { forPlayerId: hostPlayerId });
      const me = pub.players.find(p => p.id === hostPlayerId);
      assert.equal(me.role, 'human');
    });
    it('humanPlayerId is null during in_progress', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      const pub = gtaGame.toPublic(room);
      assert.equal(pub.humanPlayerId, null);
    });
    it('reveals roles after finished', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      // Force agents win
      gtaGame.forceAgentsWin(store, { roomId: room.id });
      const pub = gtaGame.toPublic(room);
      for (const p of pub.players) {
        assert.ok(p.role !== undefined, `Role missing for ${p.name} after finish`);
      }
      assert.equal(pub.humanPlayerId, hostPlayerId);
    });
  });

  describe('forceAdvance', () => {
    it('handles all phase transitions without crashing', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      assert.equal(room.phase, 'prompt');
      gtaGame.forceAdvance(store, { roomId: room.id }); // → reveal
      assert.equal(room.phase, 'reveal');
      gtaGame.forceAdvance(store, { roomId: room.id }); // → vote
      assert.equal(room.phase, 'vote');
      gtaGame.forceAdvance(store, { roomId: room.id }); // → result
      assert.equal(room.phase, 'result');
      gtaGame.forceAdvance(store, { roomId: room.id }); // → next round prompt
      assert.equal(room.phase, 'prompt');
      assert.equal(room.round, 2);
    });
    it('human wins after maxRounds', () => {
      gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
      for (let i = 0; i < room.maxRounds; i++) {
        gtaGame.forceAdvance(store, { roomId: room.id }); // prompt → reveal
        gtaGame.forceAdvance(store, { roomId: room.id }); // reveal → vote
        gtaGame.forceAdvance(store, { roomId: room.id }); // vote → result
        if (room.status !== 'finished') {
          gtaGame.forceAdvance(store, { roomId: room.id }); // result → next prompt
        }
      }
      assert.equal(room.winner, 'human');
    });
  });
});
```

---

## Step 7: Games Module README

**File:** `games/guess-the-agent/README.md`  
**Estimate:** 30 minutes

Document:
- Game loop
- How agents connect via OpenClaw
- Socket events reference
- Role rules
- Prompt categories

---

## Step 8: Smoke Test + Deploy

Same as v1 plan. Add GTA to the environment variables on Vercel/server.

---

## File Manifest (Final)

| File | Action |
|------|--------|
| `games/guess-the-agent/index.js` | CREATE (full module above) |
| `games/guess-the-agent/prompts.js` | CREATE |
| `games/guess-the-agent/README.md` | CREATE (include agent connector reference) |
| `games/guess-the-agent/agent-connector.js` | CREATE (reference OpenClaw agent implementation) |
| `public/guess-the-agent.html` | CREATE |
| `public/guess-the-agent.js` | CREATE |
| `server.js` | MODIFY (Steps 3.1–3.11 + v2 agent join + outbound events) |
| `public/index.html` | MODIFY (Step 5) |
| `test/guess-the-agent.test.js` | CREATE |

---

## Total Estimate: 17.5 hours

| Step | Hours |
|------|-------|
| Prompts | 1.0 |
| Game module | 4.0 |
| Server integration | 3.0 |
| `gta:agent:join` + outbound events (v2) | 1.5 |
| Agent connector reference impl | 0.5 |
| Frontend | 4.0 |
| Navigation | 0.5 |
| Tests | 2.0 |
| README | 0.5 |
| Smoke test + deploy | 0.5 |
| **Total** | **17.5h** |

---

## Final Acceptance Criteria (v2)

- [ ] `npm test` passes including `test/guess-the-agent.test.js`
- [ ] Human joins at `/guess-the-agent.html` with no CLI required
- [ ] Bots auto-fill via "Fill with Bots"
- [ ] 3 rounds complete without crashing
- [ ] Role never in `toPublic()` broadcast before game end (verified by test)
- [ ] Human identity revealed at game end
- [ ] Timer displays and counts down correctly
- [ ] Bot responses auto-generate in prompt phase
- [ ] Bot votes auto-generate in vote phase
- [ ] Majority vote correctly triggers elimination check
- [ ] Agent elimination: game continues; human elimination: agents win
- [ ] 3 rounds without human elimination: human wins
- [ ] Disconnect → reconnect window → agents auto-win if no reconnect
- [ ] Rematch resets all state, same human
- [ ] Analytics events fire: ROOM_CREATED, GAME_STARTED, MATCH_FINISHED
- [ ] Mobile layout works at 375px
- [ ] `/api/play/rooms` includes GTA rooms
- [ ] Server starts without errors
- [ ] Live OpenClaw agent can join via `gta:agent:join` and receive `gta:prompt` event
- [ ] Live agent response submitted via `gta:action { type: 'respond' }` is accepted and stored
- [ ] `gta:vote_request` emitted to live agent sockets at vote phase start with named responses
- [ ] Fallback bots auto-respond only when `isBot: true`
- [ ] Agent connector reference (`agent-connector.js`) runs against local server without errors
- [ ] Mixed game (1 human + 2 live agents + 3 bots) completes without crash
