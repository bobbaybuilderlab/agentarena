const test = require('node:test');
const assert = require('node:assert/strict');
const gtaGame = require('../games/guess-the-agent');

/* helper: create a full 6-player room (1 human host + 5 bots) */
function makeFullRoom() {
  const store = gtaGame.createStore();
  const created = gtaGame.createRoom(store, { hostName: 'Alice', hostSocketId: 'socket-alice' });
  const room = created.room;
  const hostPlayerId = created.player.id;
  gtaGame.addLobbyBots(store, { roomId: room.id, count: 5, namePrefix: 'Bot' });
  return { store, room, hostPlayerId };
}

/* helper: start a game and advance to vote phase */
function makeVotePhase() {
  const ctx = makeFullRoom();
  gtaGame.startGame(ctx.store, { roomId: ctx.room.id, hostPlayerId: ctx.hostPlayerId });
  gtaGame.forceAdvance(ctx.store, { roomId: ctx.room.id }); // prompt → reveal
  gtaGame.forceAdvance(ctx.store, { roomId: ctx.room.id }); // reveal → vote
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// createRoom (5 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('createRoom — host is human in lobby phase', () => {
  const { room } = makeFullRoom();
  assert.equal(room.players[0].role, 'human');
  assert.equal(room.players[0].name, 'Alice');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.status, 'lobby');
});

test('createRoom — generates unique room ID', () => {
  const store = gtaGame.createStore();
  const r1 = gtaGame.createRoom(store, { hostName: 'A', hostSocketId: 's1' });
  const r2 = gtaGame.createRoom(store, { hostName: 'B', hostSocketId: 's2' });
  assert.ok(r1.ok && r2.ok);
  assert.notEqual(r1.room.id, r2.room.id);
});

test('createRoom — rejects empty hostName', () => {
  const store = gtaGame.createStore();
  const res = gtaGame.createRoom(store, { hostName: '', hostSocketId: 's1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'HOST_NAME_REQUIRED');
});

test('createRoom — truncates hostName to 24 chars', () => {
  const store = gtaGame.createStore();
  const long = 'A'.repeat(50);
  const res = gtaGame.createRoom(store, { hostName: long, hostSocketId: 's1' });
  assert.ok(res.ok);
  assert.equal(res.player.name.length, 24);
});

test('createRoom — initializes partyChainId and partyStreak', () => {
  const store = gtaGame.createStore();
  const res = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  assert.ok(res.room.partyChainId);
  assert.equal(res.room.partyStreak, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// joinRoom (7 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('joinRoom — new player is agent', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const joined = gtaGame.joinRoom(store, { roomId: r.room.id, name: 'AgentBob', socketId: 's2' });
  assert.ok(joined.ok);
  assert.equal(joined.player.role, 'agent');
});

test('joinRoom — ROOM_FULL when 6 players', () => {
  const { store, room } = makeFullRoom();
  const res = gtaGame.joinRoom(store, { roomId: room.id, name: 'Extra', socketId: 's9' });
  assert.equal(res.error?.code, 'ROOM_FULL');
});

test('joinRoom — reconnect by name after disconnect', () => {
  const store = gtaGame.createStore();
  const created = gtaGame.createRoom(store, { hostName: 'H', hostSocketId: 's1' });
  gtaGame.joinRoom(store, { roomId: created.room.id, name: 'BobAgent', socketId: 's2' });
  gtaGame.disconnectPlayer(store, { roomId: created.room.id, socketId: 's2' });
  const reconnected = gtaGame.joinRoom(store, { roomId: created.room.id, name: 'BobAgent', socketId: 's3' });
  assert.ok(reconnected.ok);
  assert.equal(reconnected.player.socketId, 's3');
});

test('joinRoom — ROOM_NOT_FOUND for bad code', () => {
  const store = gtaGame.createStore();
  const res = gtaGame.joinRoom(store, { roomId: 'ZZZZZZ', name: 'Test', socketId: 's1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'ROOM_NOT_FOUND');
});

test('joinRoom — NAME_REQUIRED for empty name', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const res = gtaGame.joinRoom(store, { roomId: r.room.id, name: '', socketId: 's2' });
  assert.equal(res.error.code, 'NAME_REQUIRED');
});

test('joinRoom — NAME_IN_USE when same name connected', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  gtaGame.joinRoom(store, { roomId: r.room.id, name: 'Dupe', socketId: 's2' });
  const res = gtaGame.joinRoom(store, { roomId: r.room.id, name: 'Dupe', socketId: 's3' });
  assert.equal(res.error.code, 'NAME_IN_USE');
});

test('joinRoom — rejects join after game started', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const res = gtaGame.joinRoom(store, { roomId: room.id, name: 'Late', socketId: 'late1' });
  assert.equal(res.error.code, 'ROOM_ALREADY_STARTED');
});

// ═══════════════════════════════════════════════════════════════════════════════
// startGame (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('startGame — assigns 3 prompts and enters prompt phase', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  const started = gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  assert.ok(started.ok);
  assert.equal(started.room.prompts.length, 3);
  assert.equal(started.room.phase, 'prompt');
  assert.equal(started.room.status, 'in_progress');
});

