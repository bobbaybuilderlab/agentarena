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

test('gta createRoom — host is human in lobby phase', () => {
  const { room } = makeFullRoom();
  assert.equal(room.players[0].role, 'human');
  assert.equal(room.players[0].name, 'Alice');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.status, 'lobby');
});

test('gta joinRoom — new player is agent', () => {
  const store = gtaGame.createStore();
  const r = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const joined = gtaGame.joinRoom(store, { roomId: r.room.id, name: 'AgentBob', socketId: 's2' });
  assert.ok(joined.ok);
  assert.equal(joined.player.role, 'agent');
});

test('gta joinRoom — ROOM_FULL when 6 players', () => {
  const { store, room } = makeFullRoom();
  const res = gtaGame.joinRoom(store, { roomId: room.id, name: 'Extra', socketId: 's9' });
  assert.equal(res.error?.code, 'ROOM_FULL');
});

test('gta joinRoom — reconnect by name after disconnect', () => {
  const store = gtaGame.createStore();
  const created = gtaGame.createRoom(store, { hostName: 'H', hostSocketId: 's1' });
  gtaGame.joinRoom(store, { roomId: created.room.id, name: 'BobAgent', socketId: 's2' });
  gtaGame.disconnectPlayer(store, { roomId: created.room.id, socketId: 's2' });
  const reconnected = gtaGame.joinRoom(store, { roomId: created.room.id, name: 'BobAgent', socketId: 's3' });
  assert.ok(reconnected.ok);
  assert.equal(reconnected.player.socketId, 's3');
});

test('gta startGame — assigns 3 prompts and enters prompt phase', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  const started = gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  assert.ok(started.ok);
  assert.equal(started.room.prompts.length, 3);
  assert.equal(started.room.phase, 'prompt');
  assert.equal(started.room.status, 'in_progress');
});

test('gta startGame — requires exactly 1 human', () => {
  const store = gtaGame.createStore();
  const botRoom = gtaGame.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  botRoom.room.players[0].role = 'agent'; // override for test
  gtaGame.addLobbyBots(store, { roomId: botRoom.room.id, count: 5 });
  const res = gtaGame.startGame(store, { roomId: botRoom.room.id, hostPlayerId: botRoom.player.id });
  assert.equal(res.error?.code, 'NO_HUMAN');
});

test('gta submitResponse — stores response and rejects duplicates', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const res = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Test response' });
  assert.ok(res.ok);
  assert.equal(room.responsesByRound[1][hostPlayerId], 'Test response');
  const dup = gtaGame.submitResponse(store, { roomId: room.id, playerId: hostPlayerId, text: 'Second' });
  assert.equal(dup.error?.code, 'ALREADY_RESPONDED');
});

test('gta castVote — blocks self-vote', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAdvance(store, { roomId: room.id }); // prompt → reveal
  gtaGame.forceAdvance(store, { roomId: room.id }); // reveal → vote
  const bot = room.players.find(p => p.isBot && p.alive);
  const res = gtaGame.castVote(store, { roomId: room.id, voterId: bot.id, targetId: bot.id });
  assert.equal(res.error?.code, 'SELF_VOTE');
});

test('gta castVote — blocks human from casting binding vote', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAdvance(store, { roomId: room.id });
  gtaGame.forceAdvance(store, { roomId: room.id });
  const res = gtaGame.castVote(store, { roomId: room.id, voterId: hostPlayerId, targetId: room.players.find(p => p.isBot).id });
  assert.equal(res.error?.code, 'HUMAN_CANNOT_VOTE');
});

test('gta castVote — 3+ votes on human triggers agents win', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAdvance(store, { roomId: room.id });
  gtaGame.forceAdvance(store, { roomId: room.id });
  const bots = room.players.filter(p => p.isBot && p.alive);
  for (let i = 0; i < 3; i++) {
    gtaGame.castVote(store, { roomId: room.id, voterId: bots[i].id, targetId: hostPlayerId });
  }
  assert.equal(room.winner, 'agents');
  assert.equal(room.status, 'finished');
});

test('gta castVote — 3+ votes on bot eliminates bot, game continues', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAdvance(store, { roomId: room.id });
  gtaGame.forceAdvance(store, { roomId: room.id });
  const bots = room.players.filter(p => p.isBot && p.alive);
  const target = bots[0];
  for (let i = 1; i <= 3; i++) {
    gtaGame.castVote(store, { roomId: room.id, voterId: bots[i].id, targetId: target.id });
  }
  assert.equal(target.alive, false);
  assert.equal(room.status, 'in_progress');
  assert.equal(room.winner, null);
});

test('gta toPublic — hides roles during in_progress', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const pub = gtaGame.toPublic(room);
  for (const p of pub.players) {
    assert.equal(p.role, undefined, `Role leaked for player ${p.name}`);
  }
  assert.equal(pub.humanPlayerId, null);
});

test('gta toPublic — includes own role for forPlayerId', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  const pub = gtaGame.toPublic(room, { forPlayerId: hostPlayerId });
  const me = pub.players.find(p => p.id === hostPlayerId);
  assert.equal(me.role, 'human');
});

test('gta toPublic — reveals roles after finished', () => {
  const { store, room, hostPlayerId } = makeFullRoom();
  gtaGame.startGame(store, { roomId: room.id, hostPlayerId });
  gtaGame.forceAgentsWin(store, { roomId: room.id });
  const pub = gtaGame.toPublic(room);
  for (const p of pub.players) {
    assert.ok(p.role !== undefined, `Role missing for ${p.name} after finish`);
  }
  assert.equal(pub.humanPlayerId, hostPlayerId);
});

test('gta forceAdvance — handles all phase transitions', () => {
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

test('gta forceAdvance — human wins after maxRounds', () => {
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
