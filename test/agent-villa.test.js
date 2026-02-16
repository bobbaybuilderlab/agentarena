const test = require('node:test');
const assert = require('node:assert/strict');

const villa = require('../games/agent-villa');

test('agent-villa room create/join/start skeleton', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  assert.equal(created.ok, true);

  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  villa.joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  villa.joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  villa.joinRoom(store, { roomId, name: 'P4', socketId: 's4' });

  const started = villa.startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'in_progress');
  assert.equal(started.room.phase, 'pairing');
  assert.equal(started.room.round, 1);
});

test('agent-villa transitionRoomState rejects lobby -> twist', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host' });
  const bad = villa.transitionRoomState(created.room, 'twist');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'lobby', toPhase: 'twist' });
});

test('agent-villa advances through placeholder round phases in order', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host' });
  const roomId = created.room.id;

  villa.joinRoom(store, { roomId, name: 'P2' });
  villa.joinRoom(store, { roomId, name: 'P3' });
  villa.joinRoom(store, { roomId, name: 'P4' });

  const started = villa.startGame(store, { roomId, hostPlayerId: created.player.id });
  assert.equal(started.ok, true);

  const expectedPhases = ['challenge', 'twist', 'recouple', 'elimination'];
  for (const phase of expectedPhases) {
    const step = villa.advanceRoundPhase(store, { roomId });
    assert.equal(step.ok, true);
    assert.equal(step.room.phase, phase);
  }

  const nextRound = villa.advanceRoundPhase(store, { roomId });
  assert.equal(nextRound.ok, true);
  assert.equal(nextRound.room.phase, 'pairing');
  assert.equal(nextRound.room.round, 2);
});