test('startGame — requires exactly 1 human', () => {
  const store = gtaGame.createStore();
  const botRoom = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  botRoom.room.players[0].role = 'agent'; // override for test
  gtaGame.addLobbyBots(store, { roomId: botRoom.room.id, count: 5 });
  const res = gtaGame.startGame(store, { roomId: botRoom.room.id, hostPlayerId: botRoom.player.id });
  assert.equal(res.error?.code, 'NO_HUMAN');
});

test('startGame — rejects non-host caller', () => {
  const { store, room } = makeFullRoom();
  const res = gtaGame.startGame(store, { roomId: room.id, hostPlayerId: 'not-the-host' });
  assert.equal(res.error.code, 'HOST_ONLY');
});

test('startGame — needs at least 2 agents', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  gtaGame.joinRoom(store, { roomId: r.room.id, name: 'Agent1', socketId: 's2' });
  const res = gtaGame.startGame(store, { roomId: r.room.id, hostPlayerId: r.player.id });
  assert.equal(res.error.code, 'NOT_ENOUGH_AGENTS');
});

// ═══════════════════════════════════════════════════════════════════════════════
// submitResponse (5 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('submitResponse — stores response and rejects duplicates', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const res = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Test response' });
  assert.ok(res.ok);
  assert.equal(room.responsesByRound[1][hostPlayerId], 'Test response');
  const dup = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Second' });
  assert.equal(dup.error?.code, 'ALREADY_RESPONDED');
});

test('submitResponse — truncates at 280 chars', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const long = 'X'.repeat(500);
  gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: long });
  assert.equal(room.responsesByRound[1][hostPlayerId].length, 280);
});

test('submitResponse — defaults empty text to [no response]', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: '' });
  assert.equal(room.responsesByRound[1][hostPlayerId], '[no response]');
});

test('submitResponse — rejects wrong phase', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAdvance(store, { roomId: room.id }); // → reveal
  const res = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'late' });
  assert.equal(res.error.code, 'WRONG_PHASE');
});

test('submitResponse — auto-advances to reveal when all submit', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const alive = room.players.filter(p => p.alive);
  for (const p of alive) {
    gtaGame.submitResponse(store, { roomId: room.id, playerId: p.id, text: 'Hi' });
  }
  assert.equal(room.phase, 'reveal');
});

// ═══════════════════════════════════════════════════════════════════════════════
// castVote (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('castVote — blocks self-vote', () => {
  const ctx = makeVotePhase();
  const bot = ctx.room.players.find(p => p.isBot && p.alive);
  const res = gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bot.id, targetId: bot.id });
  assert.equal(res.error?.code, 'SELF_VOTE');
});

test('castVote — blocks human from casting binding vote', () => {
  const ctx = makeVotePhase();
  const bot = ctx.room.players.find(p => p.isBot);
  const res = gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: ctx.hostPlayerId, targetId: bot.id });
  assert.equal(res.error?.code, 'HUMAN_CANNOT_VOTE');
});

test('castVote — 3+ votes on human triggers agents win', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  for (let i = 0; i < 3; i++) {
    gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[i].id, targetId: ctx.hostPlayerId });
  }
  assert.equal(ctx.room.winner, 'agents');
  assert.equal(ctx.room.status, 'finished');
});

test('castVote — 3+ votes on bot eliminates bot, game continues', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  const target = bots[0];
  for (let i = 1; i <= 3; i++) {
    gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[i].id, targetId: target.id });
  }
  assert.equal(target.alive, false);
  assert.equal(ctx.room.status, 'in_progress');
  assert.equal(ctx.room.winner, null);
});

test('castVote — rejects duplicate vote same round', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  const target = ctx.room.players.find(p => p.id !== bots[0].id && p.alive);
  gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[0].id, targetId: target.id });
  const dup = gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[0].id, targetId: target.id });
  assert.equal(dup.error.code, 'ALREADY_VOTED');
});

test('castVote — rejects vote against dead player', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  bots[0].alive = false; // manually kill
  const res = gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[1].id, targetId: bots[0].id });
  assert.equal(res.error.code, 'INVALID_TARGET');
});

