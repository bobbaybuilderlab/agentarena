const test = require('node:test');
const assert = require('node:assert/strict');

const { THEMES, createRoom, nextTheme, finalizeRound } = require('../server');

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
