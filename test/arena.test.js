const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THEMES,
  createRoom,
  transitionRoomState,
  beginVoting,
  nextTheme,
  finalizeRound,
  addBot,
  generateBotRoast,
} = require('../server');

test('creates room with valid theme and id', () => {
  const room = createRoom({ socketId: 'host-1' });
  assert.equal(room.id.length, 6);
  assert.ok(THEMES.includes(room.theme));
  assert.equal(room.status, 'lobby');
});

test('random theme changes to another theme', () => {
  const room = createRoom({ socketId: 'host-2' });
  const old = room.theme;
  nextTheme(room);
  assert.notEqual(room.theme, old);
});

test('finalizeRound awards winner', () => {
  const room = createRoom({ socketId: 'host-3' });
  room.players = [
    { id: 'a', name: 'A', isConnected: true },
    { id: 'b', name: 'B', isConnected: true },
  ];
  room.round = 1;
  room.maxRounds = 1;
  room.status = 'voting';
  room.roastsByRound[1] = { a: 'line a', b: 'line b' };
  room.votesByRound[1] = { a: 3, b: 1 };
  room.totalVotes = { a: 0, b: 0 };

  finalizeRound(room);

  assert.equal(room.totalVotes.a, 1);
  assert.equal(room.status, 'finished');
  assert.equal(room.lastWinner.name, 'A');
});

test('addBot adds autonomous agent with persona', () => {
  const room = createRoom({ socketId: 'host-4' });
  const bot = addBot(room, { name: 'ChaosBot', persona: { style: 'savage', intensity: 9 } });
  assert.equal(bot.isBot, true);
  assert.equal(bot.type, 'agent');
  assert.equal(room.players.length, 1);
  assert.equal(room.totalVotes[bot.id], 0);
});

test('generateBotRoast returns themed line', () => {
  const text = generateBotRoast('Crypto', 'RugBot', 8);
  assert.ok(text.includes('RugBot'));
  assert.ok(text.length <= 280);
});

test('transitionRoomState rejects invalid transition with structured error', () => {
  const room = createRoom({ socketId: 'host-5' });
  const result = transitionRoomState(room, 'BEGIN_VOTING');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ROOM_TRANSITION');
  assert.equal(result.error.from, 'lobby');
  assert.equal(result.error.event, 'BEGIN_VOTING');
});

test('transitionRoomState rejects unknown event with structured error', () => {
  const room = createRoom({ socketId: 'host-6' });
  const result = transitionRoomState(room, 'TIME_TRAVEL');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNKNOWN_TRANSITION_EVENT');
  assert.equal(result.error.event, 'TIME_TRAVEL');
});

test('beginVoting surfaces structured invalid transition errors', () => {
  const room = createRoom({ socketId: 'host-7' });
  const result = beginVoting(room);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ROOM_TRANSITION');
  assert.equal(room.status, 'lobby');
});