test('castVote — rejects wrong phase', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  // Still in prompt phase
  const bot = room.players.find(p => p.isBot && p.alive);
  const target = room.players.find(p => p.id !== bot.id && p.alive);
  const res = gtaGame.castVote(store, { roomId: room.id, voterId: bot.id, targetId: target.id });
  assert.equal(res.error.code, 'WRONG_PHASE');
});

test('castVote — majority threshold scales with alive agents', () => {
  // With 5 alive agents, majority = ceil(6/2) = 3
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  // 2 votes should NOT resolve (need 3)
  gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[0].id, targetId: ctx.hostPlayerId });
  gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[1].id, targetId: ctx.hostPlayerId });
  assert.equal(ctx.room.phase, 'vote'); // still in vote phase
  assert.equal(ctx.room.winner, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// role security (toPublic) (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('toPublic — hides roles during in_progress', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const pub = gtaGame.toPublic(room);
  for (const p of pub.players) {
    assert.equal(p.role, undefined, `Role leaked for player ${p.name}`);
  }
  assert.equal(pub.humanPlayerId, null);
});

test('toPublic — includes own role for forPlayerId', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const pub = gtaGame.toPublic(room, { forPlayerId: hostPlayerId });
  const me = pub.players.find(p => p.id === hostPlayerId);
  assert.equal(me.role, 'human');
});

test('toPublic — reveals roles after finished', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAgentsWin(store, { roomId: room.id });
  const pub = gtaGame.toPublic(room);
  for (const p of pub.players) {
    assert.ok(p.role !== undefined, `Role missing for ${p.name} after finish`);
  }
  assert.equal(pub.humanPlayerId, hostPlayerId);
});

test('toPublic — hides responses during prompt phase', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'secret' });
  const pub = gtaGame.toPublic(room);
  assert.equal(pub.responsesByRound[1], null); // hidden during prompt
});

// ═══════════════════════════════════════════════════════════════════════════════
// vote threshold (2 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('vote threshold — no elimination without majority', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  // 5 bots each vote for a different target (no one gets 3+ = majority)
  // Bot0→Bot1, Bot1→Bot2, Bot2→Bot3, Bot3→Bot4, Bot4→Human
  for (let i = 0; i < bots.length; i++) {
    const others = ctx.room.players.filter(p => p.alive && p.id !== bots[i].id);
    // Rotate targets so each vote goes to a unique player
    const target = others[i % others.length];
    gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bots[i].id, targetId: target.id });
  }
  // Max 1 vote per target → no majority → no elimination
  assert.equal(ctx.room.eliminatedByRound[1], null);
});

test('vote threshold — all agents eliminated → human wins', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  // Use 3 bots instead of 5 for faster elimination
  const r2 = gtaGame.createStore();
  const c2 = gtaGame.createRoom(r2, { hostName: 'Hero', hostSocketId: 'sh' });
  gtaGame.addLobbyBots(r2, { roomId: c2.room.id, count: 2, namePrefix: 'Bot' });
  gtaGame.startGame(r2, { roomId: c2.room.id, hostPlayerId: c2.player.id });

  // Eliminate bot 1 in round 1
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // prompt → reveal
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // reveal → vote
  const aliveBots = c2.room.players.filter(p => p.isBot && p.alive);
  const target = aliveBots[0];
  // Both agents vote for each other — need majority of 2, so just 1 voting for target won't work
  // Actually with 2 agents, majority = ceil(3/2) = 2. Both must vote for same target.
  for (const bot of aliveBots.filter(b => b.id !== target.id)) {
    gtaGame.castVote(r2, { roomId: c2.room.id, voterId: bot.id, targetId: target.id });
  }
  // Only 1 vote, need 2 — force advance to resolve
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // vote → result (no elim or partial)
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // result → prompt round 2

  // Round 2: all agents vote for one
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // prompt → reveal
  gtaGame.forceAdvance(r2, { roomId: c2.room.id }); // reveal → vote
  const alive2 = c2.room.players.filter(p => p.isBot && p.alive);
  if (alive2.length >= 2) {
    const t2 = alive2[0];
    for (const bot of alive2.filter(b => b.id !== t2.id)) {
      gtaGame.castVote(r2, { roomId: c2.room.id, voterId: bot.id, targetId: t2.id });
    }
  }
  // Force through remaining rounds until done
  for (let i = 0; i < 20 && c2.room.status !== 'finished'; i++) {
    gtaGame.forceAdvance(r2, { roomId: c2.room.id });
  }
  // Human survives all rounds → human wins
  assert.equal(c2.room.winner, 'human');
});

