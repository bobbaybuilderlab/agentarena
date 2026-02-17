const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStore,
  createRoom,
  joinRoom,
  startGame,
  transitionRoomState,
  disconnectPlayer,
} = require('../games/agent-mafia');

test('agent-mafia room create/join/start happy path', () => {
  const store = createStore();

  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  assert.equal(created.ok, true);

  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  const p2 = joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  const p3 = joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  const p4 = joinRoom(store, { roomId, name: 'P4', socketId: 's4' });
  assert.equal(p2.ok && p3.ok && p4.ok, true);

  const started = startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'in_progress');
  assert.equal(started.room.phase, 'night');

  const roles = started.room.players.map((p) => p.role);
  assert.ok(roles.includes('mafia'));
  assert.equal(roles.filter((r) => r === 'town').length >= 1, true);
});

test('agent-mafia start requires host and minimum players', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });

  const tooEarly = startGame(store, { roomId: created.room.id, hostPlayerId: created.player.id });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error.code, 'NOT_ENOUGH_PLAYERS');

  joinRoom(store, { roomId: created.room.id, name: 'P2' });
  joinRoom(store, { roomId: created.room.id, name: 'P3' });
  joinRoom(store, { roomId: created.room.id, name: 'P4' });

  const nonHost = startGame(store, { roomId: created.room.id, hostPlayerId: 'not-host' });
  assert.equal(nonHost.ok, false);
  assert.equal(nonHost.error.code, 'HOST_ONLY');
});

test('agent-mafia transitionRoomState rejects lobby -> voting', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host' });
  const bad = transitionRoomState(created.room, 'voting');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'lobby', toPhase: 'voting' });
});

test('agent-mafia transitionRoomState rejects finished -> night', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host' });
  created.room.phase = 'finished';
  const bad = transitionRoomState(created.room, 'night');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'finished', toPhase: 'night' });
});

test('agent-mafia disconnectPlayer returns whether state changed', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 'host-socket' });

  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'unknown' }), false);
  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), true);
  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), false);
});

test('agent-mafia enforces lobby capacity and avoids duplicate name identities', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const roomId = created.room.id;

  assert.equal(joinRoom(store, { roomId, name: 'P2', socketId: 's2' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P3', socketId: 's3' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P4', socketId: 's4' }).ok, true);

  const full = joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'ROOM_FULL');

  const nameInUse = joinRoom(store, { roomId, name: 'P2', socketId: 's6' });
  assert.equal(nameInUse.ok, false);
  assert.equal(nameInUse.error.code, 'NAME_IN_USE');

  const reclaimed = joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  assert.equal(reclaimed.ok, true);
  assert.equal(created.room.players.filter((p) => p.name === 'P2').length, 1);
});