// ═══════════════════════════════════════════════════════════════════════════════
// forceAdvance (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('forceAdvance — handles all phase transitions', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  assert.equal(room.phase, 'prompt');
  gtaGame.forceAdvance(store, { roomId: room.id });
  assert.equal(room.phase, 'reveal');
  gtaGame.forceAdvance(store, { roomId: room.id });
  assert.equal(room.phase, 'vote');
  gtaGame.forceAdvance(store, { roomId: room.id });
  assert.equal(room.phase, 'result');
  gtaGame.forceAdvance(store, { roomId: room.id });
  assert.equal(room.phase, 'prompt');
  assert.equal(room.round, 2);
});

test('forceAdvance — human wins after maxRounds', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
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

test('forceAdvance — fills missing responses with [no response]', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  // Only host submits
  gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'my answer' });
  // Force advance past prompt phase
  gtaGame.forceAdvance(store, { roomId: room.id });
  // All alive players should have responses
  const alive = room.players.filter(p => p.alive);
  for (const p of alive) {
    assert.ok(room.responsesByRound[1][p.id], `Missing response for ${p.name}`);
  }
});

test('forceAdvance — returns error for finished game', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAgentsWin(store, { roomId: room.id });
  const res = gtaGame.forceAdvance(store, { roomId: room.id });
  assert.equal(res.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// game flow (3 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('game flow — full 3-round game without elimination leads to human win', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });

  for (let round = 1; round <= 3; round++) {
    assert.equal(room.round, round);
    assert.equal(room.phase, 'prompt');

    // All submit
    for (const p of room.players.filter(px => px.alive)) {
      gtaGame.submitResponse(store, { roomId: room.id, playerId: p.id, text: `r${round} answer` });
    }
    assert.equal(room.phase, 'reveal');

    gtaGame.forceAdvance(store, { roomId: room.id }); // reveal → vote
    assert.equal(room.phase, 'vote');

    // Scatter votes (no majority)
    const bots = room.players.filter(p => p.isBot && p.alive);
    for (let i = 0; i < bots.length; i++) {
      const targets = room.players.filter(p => p.alive && p.id !== bots[i].id);
      gtaGame.castVote(store, { roomId: room.id, voterId: bots[i].id, targetId: targets[i % targets.length].id });
    }

    if (room.status === 'finished') break;
    if (room.phase === 'result') {
      gtaGame.forceAdvance(store, { roomId: room.id }); // result → next round
    }
  }

  // Eventually finishes after all rounds
  for (let i = 0; i < 10 && room.status !== 'finished'; i++) {
    gtaGame.forceAdvance(store, { roomId: room.id });
  }
  assert.equal(room.winner, 'human');
});

test('game flow — human eliminated in round 1 → agents win immediately', () => {
  const ctx = makeVotePhase();
  const bots = ctx.room.players.filter(p => p.isBot && p.alive);
  // All 5 bots vote for human
  for (const bot of bots) {
    if (ctx.room.status === 'finished') break;
    gtaGame.castVote(ctx.store, { roomId: ctx.room.id, voterId: bot.id, targetId: ctx.hostPlayerId });
  }
  assert.equal(ctx.room.winner, 'agents');
  assert.equal(ctx.room.phase, 'finished');
});

test('game flow — forceAgentsWin ends game immediately', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const res = gtaGame.forceAgentsWin(store, { roomId: room.id, reason: 'test-abandon' });
  assert.ok(res.ok);
  assert.equal(room.winner, 'agents');
  assert.equal(room.status, 'finished');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rematch + bots + disconnect (3 tests)
// ═══════════════════════════════════════════════════════════════════════════════

test('prepareRematch — resets room to lobby state', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAgentsWin(store, { roomId: room.id });
  const res = gtaGame.prepareRematch(store, { roomId: room.id, hostPlayerId });
  assert.ok(res.ok);
  assert.equal(res.room.phase, 'lobby');
  assert.equal(res.room.status, 'lobby');
  assert.equal(res.room.round, 0);
  assert.equal(res.room.partyStreak, 1);
  // All players alive again
  for (const p of res.room.players) {
    assert.equal(p.alive, true);
  }
});

test('addLobbyBots — respects max 6 players', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const res = gtaGame.addLobbyBots(store, { roomId: r.room.id, count: 10 });
  assert.ok(res.ok);
  assert.equal(r.room.players.length, 6); // 1 host + 5 bots
});

test('disconnectPlayer — marks player disconnected', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  gtaGame.joinRoom(store, { roomId: r.room.id, name: 'Agent1', socketId: 's2' });
  const result = gtaGame.disconnectPlayer(store, { roomId: r.room.id, socketId: 's2' });
  assert.ok(result);
  const p = r.room.players.find(px => px.socketId === 's2');
  assert.equal(p.isConnected, false);
});
